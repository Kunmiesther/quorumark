/**
 * HUNTER strategy — high-volatility Fair-Value-Gap (FVG) DETECTION.
 *
 * FAITHFUL TypeScript port of the detection subset of `hunter_signal.py`,
 * mirroring the pattern of `signal.ts` (which ports `accumulator_signal.py`).
 * PURE: no I/O, no orders, no wallet access. Entry / stop / TP wiring lives in
 * the engine router (a later PR), exactly as the Accumulator's does.
 *
 * Reuses `signal.ts` `wilderAtrSeries` so Hunter's ATR is byte-identical to
 * the Accumulator's and the Scout's — one ATR implementation, no drift. (An
 * earlier audit flagged divergent ATR implementations; this deliberately does
 * not add a third.)
 *
 * Definitions (owner spec, hunter_signal.py):
 *   - Volatility gate: ATR(14) >= K * SMA(ATR(14), 20) at the CONFIRM candle.
 *   - 3-candle FVG at middle index i, CONFIRMED at i+1 (right candle closed):
 *       bullish when candles[i-1].high < candles[i+1].low
 *       bearish when candles[i-1].low  > candles[i+1].high
 *     Gap zone:
 *       bullish -> [candles[i-1].high, candles[i+1].low]
 *       bearish -> [candles[i+1].high, candles[i-1].low]
 *
 * Constants below MUST match `hunter_signal.py` exactly. If either changes,
 * re-verify against a shared reference series.
 */
import { wilderAtrSeries, TS, HIGH, LOW, type Candle } from "./signal";

import { HUNTER as _H } from "./parityConstants";
export const ATR_PERIOD = _H.atr_period;
export const ATR_SMA_PERIOD = _H.atr_sma_period;
export const PIVOT_LEFT = _H.pivot_left;
export const PIVOT_RIGHT = _H.pivot_right;

export type FvgDirection = "bullish" | "bearish";

export interface Fvg {
  direction: FvgDirection;
  /** Middle candle of the 3-candle pattern. */
  middleIndex: number;
  /** Right candle — the pattern is only usable once THIS candle has closed. */
  confirmIndex: number;
  confirmTs: number;
  gapLower: number;
  gapUpper: number;
  atrAtConfirm: number;
  atrSmaAtConfirm: number;
  /** atr / atr_sma at the confirm candle; >= K to pass the gate. */
  ratio: number;
}

export interface HunterSwing {
  kind: "high" | "low";
  index: number;
  level: number;
}

export interface VolatilityStats {
  eligibleCandles: number;
  hotCandles: number;
  hotFraction: number;
}

/**
 * SMA of a (possibly-null) series over `period`. `out[i]` is null until the
 * window `[i-period+1 .. i]` is full and contains no nulls. Mirrors
 * `hunter_signal.sma_of` (window is INCLUSIVE of index i).
 */
export function smaOf(series: (number | null)[], period: number): (number | null)[] {
  const n = series.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i + 1 < period) continue;
    const window = series.slice(i + 1 - period, i + 1);
    if (window.some((x) => x == null)) continue;
    let sum = 0;
    for (const x of window) sum += x as number;
    out[i] = sum / period;
  }
  return out;
}

/**
 * All 3-candle FVGs whose CONFIRM candle (i+1) passes the volatility gate
 * `ratio = ATR(14) / SMA(ATR(14),20) >= kThreshold`. Mirrors
 * `hunter_signal.find_fvgs`. `kThreshold` is supplied by the caller (from the
 * backtest / owner config) — deliberately no baked-in default, so a magic
 * constant is never invented here.
 */
export function findFvgs(candles: Candle[], kThreshold: number): Fvg[] {
  const atr = wilderAtrSeries(candles);
  const atrSma = smaOf(atr, ATR_SMA_PERIOD);
  const out: Fvg[] = [];
  const n = candles.length;
  for (let i = 1; i < n - 1; i++) {
    const confirm = i + 1;
    const a = atr[confirm];
    const s = atrSma[confirm];
    if (a == null || s == null || s <= 0) continue;
    const ratio = a / s;
    if (ratio < kThreshold) continue;
    const cPrev = candles[i - 1];
    const cNext = candles[i + 1];
    // Bullish gap: prior high below next low (unfilled gap up).
    if (cPrev[HIGH] < cNext[LOW]) {
      out.push({
        direction: "bullish",
        middleIndex: i,
        confirmIndex: confirm,
        confirmTs: cNext[TS],
        gapLower: cPrev[HIGH],
        gapUpper: cNext[LOW],
        atrAtConfirm: a,
        atrSmaAtConfirm: s,
        ratio,
      });
    } else if (cPrev[LOW] > cNext[HIGH]) {
      // Bearish gap: prior low above next high (unfilled gap down).
      out.push({
        direction: "bearish",
        middleIndex: i,
        confirmIndex: confirm,
        confirmTs: cNext[TS],
        gapLower: cNext[HIGH],
        gapUpper: cPrev[LOW],
        atrAtConfirm: a,
        atrSmaAtConfirm: s,
        ratio,
      });
    }
  }
  return out;
}

/**
 * Five-candle strict pivots (2 left, 2 right). Highs use strict `>` against
 * all four neighbours, lows strict `<`. Mirrors `hunter_signal.find_swings`.
 */
export function findSwings(candles: Candle[]): HunterSwing[] {
  const out: HunterSwing[] = [];
  const n = candles.length;
  for (let i = PIVOT_LEFT; i < n - PIVOT_RIGHT; i++) {
    const c = candles[i];
    const hi = c[HIGH];
    const lo = c[LOW];
    const nb = [candles[i - 2], candles[i - 1], candles[i + 1], candles[i + 2]];
    if (nb.every((x) => hi > x[HIGH])) out.push({ kind: "high", index: i, level: hi });
    if (nb.every((x) => lo < x[LOW])) out.push({ kind: "low", index: i, level: lo });
  }
  return out;
}

/**
 * How often the volatility gate is open across the series — a sanity check
 * that the filter really gates. Mirrors `hunter_signal.volatility_stats`.
 */
export function volatilityStats(candles: Candle[], kThreshold: number): VolatilityStats {
  const atr = wilderAtrSeries(candles);
  const atrSma = smaOf(atr, ATR_SMA_PERIOD);
  let total = 0;
  let hot = 0;
  for (let i = 0; i < atr.length; i++) {
    const a = atr[i];
    const s = atrSma[i];
    if (a == null || s == null || s <= 0) continue;
    total++;
    if (a / s >= kThreshold) hot++;
  }
  return { eligibleCandles: total, hotCandles: hot, hotFraction: total ? hot / total : 0 };
}
