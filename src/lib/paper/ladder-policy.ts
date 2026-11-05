/**
 * LADDER-AWARE HARD-STOP POLICY (owner-ratified addendum).
 *
 * A laddered strategy deliberately anticipates adverse movement — the
 * pending rungs ARE the planned adverse-price actions. It is therefore a
 * defect for a strategy-level hard stop to close such a position while any
 * planned rung has not yet actually filled.
 *
 * This module encodes that invariant in one place so both the engine and the
 * regression tests use the same predicate. It is pure math + a strategy
 * allow-list; no I/O, no DB, no state.
 *
 * SAFETY OVERRIDES (out of scope here — they remain active at all times and
 *  carry their own precise exit_reason codes):
 *   • kill_switch           — account-wide kill switch
 *   • liquidation           — cross-margin liquidation / maintenance-margin guard
 *   • manual                — explicit user emergency close
 *   • account_guard         — documented account-wide equity guard
 *   • scout_bos             — confirmed Scout break-of-structure via Onyx
 * These NEVER masquerade as "hard_stop".
 */
import { armedHardStopLevel } from "./ladder";
import type { Direction } from "./signal";

/** Contract version persisted with every arm. Bump when arithmetic changes. */
import { LADDER as _L } from "./parityConstants";
export const LADDER_CONTRACT_VERSION = _L.ladder_contract_version;

/**
 * Strategies whose positions are explicitly configured as ladders. Do NOT
 * infer ladder status merely because multiple entries share a symbol —
 * membership in this set is the ONLY authoritative signal.
 */
export const LADDER_STRATEGIES = new Set<string>(_L.ladder_strategies);

export interface LadderPositionShape {
  strategy: string | null | undefined;
  ladder_total_rungs: number | string | null | undefined;
}

/**
 * True iff this position is a laddered/DCA position — the invariant applies.
 * Requires BOTH: strategy in the allow-list AND ladder_total_rungs > 1.
 */
export function isLadderPosition(pos: LadderPositionShape): boolean {
  const strat = String(pos.strategy ?? "").toLowerCase();
  if (!LADDER_STRATEGIES.has(strat)) return false;
  const total = Number(pos.ladder_total_rungs ?? 0);
  return Number.isFinite(total) && total > 1;
}

export interface LadderArmDecision {
  /** Armed strategy hard-stop price, or null when the ladder is not full. */
  armedStopPrice: number | null;
  /** Whether the ladder is fully filled and the stop is now armed. */
  armed: boolean;
  /** Actual deepest-rung fill price used to compute the armed stop. */
  finalRungFillPrice: number | null;
}

/**
 * Compute the armed hard-stop decision for a ladder position. Returns
 * `armed = false, armedStopPrice = null` while any planned rung remains
 * unfilled. Once the actual final rung fills, arms at exactly ±1% of that
 * rung's actual fill price (long: below; short: above).
 *
 * `finalRungFillPrice` MUST be the ACTUAL fill of the deepest rung, never
 * the initial entry, VWAP, or a preplanned price. Pending/rejected rungs
 * do not count as filled.
 */
export function armLadderHardStop(
  direction: Direction,
  filledRungCount: number,
  totalPlannedRungs: number,
  finalRungFillPrice: number | null | undefined,
): LadderArmDecision {
  const armedStopPrice = armedHardStopLevel(
    direction,
    filledRungCount,
    totalPlannedRungs,
    finalRungFillPrice,
  );
  const fillPx = Number(finalRungFillPrice);
  return {
    armedStopPrice,
    armed: armedStopPrice != null,
    finalRungFillPrice: armedStopPrice != null && Number.isFinite(fillPx) ? fillPx : null,
  };
}

/**
 * True iff the current candle's close crosses the armed stop.
 *   long : cl <= armed
 *   short: cl >= armed
 * Uses <=/>= (not strict) so a candle CLOSING exactly on the threshold
 * still fires — matches "at/crossing threshold" in the invariant tests.
 */
export function candleCrossesArmedStop(
  direction: Direction,
  candleClose: number,
  armedStopPrice: number | null,
): boolean {
  if (armedStopPrice == null || !Number.isFinite(armedStopPrice)) return false;
  return direction === "long" ? candleClose <= armedStopPrice : candleClose >= armedStopPrice;
}

/**
 * Build the arming audit payload persisted via paper_add_rung's `armed`
 * sub-object. Only emitted on the completing tick.
 */
export function buildArmingPayload(
  direction: Direction,
  finalRungFillPrice: number,
  nowMs: number,
): {
  armed_at: string;
  final_rung_fill_price: number;
  armed_stop_price: number;
  contract_version: number;
  reason: "ladder_complete";
} {
  const armedStopPrice = direction === "long"
    ? finalRungFillPrice * 0.99
    : finalRungFillPrice * 1.01;
  return {
    armed_at: new Date(nowMs).toISOString(),
    final_rung_fill_price: finalRungFillPrice,
    armed_stop_price: armedStopPrice,
    contract_version: LADDER_CONTRACT_VERSION,
    reason: "ladder_complete",
  };
}
