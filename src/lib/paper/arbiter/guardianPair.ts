/**
 * Guardian pair rules — the ONLY guardian behavior that changes for paired
 * positions per the ARBITER v2 spec.
 *
 * Rules:
 *   1. 5m directional BOS DOES NOT apply to a paired position (the pair has
 *      no direction — the legs cancel by construction).
 *   2. Leg-imbalance: if one leg's realized notional drifts from the other
 *      beyond `leg_imbalance_tolerance_frac`, close the pair.
 *   3. Basis safety valve: if |perp − spot| / perp exceeds `max_basis_pct`,
 *      close the pair.
 *   4. Per-leg margin/liquidation buffer: caller-supplied floor per leg.
 *
 * This module returns a pure verdict; the engine issues the close orders.
 */
import type { ArbiterPair, PairExitReason } from "./pair";
import { legImbalanceFrac, basisDivergence, HARVESTER_LEG_IMBALANCE_TOL, HARVESTER_MAX_BASIS_PCT } from "./harvester";

export interface GuardianPairInputs {
  pair: ArbiterPair;
  currentPerpPrice: number;
  currentHedgePrice: number;
  /** Optional per-leg margin buffer verdict; when true, close. */
  legMarginBreached?: boolean;
}

export type GuardianPairVerdict =
  | { close: true; reason: PairExitReason }
  | { close: false }
  | { close: false; note: "directional_bos_ignored_on_pair" };

/**
 * Directional 5m BOS must be filtered OUT for paired positions. Callers that
 * currently dispatch to guardian by (symbol, direction) MUST first check
 * `isPaired(pos)` and, if paired, route through `evaluateGuardianPair`
 * instead of the directional BOS pipeline.
 */
export function evaluateGuardianPair(inp: GuardianPairInputs): GuardianPairVerdict {
  if (inp.legMarginBreached) {
    return { close: true, reason: "arbiter_leg_imbalance" };
  }
  if (legImbalanceFrac(inp.pair) > HARVESTER_LEG_IMBALANCE_TOL) {
    return { close: true, reason: "arbiter_leg_imbalance" };
  }
  if (basisDivergence(inp.currentPerpPrice, inp.currentHedgePrice) > HARVESTER_MAX_BASIS_PCT) {
    return { close: true, reason: "arbiter_basis_stop" };
  }
  return { close: false, note: "directional_bos_ignored_on_pair" };
}
