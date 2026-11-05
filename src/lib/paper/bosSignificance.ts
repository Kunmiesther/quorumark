/**
 * BOS SIGNIFICANCE FILTER — shared primitive for every Break-of-Structure
 * consumer in the paper engine.
 *
 * A break is CONFIRMED only when the candle close exceeds the broken swing
 * level by at least `min_displacement_atr × ATR(atr_period)` on the same
 * timeframe. Sub-threshold pokes are noise — no adverse-BOS exit, no BOS
 * entry signal, no HTF BOS state change.
 *
 * Consumers:
 *   - `signal.ts` `detectBreak()`   → 5m entry break + (via 1h candles) HTF BOS
 *   - `pricing.ts` `isAdverseBos()` → 5m guardian adverse-BOS
 *
 * PURE. No I/O. Both paths call one helper so the filter is impossible to
 * skew per consumer.
 */
import { PARITY } from "./parityConstants";

// Local mirror of `Direction` from `./signal` to avoid a static import cycle
// (facade.test.ts asserts no circular deps among sibling paper modules).
// The union MUST stay identical to signal.ts::Direction.
export type Direction = "long" | "short";

export const BOS_SIGNIFICANCE = PARITY.bos_significance;
export const BOS_MIN_DISPLACEMENT_ATR = BOS_SIGNIFICANCE.min_displacement_atr;
export const BOS_SIG_ATR_PERIOD = BOS_SIGNIFICANCE.atr_period;


/**
 * True when `|close - level|` beyond the broken side is at least
 * `BOS_MIN_DISPLACEMENT_ATR × atr`. Non-finite / non-positive atr is treated
 * as "no significance can be computed" → return false so ambiguous states
 * cannot fire an exit or entry.
 */
export function meetsBosSignificance(
  direction: Direction,
  candleClose: number,
  swingLevel: number,
  atr: number | null | undefined,
): boolean {
  if (atr == null || !Number.isFinite(atr) || atr <= 0) return false;
  const displacement = direction === "long"
    ? candleClose - swingLevel   // long break: close ABOVE the high
    : swingLevel - candleClose;  // short break: close BELOW the low
  if (displacement <= 0) return false;
  return displacement >= BOS_MIN_DISPLACEMENT_ATR * atr;
}

/** Per-event telemetry payload for a rejected sub-threshold break. */
export interface BosBelowSignificanceDetail {
  reason: "bos_below_significance";
  direction: Direction;
  close: number;
  level: number;
  displacement: number;
  atr: number;
  threshold: number; // BOS_MIN_DISPLACEMENT_ATR × atr
}

export function bosBelowSignificanceDetail(
  direction: Direction, candleClose: number, swingLevel: number, atr: number,
): BosBelowSignificanceDetail {
  const displacement = direction === "long" ? candleClose - swingLevel : swingLevel - candleClose;
  return {
    reason: "bos_below_significance",
    direction,
    close: candleClose,
    level: swingLevel,
    displacement,
    atr,
    threshold: BOS_MIN_DISPLACEMENT_ATR * atr,
  };
}
