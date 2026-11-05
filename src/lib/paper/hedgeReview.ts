/**
 * HEDGE REVIEW — wires the pure `planHedge` planner into the Phase B
 * open-book review. Scout PROPOSES; ONYX AUTHORIZES; only then may
 * paper execution create the approved action. This module is the
 * "propose" step. It is pure and deterministic.
 *
 * FAIL-CLOSED RULES (all must pass before a hedge is even proposed):
 *   1. Regime must be `opposing_to_open_position`.
 *      Negative PnL alone is NEVER sufficient.
 *   2. The Scout opposing signal must be FRESH on this tick.
 *   3. The account/wallet must have sufficient margin for the
 *      opposing formation (caller computes; we just gate on it).
 *   4. Cooldown/hysteresis: a hedge for this position cannot be
 *      re-proposed for HEDGE_COOLDOWN_MS after the last proposal.
 *   5. Venue capability must have been preflighted by the caller.
 *      `hedgeSupported === null` collapses to `hold_and_flag` inside
 *      planHedge; we surface that as REJECTED here.
 *
 * EXECUTION BOUNDARY:
 *   Paper execution is enabled only after this review passes. This module
 *   never reaches a live broker or exchange; the paper engine reserves the
 *   dedicated Hedge role wallet and creates a simulated position.
 */
import { planHedge, type HedgePlan } from "./hedge";
import type { MarketRegime } from "../scout/regime";
import type { Direction } from "./signal";

/**
 * PAPER-ONLY: this permits simulated Hedge-wallet execution. It does not
 * enable live venue signing or broker execution.
 */
export const HEDGE_EXECUTION_ENABLED = true;
/** Cooldown between hedge proposals for the same position. */
export const HEDGE_COOLDOWN_MS = 30 * 60 * 1000;

export interface HedgeReviewInput {
  positionId: string;
  symbol: string;
  openDirection: Direction;
  regime: MarketRegime;
  /** Venue registry capability — null = unresolved, false = closed-only. */
  hedgeSupported: boolean | null;
  /** Direction Scout is proposing for the opposing setup. */
  proposedDirection: Direction | null;
  /** True when the opposing signal was confirmed on the current tick. */
  freshSignal: boolean;
  /** True when caller confirms free margin covers the opposing formation. */
  hasSufficientMargin: boolean;
  /** Wall-clock ms of the last hedge proposal for this position (null = none). */
  lastProposalAtMs: number | null;
  nowMs: number;
}

export type HedgeReviewOutcome =
  | { status: "not_applicable"; reason: string; positionId: string }
  | { status: "rejected"; reason: string; positionId: string; plan: HedgePlan | null }
  | { status: "proposed"; positionId: string; plan: HedgePlan; execute: boolean };

export function reviewHedgeForOpenPosition(i: HedgeReviewInput): HedgeReviewOutcome {
  if (i.regime !== "opposing_to_open_position") {
    return { status: "not_applicable", reason: "regime_not_opposing", positionId: i.positionId };
  }
  if (!i.proposedDirection || i.proposedDirection === i.openDirection) {
    return { status: "not_applicable", reason: "no_opposing_signal", positionId: i.positionId };
  }
  if (!i.freshSignal) {
    return { status: "rejected", reason: "stale_signal", positionId: i.positionId, plan: null };
  }
  if (!i.hasSufficientMargin) {
    return { status: "rejected", reason: "insufficient_margin", positionId: i.positionId, plan: null };
  }
  if (i.lastProposalAtMs != null && (i.nowMs - i.lastProposalAtMs) < HEDGE_COOLDOWN_MS) {
    return { status: "rejected", reason: "cooldown", positionId: i.positionId, plan: null };
  }
  const plan = planHedge({
    regime: i.regime,
    openDirection: i.openDirection,
    hedgeSupported: i.hedgeSupported,
    proposedDirection: i.proposedDirection,
  });
  if (plan.action === "no_action") {
    return { status: "rejected", reason: "planner_no_action", positionId: i.positionId, plan };
  }
  if (plan.action === "hold_and_flag") {
    return {
      status: "rejected",
      reason: "capability_unresolved_or_inconsistent",
      positionId: i.positionId,
      plan,
    };
  }
  // native_hedge or close_and_reverse
  return {
    status: "proposed",
    positionId: i.positionId,
    plan,
    execute: HEDGE_EXECUTION_ENABLED,
  };
}
