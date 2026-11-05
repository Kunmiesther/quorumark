/**
 * LIQUIDITY-SWEEP strategy — replaces the RSI-divergence/zone-fakeout Sniper
 * as the neutral-regime leg. Same turtle identity ("Sniper"), new brain.
 *
 * PURE. No I/O. Deterministic. Constants sourced from
 * shared/mainnet_parity_constants.json ("sweep" block).
 *
 * Two entry modes:
 *   A) SWEEP + RETEST — a prior candle sweeps a liquidity level beyond
 *      bos_significance × ATR; within `max_retest_candles`, price returns to
 *      the level and the newest candle is an order-block body (body/range ≥
 *      body_ratio) closing back in the reversal direction.
 *   B) FAKEOUT REJECTION — the newest candle both sweeps the level AND
 *      closes back across it (reclaim-close), same OB body gate.
 *
 * Both modes require:
 *   - ATR floor: atr(14) > sma(atr,14) × min_atr_mult
 *   - RSI band: long → rsi(14) < rsi_long_max; short → rsi(14) > rsi_short_min
 *   - 1h alignment: sweep-low→long only if htf_bos_state != "bearish_bos";
 *                   sweep-high→short only if htf_bos_state != "bullish_bos".
 *
 * Level sources (session-first, swing fallback):
 *   - Prior-day UTC high/low
 *   - Prior session high/low (sessions bucketed at session_hours_utc)
 *   - 5m swing highs/lows within the last swing_lookback candles
 * Equal highs/lows collapse when within tolerance of each other and count as
 * a stronger "equal" source (still returned as a single level).
 *
 * Stop = beyond the swept extreme (natural invalidation).
 * TP    = atr(14) × tp_atr_mult from the confirmation-candle entry price.
 * Rungs = 1 (single decisive entry). No DCA.
 */
import {
  TS, OPEN, HIGH, LOW, CLOSE,
  type Candle,
} from "./signal";
import { PARITY } from "./parityConstants";

const SWEEP = (PARITY as any).sweep as {
  enabled: boolean;
  enable_retest: boolean;
  enable_rejection: boolean;
  max_rungs: number;
  max_retest_candles: number;
  body_ratio: number;
  swing_lookback: number;
  min_atr_mult: number;
  atr_period: number;
  atr_sma_period: number;
  rsi_period: number;
  rsi_long_max: number;
  rsi_short_min: number;
  tp_rr?: number;
  session_hours_utc: number[];
};

const BOS_SIG = (PARITY as any).bos_significance as {
  min_displacement_atr: number;
  atr_period: number;
};

export const SWEEP_MAX_RUNGS = SWEEP.max_rungs;
/**
 * Reward-to-risk multiple for the sweep TP. TP distance = SWEEP_TP_RR × |entry−stop|.
 * Replaces the legacy SWEEP_TP_ATR_MULT×ATR target (owner directive 2026-07-26).
 */
export const SWEEP_TP_RR: number = (SWEEP as unknown as { tp_rr?: number }).tp_rr ?? 2.5;
export const SWEEP_MAX_RETEST_CANDLES = SWEEP.max_retest_candles;
export const SWEEP_BODY_RATIO = SWEEP.body_ratio;
export const SWEEP_SWING_LOOKBACK = SWEEP.swing_lookback;
export const SWEEP_MIN_ATR_MULT = SWEEP.min_atr_mult;
export const SWEEP_RSI_LONG_MAX = SWEEP.rsi_long_max;
export const SWEEP_RSI_SHORT_MIN = SWEEP.rsi_short_min;
export const SWEEP_MIN_DISPLACEMENT_ATR = BOS_SIG.min_displacement_atr;


export type SweepDirection = "long" | "short";
export type SweepMode = "retest" | "rejection";
export type LevelSource = "prior_day" | "session" | "swing" | "equal";

export interface LiquidityLevel {
  price: number;
  kind: "high" | "low";
  source: LevelSource;
  /** Candle index (in the supplied series) at which this level was formed. */
  formedIdx: number;
}

export interface SweepEntry {
  direction: SweepDirection;
  mode: SweepMode;
  /** Confirmation-candle close = entry price (single-shot maker fill model). */
  entry: number;
  /** Beyond the swept extreme + a tick. */
  stop: number;
  sweptLevel: number;
  levelSource: LevelSource;
  atrAtEntry: number;
  /** TP distance = SWEEP_TP_RR × |entry − stop| (2.5:1 reward-to-risk). */
  tpDistance: number;
}

// ─── indicators ─────────────────────────────────────────────────────────────

/** Wilder RSI(period). Returns null until `period` closes are seen. */
export function rsiSeries(candles: Candle[], period = SWEEP.rsi_period): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i][CLOSE] - candles[i - 1][CLOSE];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < n; i++) {
    const d = candles[i][CLOSE] - candles[i - 1][CLOSE];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** Simple moving average of the last `period` finite values ending at idx. */
function sma(values: (number | null)[], idx: number, period: number): number | null {
  if (idx + 1 < period) return null;
  let s = 0, n = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return null;
    s += v; n++;
  }
  return n === period ? s / period : null;
}

// ─── level discovery ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Extract candidate liquidity levels from `candles` (5m series). Includes
 * prior-day hi/lo, prior-session hi/lo (bucketed by SWEEP.session_hours_utc),
 * and recent 5m swing hi/lo within `swing_lookback` candles.
 *
 * Levels are collapsed within `tolerance` (in price) — clusters mark as
 * source="equal" (strongest liquidity).
 */
export function findLiquidityLevels(
  candles: Candle[],
  atrAtNewest: number,
  swingLookback = SWEEP_SWING_LOOKBACK,
): LiquidityLevel[] {
  const n = candles.length;
  if (n === 0) return [];
  const levels: LiquidityLevel[] = [];
  const nowTs = candles[n - 1][TS];
  const nowDay = Math.floor(nowTs / DAY_MS);

  // Prior-day hi/lo
  let pdHi = -Infinity, pdLo = Infinity, pdHiIdx = -1, pdLoIdx = -1;
  for (let i = 0; i < n; i++) {
    if (Math.floor(candles[i][TS] / DAY_MS) === nowDay - 1) {
      if (candles[i][HIGH] > pdHi) { pdHi = candles[i][HIGH]; pdHiIdx = i; }
      if (candles[i][LOW] < pdLo) { pdLo = candles[i][LOW]; pdLoIdx = i; }
    }
  }
  if (pdHiIdx >= 0) levels.push({ price: pdHi, kind: "high", source: "prior_day", formedIdx: pdHiIdx });
  if (pdLoIdx >= 0) levels.push({ price: pdLo, kind: "low", source: "prior_day", formedIdx: pdLoIdx });

  // Prior-session hi/lo (session = one of session_hours_utc buckets today,
  // most recently CLOSED bucket).
  const sessionHours = SWEEP.session_hours_utc.slice().sort((a, b) => a - b);
  // Find the most recent session-boundary ts strictly before nowTs.
  const nowHour = new Date(nowTs).getUTCHours();
  let sessionStartHour = sessionHours[0];
  for (const h of sessionHours) if (h <= nowHour) sessionStartHour = h;
  // Previous session: the one immediately before the current bucket.
  const idxInList = sessionHours.indexOf(sessionStartHour);
  const prevSessionHour = idxInList > 0
    ? sessionHours[idxInList - 1]
    : sessionHours[sessionHours.length - 1];
  const isWrapped = idxInList === 0;
  const dayOfPrev = isWrapped ? nowDay - 1 : nowDay;
  const prevSessionStartTs = dayOfPrev * DAY_MS + prevSessionHour * HOUR_MS;
  // End = start of current bucket boundary.
  const curSessionStartTs = nowDay * DAY_MS + sessionStartHour * HOUR_MS;
  let ssHi = -Infinity, ssLo = Infinity, ssHiIdx = -1, ssLoIdx = -1;
  for (let i = 0; i < n; i++) {
    const t = candles[i][TS];
    if (t >= prevSessionStartTs && t < curSessionStartTs) {
      if (candles[i][HIGH] > ssHi) { ssHi = candles[i][HIGH]; ssHiIdx = i; }
      if (candles[i][LOW] < ssLo) { ssLo = candles[i][LOW]; ssLoIdx = i; }
    }
  }
  if (ssHiIdx >= 0) levels.push({ price: ssHi, kind: "high", source: "session", formedIdx: ssHiIdx });
  if (ssLoIdx >= 0) levels.push({ price: ssLo, kind: "low", source: "session", formedIdx: ssLoIdx });

  // 5m swing hi/lo within swing_lookback candles (exclude newest to avoid
  // self-reference — sweeps target formed structure).
  const from = Math.max(0, n - 1 - swingLookback);
  for (let i = from + 2; i < n - 2; i++) {
    const h = candles[i][HIGH], l = candles[i][LOW];
    const isPivotHi = h > candles[i - 1][HIGH] && h > candles[i - 2][HIGH]
      && h > candles[i + 1][HIGH] && h > candles[i + 2][HIGH];
    const isPivotLo = l < candles[i - 1][LOW] && l < candles[i - 2][LOW]
      && l < candles[i + 1][LOW] && l < candles[i + 2][LOW];
    if (isPivotHi) levels.push({ price: h, kind: "high", source: "swing", formedIdx: i });
    if (isPivotLo) levels.push({ price: l, kind: "low", source: "swing", formedIdx: i });
  }

  // Collapse equal levels within tolerance = 0.10 × ATR.
  const tol = Math.max(1e-12, 0.10 * atrAtNewest);
  const collapsed: LiquidityLevel[] = [];
  const sorted = levels.slice().sort((a, b) => a.price - b.price);
  for (const lv of sorted) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.kind === lv.kind && Math.abs(last.price - lv.price) <= tol) {
      // Merge: mark as equal (strongest), keep the most recent formedIdx.
      last.source = "equal";
      last.formedIdx = Math.max(last.formedIdx, lv.formedIdx);
      last.price = (last.price + lv.price) / 2;
    } else {
      collapsed.push({ ...lv });
    }
  }
  return collapsed;
}

// ─── sweep detection ────────────────────────────────────────────────────────

function bodyRatio(c: Candle): number {
  const range = c[HIGH] - c[LOW];
  if (!(range > 0)) return 0;
  return Math.abs(c[CLOSE] - c[OPEN]) / range;
}

/**
 * Did `swept` sweep `level` significantly (extreme pierces level by at least
 * `minDisplacement`, in price)? Returns "high" if it pierced above (took
 * sell-side liquidity above), "low" if pierced below, or null.
 */
function candleSwept(
  swept: Candle,
  level: LiquidityLevel,
  minDisplacement: number,
): "high" | "low" | null {
  if (level.kind === "high" && swept[HIGH] >= level.price + minDisplacement) return "high";
  if (level.kind === "low" && swept[LOW] <= level.price - minDisplacement) return "low";
  return null;
}

export interface DetectSweepArgs {
  candles: Candle[];
  atr: (number | null)[];
  htfBosState: "bullish_bos" | "bearish_bos" | "none";
  tick: number;
}

export function detectSweep(args: DetectSweepArgs): SweepEntry | null {
  if (!SWEEP.enabled) return null;
  const { candles, atr, htfBosState, tick } = args;
  const n = candles.length;
  if (n < SWEEP.atr_period + SWEEP.rsi_period + 5) return null;

  const newest = candles[n - 1];
  const iN = n - 1;
  const atrNow = atr[iN];
  if (!(atrNow && atrNow > 0)) return null;

  // ATR floor
  const atrSma = sma(atr, iN, SWEEP.atr_sma_period);
  if (atrSma == null) return null;
  if (!(atrNow > atrSma * SWEEP_MIN_ATR_MULT)) return null;

  // RSI
  const rsi = rsiSeries(candles, SWEEP.rsi_period);
  const rsiNow = rsi[iN];
  if (rsiNow == null) return null;

  const minDisplacement = SWEEP_MIN_DISPLACEMENT_ATR * atrNow;
  const levels = findLiquidityLevels(candles, atrNow, SWEEP.swing_lookback);
  if (levels.length === 0) return null;

  // Level priority: session-first (session, prior_day, equal) then swing.
  const priority = (s: LevelSource) => (s === "swing" ? 1 : 0);

  // Body gate on the newest (confirmation) candle.
  const body = bodyRatio(newest);
  if (body < SWEEP_BODY_RATIO) {
    // Body gate applies to both entry modes' confirmation candle.
    // Fall through — retest may still be scanning older sweep candles, but
    // the CONFIRMATION candle is always the newest.
    return null;
  }
  const closesUp = newest[CLOSE] > newest[OPEN];
  const closesDn = newest[CLOSE] < newest[OPEN];

  // Sort levels by priority (session-first) then by proximity to newest close.
  const priceRef = newest[CLOSE];
  const sortedLevels = levels.slice().sort((a, b) => {
    const p = priority(a.source) - priority(b.source);
    if (p !== 0) return p;
    return Math.abs(a.price - priceRef) - Math.abs(b.price - priceRef);
  });

  for (const lv of sortedLevels) {
    // ═══ Mode B: REJECTION (single-candle sweep + reclaim close) ═══
    if (SWEEP.enable_rejection) {
      const swept = candleSwept(newest, lv, minDisplacement);
      if (swept === "low" && newest[CLOSE] > lv.price && closesUp) {
        // sweep-low → long
        if (htfBosState === "bearish_bos") continue;
        if (!(rsiNow < SWEEP_RSI_LONG_MAX)) continue;
        return buildEntry("long", "rejection", newest, lv, atrNow, tick);
      }
      if (swept === "high" && newest[CLOSE] < lv.price && closesDn) {
        // sweep-high → short
        if (htfBosState === "bullish_bos") continue;
        if (!(rsiNow > SWEEP_RSI_SHORT_MIN)) continue;
        return buildEntry("short", "rejection", newest, lv, atrNow, tick);
      }
    }

    // ═══ Mode A: SWEEP + RETEST ═══
    // Look back up to max_retest_candles for a sweep candle. The newest
    // candle must retest the level (touched it) and close back through in
    // the reversal direction with OB body.
    if (SWEEP.enable_retest) {
      const lookFrom = Math.max(0, n - 1 - SWEEP_MAX_RETEST_CANDLES);
      for (let j = n - 2; j >= lookFrom; j--) {
        const sweptDir = candleSwept(candles[j], lv, minDisplacement);
        if (!sweptDir) continue;
        // Ensure between j and n-1 price returned back across the level
        // (retest touch on the newest is required).
        if (sweptDir === "low") {
          const touched = newest[LOW] <= lv.price && newest[CLOSE] > lv.price && closesUp;
          if (!touched) continue;
          if (htfBosState === "bearish_bos") continue;
          if (!(rsiNow < SWEEP_RSI_LONG_MAX)) continue;
          // Stop beyond the ORIGINAL sweep extreme.
          return buildEntry(
            "long", "retest", newest, lv, atrNow, tick,
            candles[j][LOW],
          );
        } else {
          const touched = newest[HIGH] >= lv.price && newest[CLOSE] < lv.price && closesDn;
          if (!touched) continue;
          if (htfBosState === "bullish_bos") continue;
          if (!(rsiNow > SWEEP_RSI_SHORT_MIN)) continue;
          return buildEntry(
            "short", "retest", newest, lv, atrNow, tick,
            candles[j][HIGH],
          );
        }
      }
    }
  }
  return null;
}

function buildEntry(
  direction: SweepDirection,
  mode: SweepMode,
  confirm: Candle,
  level: LiquidityLevel,
  atrNow: number,
  tick: number,
  originalSweepExtreme?: number,
): SweepEntry {
  const entry = confirm[CLOSE];
  const sweptExtreme = originalSweepExtreme != null
    ? originalSweepExtreme
    : (direction === "long" ? confirm[LOW] : confirm[HIGH]);
  const t = tick > 0 ? tick : 0;
  const stop = direction === "long" ? sweptExtreme - t : sweptExtreme + t;
  // TP geometry: 2.5R (owner directive 2026-07-26).
  const risk = Math.abs(entry - stop);
  const tpDistance = SWEEP_TP_RR * risk;
  return {
    direction, mode, entry, stop,
    sweptLevel: level.price, levelSource: level.source,
    atrAtEntry: atrNow, tpDistance,
  };
}

/** TP price for a sweep entry: entry ± SWEEP_TP_RR × |entry − stop| (direction-signed). */
export function sweepTpPrice(entry: number, stop: number, direction: SweepDirection): number {
  const d = SWEEP_TP_RR * Math.abs(entry - stop);
  return direction === "long" ? entry + d : entry - d;
}
