/**
 * Paired-position types shared by harvester, rotator, and spreadArb.
 *
 * A pair links two legs (perp + spot, or venue-A + venue-B) via `pair_id`.
 * The paper engine (follow-up wiring — DEBT-09) will render pairs as a
 * single grouped row in the UI ("ARBITER PAIR · <symbol>"), with each leg
 * expandable. Exit reasons on a pair use the labels enumerated in
 * PAIR_EXIT_REASONS below.
 */
import type { Direction } from "../signal";

export type ArbiterKind = "funding_harvest" | "spread_arb";

export interface ArbiterLeg {
  venueId: string;
  symbol: string;
  direction: Direction;
  notional: number;
  entryPrice: number;
  /** Fees paid on this leg's fill in USD (deterministic from adapter fees). */
  entryFeesUsd: number;
}

export interface ArbiterPair {
  pairId: string;
  kind: ArbiterKind;
  symbol: string;
  openedAtMs: number;
  receiver: ArbiterLeg;
  hedge: ArbiterLeg;
  /** Signed funding rate that triggered a harvest (undefined for spread_arb). */
  triggerRate?: number;
  /** Projected net APR at open time (harvester only). */
  projectedNetApr?: number;
}

export const PAIR_EXIT_REASONS = [
  "arbiter_harvest_complete",
  "arbiter_funding_flip",
  "arbiter_rotated",
  "arbiter_basis_stop",
  "arbiter_leg_imbalance",
  "arbiter_spread_converged",
  "arbiter_spread_timeout",
] as const;
export type PairExitReason = (typeof PAIR_EXIT_REASONS)[number];
