// On-demand single-symbol council evaluation — the "ask the council about a
// ticker" path used by the Telegram bot (and reusable by any future channel).
//
// This is the same read: real candles -> deterministic signal -> entry
// geometry -> three-seat committee, just for ONE symbol requested right now
// instead of the whole venue universe on a 5m cadence. It reuses
// evaluateSnapshot, so a ticker asked twice inside the same candle replays
// the stored opinions instead of re-spending model budget.
//
// AUTHORITY: NONE. Same guarantee as the rest of the committee: no import
// edge to the signer, broker, or any order table. This can only ever return
// an opinion, never place, resize, or close anything.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUniverseAdapter } from "@/lib/universe/adapters/registry";
import { fetchApexKlines } from "@/lib/paper/feed";
import { deriveCycleSignal, type OHLCV } from "@/lib/ai/cycleSignals";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";
import { buildEntryPlan, type EntryPlan } from "@/lib/ai/entryGeometry";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

export type TickerEvaluationFailure =
  | { ok: false; reason: "invalid_symbol" }
  | { ok: false; reason: "unknown_symbol"; symbol: string }
  | { ok: false; reason: "feed_unavailable"; symbol: string }
  | { ok: false; reason: "no_clear_setup"; symbol: string }
  | { ok: false; reason: "entry_geometry_rejected"; symbol: string; detail: string }
  | { ok: false; reason: "evaluation_failed"; symbol: string };

export interface TickerEvaluationSuccess {
  ok: true;
  symbol: string;
  direction: "long" | "short";
  plan: EntryPlan;
  evaluation: CommitteeEvaluationDto;
  trendState: string;
  candleCloseMs: number;
  tickSize: number | null;
  stepSize: number | null;
  maxLeverage: number | null;
}

export type TickerEvaluationResult = TickerEvaluationSuccess | TickerEvaluationFailure;

/** "btc", "BTCUSDT", "eth-usdt" -> "BTC-USDT". Rejects anything not alnum. */
export function normalizeSymbolInput(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned || cleaned.length > 20) return null;
  if (cleaned.endsWith("USDT")) {
    const base = cleaned.slice(0, -4);
    if (!base) return null;
    return `${base}-USDT`;
  }
  return `${cleaned}-USDT`;
}

export async function evaluateTicker(
  admin: SupabaseClient,
  userId: string,
  rawSymbol: string,
): Promise<TickerEvaluationResult> {
  const symbol = normalizeSymbolInput(rawSymbol);
  if (!symbol) return { ok: false, reason: "invalid_symbol" };

  const now = Date.now();
  let instruments: Awaited<ReturnType<ReturnType<typeof getUniverseAdapter>["discover"]>>["instruments"];
  try {
    const universe = await getUniverseAdapter("apex").discover({
      environment: "paper",
      marketType: "paper",
      now,
    });
    instruments = universe.instruments;
  } catch {
    return { ok: false, reason: "feed_unavailable", symbol };
  }

  const instrument = instruments.find((i) => i.symbol === symbol && i.tradable);
  if (!instrument) return { ok: false, reason: "unknown_symbol", symbol };

  let candles;
  try {
    const feed = await fetchApexKlines(symbol, 5, 140, instrument.tickSize ?? undefined);
    candles = feed.candles;
  } catch {
    return { ok: false, reason: "feed_unavailable", symbol };
  }

  const sig = deriveCycleSignal(candles as unknown as OHLCV[], 5 * 60_000);
  if (!sig || !sig.direction) return { ok: false, reason: "no_clear_setup", symbol };

  const atrAbs = (sig.volatilityPct / 100) * sig.lastClose;
  const plan = buildEntryPlan({
    direction: sig.direction,
    lastClose: sig.lastClose,
    candleCloseMs: sig.candleCloseMs,
    atrAbs,
    spreadBps: instrument.spreadBps,
    momentum: sig.momentum,
    structure: sig.structure,
    highs: sig.highs,
    lows: sig.lows,
    closes: sig.closes,
    volumes: sig.volumes,
    tickSize: instrument.tickSize,
  });
  if (plan.rejectReason) {
    return { ok: false, reason: "entry_geometry_rejected", symbol, detail: plan.rejectReason };
  }

  const snapshot: MarketSnapshot = {
    candidate_id: `telegram:${userId}:${symbol}:${sig.direction}:${sig.candleCloseMs}`,
    strategy: "telegram_ondemand",
    symbol,
    timeframe: "5m",
    candle_close_ms: sig.candleCloseMs,
    deterministic: {
      proposed_direction: sig.direction,
      entry: plan.entry,
      entry_zone: plan.entryZone,
      invalidation: plan.stop,
      tp_levels: plan.tpLevels,
      regime: null,
      trend_state: sig.direction === "long" ? "up" : "down",
      trend_slope_pct: null,
      atr_pct: sig.volatilityPct,
      recent_closes: sig.closes.slice(-60),
      recent_highs: sig.highs.slice(-60),
      recent_lows: sig.lows.slice(-60),
      volume_profile: sig.volumes.slice(-60),
    },
  };

  const { evaluateSnapshot } = await import("@/lib/ai/committee/evaluate.server");
  const dto = await evaluateSnapshot(admin, userId, snapshot);
  if (!dto) return { ok: false, reason: "evaluation_failed", symbol };

  return {
    ok: true,
    symbol,
    direction: sig.direction,
    plan,
    evaluation: dto,
    trendState: sig.direction === "long" ? "up" : "down",
    candleCloseMs: sig.candleCloseMs,
    tickSize: instrument.tickSize,
    stepSize: instrument.minQty,
    maxLeverage: instrument.maxLeverage,
  };
}
