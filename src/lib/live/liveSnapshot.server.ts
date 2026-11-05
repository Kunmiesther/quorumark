/**
 * LIVE POSITION SNAPSHOT — real market evidence for the owner-only live
 * advisory committee.
 *
 * READ-ONLY. Public venue klines plus the already-reconciled `positions` row.
 * No credential is read here, no order is touched, nothing is written.
 *
 * Timeframes: native 5m from the venue, folded into 15m / 1h / 4h with the
 * paper engine's existing aggregators, plus native D/W/M environment frames.
 */
import { publicCouncilCandles } from "@/lib/ai/publicCouncilCandles.server";
import {
  aggregate15m,
  aggregate1h,
  aggregate4h,
  completed15m,
  completed1h,
  completed4h,
} from "@/lib/paper/htfCandles";
import { fetchEnvironmentContext } from "@/lib/paper/environmentFrames";
import type { Candle } from "@/lib/paper/signal";
import { TS, HIGH, LOW, CLOSE } from "@/lib/paper/signal";
import { LIVE_ADVISORY_SCHEMA_VERSION } from "./liveAdvisorySchema";
import {
  marketStructureEvidence,
  positionStructureRead,
  type MarketStructureEvidence,
  type PositionStructureRead,
} from "./marketStructure";

/** 5m bars pulled per evaluation. ApeX caps the klines page at 200 (~16h). */
const FIVE_MIN_LIMIT = 200;
/** A snapshot whose newest 5m close is older than this must not be evaluated. */
export const MAX_LIVE_SNAPSHOT_AGE_MS = 15 * 60_000;

export interface TimeframeSummary {
  bars: number;
  last_close: number;
  change_pct: number | null;
  range_high: number;
  range_low: number;
  sma_fast: number | null;
  sma_slow: number | null;
  trend: "up" | "down" | "flat" | null;
}

export interface LivePositionFacts {
  position_id: string;
  /** Resolved from the position's exchange connection, never guessed by symbol. */
  exchange: string;
  symbol: string;
  direction: "long" | "short";
  size: number;
  entry_price: number;
  mark_price: number | null;
  leverage: number | null;
  liquidation_price: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  opened_at: string;
  open_order_count: number;
}

export interface LiveSnapshot {
  schema_version: typeof LIVE_ADVISORY_SCHEMA_VERSION;
  as_of_ms: number;
  candle_close_ms: number;
  position: LivePositionFacts;
  timeframes: Record<string, TimeframeSummary>;
  structure: Record<string, MarketStructureEvidence>;
  structure_read: PositionStructureRead;
  timeframe_source: Record<string, "native" | "folded_5m">;
  environment: Record<string, unknown>;
  environment_available: boolean;
}

// Native 1h/4h candles carry enough history for a real slow trend read. The
// previous 200-bar 5m window yielded only ~16 hourly and ~3 four-hour bars.
// Cache only inside this server process and only until the next native bucket.
const nativeFrameCache = new Map<string, { bucket: number; value: Promise<Candle[]> }>();

async function nativeFrame(
  exchange: string,
  symbol: string,
  intervalMin: 60 | 240,
  nowMs: number,
): Promise<Candle[]> {
  const key = `${exchange}:${symbol}:${intervalMin}`;
  const bucket = Math.floor(nowMs / (intervalMin * 60_000));
  const prior = nativeFrameCache.get(key);
  if (prior?.bucket === bucket) return prior.value;
  const value = publicCouncilCandles(exchange, symbol, intervalMin, 80);
  nativeFrameCache.set(key, { bucket, value });
  try {
    return await value;
  } catch (error) {
    if (nativeFrameCache.get(key)?.value === value) nativeFrameCache.delete(key);
    throw error;
  }
}

function sma(candles: Candle[], n: number): number | null {
  if (candles.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) sum += candles[i][CLOSE];
  return Number((sum / n).toFixed(8));
}

function summarize(candles: Candle[]): TimeframeSummary | null {
  if (!candles.length) return null;
  const window = candles.slice(-60);
  const last = window[window.length - 1];
  const prev = window.length > 1 ? window[window.length - 2] : null;
  const fast = sma(window, 9);
  const slow = sma(window, 21);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c[HIGH] > high) high = c[HIGH];
    if (c[LOW] < low) low = c[LOW];
  }
  const changePct =
    prev && prev[CLOSE] > 0
      ? Number((((last[CLOSE] - prev[CLOSE]) / prev[CLOSE]) * 100).toFixed(4))
      : null;
  let trend: TimeframeSummary["trend"] = null;
  if (fast != null && slow != null && slow > 0) {
    const spread = ((fast - slow) / slow) * 100;
    trend = spread > 0.05 ? "up" : spread < -0.05 ? "down" : "flat";
  }
  return {
    bars: window.length,
    last_close: last[CLOSE],
    change_pct: changePct,
    range_high: high,
    range_low: low,
    sma_fast: fast,
    sma_slow: slow,
    trend,
  };
}

/**
 * Build one evaluation snapshot. Throws only when the entry-timeframe (5m)
 * feed itself is unusable — the environment block degrades silently.
 */
export async function buildLiveSnapshot(
  facts: LivePositionFacts,
  nowMs: number = Date.now(),
): Promise<LiveSnapshot> {
  const [c5, nativeHour, nativeFourHour] = await Promise.all([
    publicCouncilCandles(facts.exchange, facts.symbol, 5, FIVE_MIN_LIMIT),
    nativeFrame(facts.exchange, facts.symbol, 60, nowMs).catch(() => [] as Candle[]),
    nativeFrame(facts.exchange, facts.symbol, 240, nowMs).catch(() => [] as Candle[]),
  ]);
  if (!c5.length) throw new Error("no completed 5m candles");
  const newest = c5[c5.length - 1];
  const candleCloseMs = newest[TS] + 5 * 60_000;
  if (nowMs - candleCloseMs > MAX_LIVE_SNAPSHOT_AGE_MS) {
    throw new Error("stale 5m market snapshot");
  }

  const timeframes: Record<string, TimeframeSummary> = {};
  const structure: Record<string, MarketStructureEvidence> = {};
  const timeframeSource: LiveSnapshot["timeframe_source"] = {
    "5m": "native",
    "15m": "folded_5m",
    "1h": nativeHour.length >= 21 ? "native" : "folded_5m",
    "4h": nativeFourHour.length >= 21 ? "native" : "folded_5m",
  };
  const s5 = summarize(c5);
  if (s5) timeframes["5m"] = s5;
  const c15 = completed15m(aggregate15m(c5));
  const c1h = nativeHour.length >= 21 ? nativeHour : completed1h(aggregate1h(c5));
  const c4h = nativeFourHour.length >= 21 ? nativeFourHour : completed4h(aggregate4h(c5));
  const s15 = summarize(c15);
  if (s15) timeframes["15m"] = s15;
  const s1h = summarize(c1h);
  if (s1h) timeframes["1h"] = s1h;
  const s4h = summarize(c4h);
  if (s4h) timeframes["4h"] = s4h;
  for (const [timeframe, candles] of [
    ["5m", c5],
    ["15m", c15],
    ["1h", c1h],
    ["4h", c4h],
  ] as const) {
    const evidence = marketStructureEvidence(candles);
    if (evidence) structure[timeframe] = evidence;
  }

  // This reader is ApeX-specific. Do not mislabel its D/W/M data as Aster evidence.
  const env = ["apex_omni", "ApeX Omni"].includes(facts.exchange)
    ? await fetchEnvironmentContext(facts.symbol, nowMs)
    : {
        available: false,
        frames: {},
        unavailable_reason: "VENUE_ENVIRONMENT_FRAMES_NOT_CONNECTED",
      };
  const structureRead = positionStructureRead({
    direction: facts.direction,
    fiveMinute: structure["5m"] ?? null,
    fifteenMinute: structure["15m"] ?? null,
    hourlyTrend: s1h?.trend ?? null,
    fourHourTrend: s4h?.trend ?? null,
  });

  return {
    schema_version: LIVE_ADVISORY_SCHEMA_VERSION,
    as_of_ms: nowMs,
    candle_close_ms: candleCloseMs,
    position: facts,
    timeframes,
    structure,
    structure_read: structureRead,
    timeframe_source: timeframeSource,
    environment: env.available
      ? (env.frames as unknown as Record<string, unknown>)
      : { unavailable_reason: env.unavailable_reason },
    environment_available: env.available,
  };
}
