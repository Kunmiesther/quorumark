/**
 * Accumulator (DCA) leg — v1 helpers.
 *
 * Down-averaging strategy that shares the Arbiter's break-and-retest ENTRY
 * detector but manages the trade with:
 *   - CONSTANT-MARGIN rungs (each new rung uses the same margin as rung #1).
 *   - RE-ANCHORED average entry (VWAP of all filled rungs) via dca.ts.
 *   - TRAILING STOP armed only AFTER the first rebalance (per STRATEGY_SPEC_v1).
 *
 * v1 SHIP (this file):
 *   - Bounded to MAX_RUNGS rungs total.
 *   - Single full-close take-profit at TP1 = 200% margin ROI on the current
 *     re-anchored average entry (via dca.tp1Target). No partial ladder yet.
 *   - Rung-add gate: new confirmed 5m retest whose retest price is BEYOND
 *     the last resize/retest level (below for long, above for short).
 *   - Reuses the pure math in `./dca.ts` — nothing about the exit formulas
 *     is re-implemented here.
 *
 * v2 (deferred, tracked): unbounded rungs and the 3-tier PARTIAL ladder
 *   (TP1 sell-half, TP2 sell-half-of-remainder, TP3 full close on the FROZEN
 *   first-fill VWAP). Requires partial-reduce plumbing in the engine.
 *
 * PURE — no I/O. The engine calls these; they do not import Supabase.
 */
import type { Direction } from "./signal";
import { reanchoredAverage, tp1Target, stopTriggered as dcaStopTriggered } from "./dca";

/** Hard rung cap. Matches the 4-rung DCA ladder in ladder.ts. */
export const MAX_RUNGS = 4;

export interface Fill { price: number; qty: number }

/** True when a new confirmed retest at `retestPrice` sits BEYOND the most
 *  recent resize/retest level in the direction of the DCA position — i.e.
 *  we're being carried against and want to average in. Returns false if
 *  there is no prior level (defensive; caller shouldn't gate v1 rungs
 *  without at least the entry level in `resizeLevels`). */
export function retestExtendsAgainst(
  direction: Direction,
  retestPrice: number,
  resizeLevels: readonly number[],
): boolean {
  if (resizeLevels.length === 0) return false;
  const last = resizeLevels[resizeLevels.length - 1];
  return direction === "long" ? retestPrice < last : retestPrice > last;
}

/** May we add another rung? Gate combines the count cap + the "new retest
 *  is beyond the last level" rule from the spec. Prior-rung-filled is
 *  implicit in v1 (rungs are inserted synchronously after fills). */
export function canAddRung(
  direction: Direction,
  rungCount: number,
  retestPrice: number,
  resizeLevels: readonly number[],
): boolean {
  if (rungCount >= MAX_RUNGS) return false;
  return retestExtendsAgainst(direction, retestPrice, resizeLevels);
}

/** Sum the notional across an ordered list of fills. */
export function totalQty(fills: readonly Fill[]): number {
  return fills.reduce((s, f) => s + f.qty, 0);
}

/** Compute the DCA position state AFTER adding one rung. Pure. Throws
 *  (via reanchoredAverage) on invalid inputs. */
export function addRung(
  prevFills: readonly Fill[],
  newFill: Fill,
): { fills: Fill[]; avgEntry: number; totalQty: number } {
  const fills = [...prevFills, newFill];
  const avgEntry = reanchoredAverage(fills);
  return { fills, avgEntry, totalQty: totalQty(fills) };
}

/** Compute the v1 TP price (full-close): TP1 basis on the current
 *  re-anchored average entry. */
export function dcaTakeProfitPrice(
  avgEntry: number, direction: Direction, leverage: number,
): number {
  return tp1Target(avgEntry, direction, leverage);
}

/** Trailing-stop trigger — armed only after the first rebalance. Delegates
 *  to dca.ts so there is exactly one source of truth for the stop rule. */
export function dcaStopHit(
  completedClose: number,
  rungCount: number,
  resizeLevels: readonly number[],
  direction: Direction,
): boolean {
  return dcaStopTriggered(completedClose, rungCount - 1, resizeLevels, direction);
  // rung_count includes the initial fill; the spec says "first rebalance"
  // means the FIRST resize fill, which is rungCount >= 2. dca.trailingStop-
  // Active(rebalanceCount) uses rebalanceCount = (rungCount - 1).
}
