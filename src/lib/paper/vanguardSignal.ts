/**
 * VANGUARD — break-and-retest momentum, single decisive entry.
 *
 * Reuses the SAME pivot/break/retest primitives as accumulator (`signal.ts`
 * `evaluate`). Vanguard does not fork the definition of "break" or "retest"
 * — it only differs from accumulator in what it does with a confirmed retest:
 *
 *   - Vanguard  → ONE full-size entry, no ladder, no rungs. Fixed structural
 *                 stop just beyond the retested swing. TP from tp_geometry.
 *   - Accumulator → laddered maker entry (see engine.ts sizeLadder / ladder.ts).
 *
 * Routing (see routing.ts): fresh trend (trend_age <= TREND_FRESH_MAX_CANDLES)
 * arms Vanguard; aged trend arms Accumulator. Guardian coverage + re-entry
 * lockout + HTF promotion apply exactly like other legs.
 *
 * PURE — no I/O, no fetches, no orders. Consumed by the paper engine only.
 * Python live-side mirror is DEBT-08 (see docs/MAINNET_PARITY.md).
 */
import type { Direction, RetestResult, Swing } from "./signal";
import { VANGUARD, TP_GEOMETRY } from "./parityConstants";

export const STOP_BUFFER_FRAC: number = VANGUARD.stop_buffer_frac;
export const MIN_STRUCTURAL_TP_DISTANCE_PCT: number =
  TP_GEOMETRY.min_structural_tp_distance_pct;
export const MIN_TP_TO_STOP_DISTANCE_RATIO: number =
  TP_GEOMETRY.min_tp_to_stop_distance_ratio;

export interface VanguardPlan {
  /** Fill price = the retest candle close. */
  fillPx: number;
  /** Structural stop just beyond the retested swing level. */
  stopLevel: number;
  /** TP satisfying tp_geometry (>= min_tp_to_stop_distance_ratio × stop dist). */
  tpLevel: number;
  /** Absolute risk-per-unit at the fill (|fillPx − stopLevel|). */
  riskPerUnit: number;
}

/**
 * Compute the fixed structural stop for a vanguard entry.
 * Long: stop just BELOW the retested swing low.
 * Short: stop just ABOVE the retested swing high.
 */
export function vanguardStopLevel(direction: Direction, swingLevel: number): number {
  const buf = Math.abs(swingLevel) * STOP_BUFFER_FRAC;
  return direction === "long" ? swingLevel - buf : swingLevel + buf;
}

/**
 * Derive a TP level that satisfies tp_geometry:
 *   distance to TP >= max(min_structural_tp_distance_pct * fill,
 *                          min_tp_to_stop_distance_ratio * distance to stop).
 */
export function vanguardTpLevel(
  direction: Direction, fillPx: number, stopLevel: number,
): number {
  const stopDist = Math.abs(fillPx - stopLevel);
  const minPct = Math.abs(fillPx) * MIN_STRUCTURAL_TP_DISTANCE_PCT;
  const dist = Math.max(stopDist * MIN_TP_TO_STOP_DISTANCE_RATIO, minPct);
  return direction === "long" ? fillPx + dist : fillPx - dist;
}

/**
 * Build the vanguard plan for a confirmed retest. Returns null when the
 * retest is not usable (missing retest_index, or the swing level lies on
 * the wrong side of the fill).
 */
export function planVanguardEntry(
  retest: RetestResult,
  direction: Direction,
  fillPx: number,
): VanguardPlan | null {
  if (retest.state !== "confirmed" || retest.retest_index == null) return null;
  const swing: Swing = retest.break_event.swing;
  // Sanity: the retested pivot must sit on the correct side of the fill so
  // "stop beyond swing" is actually beyond the fill in the losing direction.
  if (direction === "long" && !(swing.level < fillPx)) return null;
  if (direction === "short" && !(swing.level > fillPx)) return null;
  const stopLevel = vanguardStopLevel(direction, swing.level);
  const tpLevel = vanguardTpLevel(direction, fillPx, stopLevel);
  return { fillPx, stopLevel, tpLevel, riskPerUnit: Math.abs(fillPx - stopLevel) };
}
