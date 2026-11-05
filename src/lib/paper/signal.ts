/**
 * FAITHFUL TypeScript port of the SUBSET of `accumulator_signal.py` needed by
 * the paper-fill engine. This is a PURE detection module — no I/O, no fetches,
 * no orders — mirroring the Python source line-for-line where practical.
 *
 * ⚠️ SAFETY: This module can NEVER place a real order. It only reads OHLC
 * arrays and returns detection dataclasses. It is used exclusively by the
 * simulation-only paper engine (`src/lib/paper/engine.ts`), which never calls
 * a signer, execution-broker, or exchange venue.
 *
 * Constants below MUST match `accumulator_signal.py` exactly. If the Python
 * spec changes, mirror the change here.
 */

export type Direction = "long" | "short";

export type Candle = [number, number, number, number, number, number]; // [ts_ms, o, h, l, c, v]

export const TS = 0, OPEN = 1, HIGH = 2, LOW = 3, CLOSE = 4, VOLUME = 5;

import { ACCUMULATOR as _A } from "./parityConstants";
import { meetsBosSignificance } from "./bosSignificance";
export const ATR_PERIOD = _A.atr_period;
export const EMA_PERIOD = _A.ema_period;
export const PIVOT_LEFT = _A.pivot_left;
export const PIVOT_RIGHT = _A.pivot_right;
export const LOOKBACK_CANDLES = _A.lookback_candles;
export const RETEST_WINDOW = _A.retest_window;
export const ZONE_ATR_MULT = _A.zone_atr_mult;

export interface Swing {
  kind: "high" | "low";
  pivot_index: number;
  pivot_ts: number;
  level: number;
  confirm_index: number;
  confirm_ts: number;
}

export interface Zone {
  level: number;
  tolerance: number;
  upper: number;
  lower: number;
  atr: number;
  tick: number;
  atr_index: number;
  assumption: string;
}

export interface BreakEvent {
  direction: Direction;
  swing: Swing;
  break_index: number;
  break_ts: number;
  break_close: number;
  ema_at_break: number;
  zone: Zone;
}

export type RetestState = "confirmed" | "expired_window" | "expired_breach" | "pending";

export interface RetestResult {
  state: RetestState;
  break_event: BreakEvent;
  retest_index: number | null;
  retest_ts: number | null;
  reason: string;
}

export interface EvaluateResult {
  candles: number;
  swings_grouped: Swing[];
  breaks: BreakEvent[];
  retests: RetestResult[];
  entries: RetestResult[];
}

/** True range series. First uses high-low. */
export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hi = c[HIGH], lo = c[LOW];
    if (i === 0) { out.push(hi - lo); continue; }
    const pc = candles[i - 1][CLOSE];
    out.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  return out;
}

/** True Wilder ATR series; atr[i] or null if undefined. */
export function wilderAtrSeries(candles: Candle[], period = ATR_PERIOD): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = Array(n).fill(null);
  if (n < period) return out;
  const tr = trueRanges(candles);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < n; i++) {
    prev = ((period - 1) * prev + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** EMA of closes, SMA-seeded. */
export function emaSeries(candles: Candle[], period = EMA_PERIOD): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = Array(n).fill(null);
  if (n < period) return out;
  const closes = candles.map((c) => c[CLOSE]);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  let prev = seed;
  for (let i = period; i < n; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** S19 five-candle pivots (strict inequality both sides). */
export function findConfirmedSwings(candles: Candle[]): Swing[] {
  const out: Swing[] = [];
  const n = candles.length;
  for (let i = PIVOT_LEFT; i < n - PIVOT_RIGHT; i++) {
    const c = candles[i];
    const hi = c[HIGH], lo = c[LOW];
    const nb = [candles[i - 2], candles[i - 1], candles[i + 1], candles[i + 2]];
    if (nb.every((x) => hi > x[HIGH])) {
      out.push({
        kind: "high", pivot_index: i, pivot_ts: c[TS], level: hi,
        confirm_index: i + PIVOT_RIGHT, confirm_ts: candles[i + PIVOT_RIGHT][TS],
      });
    }
    if (nb.every((x) => lo < x[LOW])) {
      out.push({
        kind: "low", pivot_index: i, pivot_ts: c[TS], level: lo,
        confirm_index: i + PIVOT_RIGHT, confirm_ts: candles[i + PIVOT_RIGHT][TS],
      });
    }
  }
  return out;
}

export function zoneTolerance(atr: number, tick: number): number {
  return Math.max(tick, ZONE_ATR_MULT * atr);
}

export function buildZone(level: number, atr: number, tick: number, atrIndex: number, assumption = ""): Zone {
  const tol = zoneTolerance(atr, tick);
  return {
    level, tolerance: tol, upper: level + tol, lower: level - tol,
    atr, tick, atr_index: atrIndex, assumption,
  };
}

export function groupLiquidityZones(swings: Swing[], atrAt: (number | null)[], tick: number): Swing[] {
  const merged: Swing[] = [];
  for (const kind of ["high", "low"] as const) {
    const group = swings.filter((s) => s.kind === kind).sort((a, b) => a.pivot_index - b.pivot_index);
    const used = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      const s = group[i];
      const atr = s.confirm_index < atrAt.length ? atrAt[s.confirm_index] : null;
      if (atr == null) { merged.push(s); continue; }
      const tol = zoneTolerance(atr, tick);
      const cluster: Swing[] = [s];
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(group[j].level - s.level) <= tol) {
          cluster.push(group[j]);
          used.add(j);
        }
      }
      if (cluster.length === 1) { merged.push(s); continue; }
      const best = kind === "high"
        ? cluster.reduce((a, b) => (a.level >= b.level ? a : b))
        : cluster.reduce((a, b) => (a.level <= b.level ? a : b));
      const latest = cluster.reduce((a, b) => (a.confirm_index >= b.confirm_index ? a : b));
      merged.push({
        kind, pivot_index: best.pivot_index, pivot_ts: best.pivot_ts, level: best.level,
        confirm_index: latest.confirm_index, confirm_ts: latest.confirm_ts,
      });
    }
  }
  merged.sort((a, b) => a.pivot_index - b.pivot_index);
  return merged;
}

function selectSubject(swings: Swing[], direction: Direction, breakIndex: number): Swing | null {
  const kind = direction === "long" ? "high" : "low";
  const floor = breakIndex - LOOKBACK_CANDLES;
  const cands = swings.filter(
    (s) => s.kind === kind && s.confirm_index < breakIndex && s.pivot_index >= floor && s.pivot_index < breakIndex,
  );
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.pivot_index >= b.pivot_index ? a : b));
}

function detectBreak(
  candles: Candle[], direction: Direction, tick: number,
  swings: Swing[], atrAt: (number | null)[], emaAt: (number | null)[], atIndex: number,
): BreakEvent | null {
  const i = atIndex;
  if (i < 0 || i >= candles.length) return null;
  const atr = atrAt[i], ema = emaAt[i];
  if (atr == null || ema == null) return null;
  const subject = selectSubject(swings, direction, i);
  if (!subject) return null;
  const close = candles[i][CLOSE];
  if (direction === "long") {
    if (!(close > subject.level && close > ema)) return null;
  } else {
    if (!(close < subject.level && close < ema)) return null;
  }
  // BOS SIGNIFICANCE FILTER — shared primitive; sub-threshold pokes are
  // noise, not a structural break. Applied here so every consumer of
  // `evaluate()` (entry breaks + htfBos 1h detector) inherits the filter.
  if (!meetsBosSignificance(direction, close, subject.level, atr)) return null;
  const zone = buildZone(subject.level, atr, tick, i, "S26_break_candle_atr");
  return { direction, swing: subject, break_index: i, break_ts: candles[i][TS], break_close: close, ema_at_break: ema, zone };
}

function detectRetest(candles: Candle[], be: BreakEvent, emaAt: (number | null)[]): RetestResult {
  const z = be.zone;
  const start = be.break_index + 1;
  const stop = Math.min(start + RETEST_WINDOW, candles.length);
  for (let j = start; j < stop; j++) {
    const c = candles[j];
    const close = c[CLOSE];
    const ema = emaAt[j];
    if (ema == null) continue;
    if (be.direction === "long") {
      if (close < z.lower) return { state: "expired_breach", break_event: be, retest_index: j, retest_ts: c[TS], reason: "close below lower" };
      const entered = c[LOW] <= z.upper;
      if (entered && close > z.level && close > ema) {
        return { state: "confirmed", break_event: be, retest_index: j, retest_ts: c[TS], reason: "confirmed long retest" };
      }
    } else {
      if (close > z.upper) return { state: "expired_breach", break_event: be, retest_index: j, retest_ts: c[TS], reason: "close above upper" };
      const entered = c[HIGH] >= z.lower;
      if (entered && close < z.level && close < ema) {
        return { state: "confirmed", break_event: be, retest_index: j, retest_ts: c[TS], reason: "confirmed short retest" };
      }
    }
  }
  if (stop - start < RETEST_WINDOW) {
    return { state: "pending", break_event: be, retest_index: null, retest_ts: null, reason: "window not elapsed" };
  }
  return { state: "expired_window", break_event: be, retest_index: null, retest_ts: null, reason: "no retest in window" };
}

export function evaluate(candles: Candle[], direction: Direction, tick: number): EvaluateResult {
  const atrAt = wilderAtrSeries(candles);
  const emaAt = emaSeries(candles);
  const raw = findConfirmedSwings(candles);
  const swings = groupLiquidityZones(raw, atrAt, tick);
  const breaks: BreakEvent[] = [];
  for (let i = 0; i < candles.length; i++) {
    const be = detectBreak(candles, direction, tick, swings, atrAt, emaAt, i);
    if (be) breaks.push(be);
  }
  const retests = breaks.map((be) => detectRetest(candles, be, emaAt));
  const entries = retests.filter((r) => r.state === "confirmed");
  return { candles: candles.length, swings_grouped: swings, breaks, retests, entries };
}

/** Newest-candle eligibility (mirrors entry_eligibility.py). Returns the retest
 * confirmed ON the newest completed candle, or null. Historical confirmations
 * NEVER become new signals. */
export function newlyConfirmedEntry(result: EvaluateResult, candles: Candle[]): RetestResult | null {
  if (!candles.length) return null;
  const newestIndex = candles.length - 1;
  const newestTs = candles[newestIndex][TS];
  for (const r of result.entries) {
    if (r.retest_index === newestIndex && r.retest_ts === newestTs) return r;
  }
  return null;
}

/** All confirmations that landed on candles strictly newer than `sinceTs`,
 * chronologically ascending. Used by the paper engine's tick loop to catch
 * every newly-closed 5m candle (not just the current newest) when the poll
 * cadence and candle cadence don't line up. */
export function confirmedEntriesSince(
  result: EvaluateResult,
  sinceTs: number,
): RetestResult[] {
  const out = result.entries.filter(
    (r) => r.retest_ts != null && (r.retest_ts as number) > sinceTs,
  );
  out.sort((a, b) => (a.retest_ts as number) - (b.retest_ts as number));
  return out;
}

// ─── SCOUT TREND FILTER ────────────────────────────────────────────────────
//
// A minimal, standard "don't trade against the trend" gate for the paper
// engine. Definition (see `computeTrend`):
//   trend = UP    when close > EMA(TREND_EMA_PERIOD) AND EMA is rising over
//                 the last TREND_SLOPE_LOOKBACK candles beyond a small flat
//                 threshold TREND_SLOPE_FLAT_PCT.
//   trend = DOWN  when close < EMA AND EMA is falling by the same threshold.
//   trend = NEUTRAL otherwise (chop / flat EMA / mixed).
//
// Why EMA(100) on 5m: covers ~8h of price action — long enough to smooth
// noise and reject counter-trend spikes, short enough to react to real
// regime shifts on a 5m paper engine. FETCH_LIMIT=198 gives >=98 valid
// EMA values, plenty for the 20-candle slope check.
export const TREND_EMA_PERIOD = 100;
export const TREND_SLOPE_LOOKBACK = 20;
/** Minimum EMA move over the slope window to count as trending (unsigned). */
export const TREND_SLOPE_FLAT_PCT = 0.0015; // 0.15% over 20 candles (~1h40)

export type TrendState = "up" | "down" | "neutral";

export interface TrendInfo {
  state: TrendState;
  /** Latest EMA value used for the classification, or null if warmup. */
  ema: number | null;
  /** Latest close. */
  close: number | null;
  /** EMA slope over the lookback window as fractional change (unsigned by sign). */
  slopePct: number | null;
  /** Which threshold was decisive — surface for logging/debug. */
  reason: string;
}

/**
 * Compute the trend state for a symbol from its 5m candles. Pure — no I/O.
 * Returns NEUTRAL (never throws) whenever there aren't enough candles.
 */
export function computeTrend(
  candles: Candle[],
  period: number = TREND_EMA_PERIOD,
  slopeLookback: number = TREND_SLOPE_LOOKBACK,
  flatPct: number = TREND_SLOPE_FLAT_PCT,
): TrendInfo {
  const n = candles.length;
  if (n < period + slopeLookback) {
    return { state: "neutral", ema: null, close: null, slopePct: null, reason: "warmup" };
  }
  const ema = emaSeries(candles, period);
  const emaNow = ema[n - 1];
  const emaThen = ema[n - 1 - slopeLookback];
  const close = candles[n - 1][CLOSE];
  if (emaNow == null || emaThen == null || emaThen === 0) {
    return { state: "neutral", ema: null, close, slopePct: null, reason: "ema unavailable" };
  }
  const slopePct = (emaNow - emaThen) / emaThen;
  const priceAboveEma = close > emaNow;
  const priceBelowEma = close < emaNow;
  const rising = slopePct > flatPct;
  const falling = slopePct < -flatPct;
  if (priceAboveEma && rising) {
    return { state: "up", ema: emaNow, close, slopePct, reason: "close>ema & ema rising" };
  }
  if (priceBelowEma && falling) {
    return { state: "down", ema: emaNow, close, slopePct, reason: "close<ema & ema falling" };
  }
  return {
    state: "neutral",
    ema: emaNow,
    close,
    slopePct,
    reason:
      Math.abs(slopePct) <= flatPct
        ? "ema slope flat"
        : "price on wrong side of ema",
  };
}

/**
 * Gate: does `direction` align with `trend`?
 *   - UP   -> longs allowed, shorts blocked
 *   - DOWN -> shorts allowed, longs blocked
 *   - NEUTRAL -> depends on `blockOnNeutral` (default false: allow both).
 * Returns true when the entry is allowed.
 */
export function trendAllowsDirection(
  trend: TrendState,
  direction: Direction,
  blockOnNeutral = false,
): boolean {
  if (trend === "up") return direction === "long";
  if (trend === "down") return direction === "short";
  return !blockOnNeutral;
}
