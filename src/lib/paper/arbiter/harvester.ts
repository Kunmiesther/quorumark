/**
 * Module 1 — Delta-neutral funding harvester.
 *
 * A harvest = a PAIRED position:
 *   - RECEIVER leg on the perp venue on the funding-receiving side
 *     (positive rate → short receives; negative → long receives)
 *   - HEDGE leg on a SECOND venue, opposite direction, equal notional
 * Net directional delta ≈ 0 by construction. P&L = funding credits
 *   − (round-trip fees on both legs) − basis drift.
 *
 * All decisions here are PURE functions over inputs — the engine
 * (follow-up wiring, DEBT-09) supplies the venue adapters, equity, and
 * a clock, and drives paper-position lifecycle around the return values.
 *
 * ── APR math ─────────────────────────────────────────────────────────────
 * funding_apr = |funding_rate| * (24 / funding_interval_hours) * 365
 * round_trip_fees_frac = (perp.takerFee + spot.takerFee) * 2 / 10_000
 *   (two legs × two sides = 4 taker fills in the naive model)
 * slippage_frac = (perp.slip + spot.slip) * 2 / 10_000
 * amortization: fees + slippage are paid ONCE (open + close). We amortize
 *   over the EXPECTED holding window `assumed_hold_days`, so:
 *   net_apr = funding_apr - (round_trip_fees_frac + slippage_frac) * (365 / assumed_hold_days)
 * Default assumed_hold_days = 1 (one day of harvest to justify the round-trip
 * cost); a shorter hold assumption is a stricter gate.
 */
import type { VenueAdapter } from "../venues";
import type { ArbiterLeg, ArbiterPair } from "./pair";
import type { PairExitReason } from "./pair";
import type { Direction } from "../signal";
import { ARBITER } from "../parityConstants";

export const HARVESTER_MIN_NET_APR: number = ARBITER.min_net_apr;
export const HARVESTER_EXIT_APR: number = ARBITER.exit_apr;
export const HARVESTER_MAX_BASIS_PCT: number = ARBITER.max_basis_pct;
export const HARVESTER_LEG_IMBALANCE_TOL: number = ARBITER.leg_imbalance_tolerance_frac;

export interface AprInputs {
  fundingRate: number;
  fundingIntervalHours: number;
  perpFeeBps: number;
  spotFeeBps: number;
  perpSlipBps: number;
  spotSlipBps: number;
  assumedHoldDays?: number;
}

export interface AprBreakdown {
  fundingApr: number;
  roundTripFeesFrac: number;
  slippageFrac: number;
  amortization: number;
  netApr: number;
}

export function projectNetApr(inp: AprInputs): AprBreakdown {
  const hold = Math.max(inp.assumedHoldDays ?? 1, 1 / 24);
  const intervalsPerYear = (24 / inp.fundingIntervalHours) * 365;
  const fundingApr = Math.abs(inp.fundingRate) * intervalsPerYear;
  const roundTripFeesFrac = ((inp.perpFeeBps + inp.spotFeeBps) * 2) / 10_000;
  const slippageFrac = ((inp.perpSlipBps + inp.spotSlipBps) * 2) / 10_000;
  const amortization = (roundTripFeesFrac + slippageFrac) * (365 / hold);
  const netApr = fundingApr - amortization;
  return { fundingApr, roundTripFeesFrac, slippageFrac, amortization, netApr };
}

export type HarvestBlockReason =
  | "arbiter_disabled"
  | "rate_below_min"
  | "net_apr_below_min"
  | "hedge_venue_missing"
  | "hedge_price_unavailable"
  | "receiver_price_unavailable";

export interface HarvestCandidate {
  symbol: string;
  receiverVenueId: string;
  hedgeVenueId: string;
  direction: Direction;
  fundingRate: number;
  netApr: number;
  breakdown: AprBreakdown;
}

export type HarvestDecision =
  | { open: true; candidate: HarvestCandidate }
  | { open: false; reason: HarvestBlockReason };

export interface EvaluateHarvestInputs {
  symbol: string;
  perp: VenueAdapter;
  hedge: VenueAdapter | null;
  fundingRate: number | null;
  perpPrice: number | null;
  hedgePrice: number | null;
  fundingIntervalHours: number;
  notionalUsd: number;
  assumedHoldDays?: number;
}

/**
 * Deterministic entry gate. Returns a candidate iff:
 *   - arbiter enabled
 *   - |fundingRate| >= min_funding_rate
 *   - hedge venue present and prices available on both legs
 *   - projected net APR (after fees + slippage, amortized) >= min_net_apr
 */
export function evaluateHarvest(inp: EvaluateHarvestInputs): HarvestDecision {
  if (!ARBITER.enabled) return { open: false, reason: "arbiter_disabled" };
  if (inp.fundingRate === null || !Number.isFinite(inp.fundingRate)) {
    return { open: false, reason: "rate_below_min" };
  }
  if (Math.abs(inp.fundingRate) < ARBITER.min_funding_rate) {
    return { open: false, reason: "rate_below_min" };
  }
  if (!inp.hedge) return { open: false, reason: "hedge_venue_missing" };
  if (inp.perpPrice === null) return { open: false, reason: "receiver_price_unavailable" };
  if (inp.hedgePrice === null) return { open: false, reason: "hedge_price_unavailable" };

  const breakdown = projectNetApr({
    fundingRate: inp.fundingRate,
    fundingIntervalHours: inp.fundingIntervalHours,
    perpFeeBps: inp.perp.takerFeeBps,
    spotFeeBps: inp.hedge.takerFeeBps,
    perpSlipBps: inp.perp.estSlippageBps(inp.notionalUsd),
    spotSlipBps: inp.hedge.estSlippageBps(inp.notionalUsd),
    assumedHoldDays: inp.assumedHoldDays,
  });
  if (breakdown.netApr < HARVESTER_MIN_NET_APR) {
    return { open: false, reason: "net_apr_below_min" };
  }

  // Receiving side: positive rate → shorts receive; negative → longs receive.
  const receiverDir: Direction = inp.fundingRate > 0 ? "short" : "long";
  // Hedge is the opposite direction on a second venue. If the hedge venue
  // doesn't support shorts and the receiver is a long, we cannot construct
  // the pair — the engine must choose a shortable hedge venue upstream. We
  // encode this as a decision requirement: caller supplies a hedge that can
  // carry the OPPOSITE side. If the hedge is spot-long-only and receiver is
  // short, the hedge (long) leg is fine. If receiver is long and hedge is
  // spot-only, we still need a short hedge → block.
  const hedgeDir: Direction = receiverDir === "long" ? "short" : "long";
  if (hedgeDir === "short" && !inp.hedge.supportsShort) {
    return { open: false, reason: "hedge_venue_missing" };
  }

  return {
    open: true,
    candidate: {
      symbol: inp.symbol,
      receiverVenueId: inp.perp.venueId,
      hedgeVenueId: inp.hedge.venueId,
      direction: receiverDir,
      fundingRate: inp.fundingRate,
      netApr: breakdown.netApr,
      breakdown,
    },
  };
}

/**
 * Build the pair record from an accepted candidate + resolved prices.
 * Both legs enter at equal USD notional; fees are debited on entry per leg.
 */
export function buildPair(
  candidate: HarvestCandidate,
  perpPrice: number,
  hedgePrice: number,
  perp: VenueAdapter,
  hedge: VenueAdapter,
  notionalUsd: number,
  openedAtMs: number,
  pairId: string,
): ArbiterPair {
  const receiver: ArbiterLeg = {
    venueId: perp.venueId,
    symbol: candidate.symbol,
    direction: candidate.direction,
    notional: notionalUsd,
    entryPrice: perpPrice,
    entryFeesUsd: (notionalUsd * perp.takerFeeBps) / 10_000,
  };
  const hedgeDir: Direction = candidate.direction === "long" ? "short" : "long";
  const hedgeLeg: ArbiterLeg = {
    venueId: hedge.venueId,
    symbol: candidate.symbol,
    direction: hedgeDir,
    notional: notionalUsd,
    entryPrice: hedgePrice,
    entryFeesUsd: (notionalUsd * hedge.takerFeeBps) / 10_000,
  };
  return {
    pairId,
    kind: "funding_harvest",
    symbol: candidate.symbol,
    openedAtMs,
    receiver,
    hedge: hedgeLeg,
    triggerRate: candidate.fundingRate,
    projectedNetApr: candidate.netApr,
  };
}

/**
 * Funding credit accrued on the receiver leg for one funding interval.
 * Positive = credit to us (we are on the receiving side); negative = paid.
 */
export function accrueFundingCredit(pair: ArbiterPair, currentRate: number): number {
  const dirSign = pair.receiver.direction === "long" ? 1 : -1;
  // Same convention as v1 arbiterSignal.fundingCredit: rate>0 with dir=long => negative delta.
  return -currentRate * pair.receiver.notional * dirSign;
}

/**
 * Basis-drift safety valve: |perpPrice - hedgePrice| / perpPrice.
 * When above `max_basis_pct` the pair is force-closed regardless of funding.
 */
export function basisDivergence(perpPrice: number, hedgePrice: number): number {
  if (!Number.isFinite(perpPrice) || perpPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(perpPrice - hedgePrice) / perpPrice;
}

/**
 * Leg-imbalance check: if either leg's realized notional drifts more than
 * `leg_imbalance_tolerance_frac` from the other, the pair is no longer
 * delta-neutral and the guardian rebalances or closes it.
 */
export function legImbalanceFrac(pair: ArbiterPair): number {
  const a = pair.receiver.notional;
  const b = pair.hedge.notional;
  const denom = Math.max(a, b);
  if (denom <= 0) return 0;
  return Math.abs(a - b) / denom;
}

export interface HarvestExitInputs {
  pair: ArbiterPair;
  currentRate: number;
  currentPerpPrice: number;
  currentHedgePrice: number;
  currentNetApr: number;
}

export type HarvestExitVerdict =
  | { exit: true; reason: PairExitReason }
  | { exit: false };

/**
 * Ordered exit checks. Priority is deterministic:
 *   1. leg imbalance (safety)
 *   2. basis stop (safety)
 *   3. funding flip (harvest reversed against us)
 *   4. net APR decay below exit_apr (harvest complete / not worth it)
 */
export function evaluateHarvestExit(inp: HarvestExitInputs): HarvestExitVerdict {
  if (legImbalanceFrac(inp.pair) > HARVESTER_LEG_IMBALANCE_TOL) {
    return { exit: true, reason: "arbiter_leg_imbalance" };
  }
  if (basisDivergence(inp.currentPerpPrice, inp.currentHedgePrice) > HARVESTER_MAX_BASIS_PCT) {
    return { exit: true, reason: "arbiter_basis_stop" };
  }
  const origRate = inp.pair.triggerRate ?? 0;
  if (
    Number.isFinite(origRate) &&
    origRate !== 0 &&
    Number.isFinite(inp.currentRate) &&
    inp.currentRate !== 0 &&
    Math.sign(origRate) !== Math.sign(inp.currentRate)
  ) {
    return { exit: true, reason: "arbiter_funding_flip" };
  }
  if (inp.currentNetApr < HARVESTER_EXIT_APR) {
    return { exit: true, reason: "arbiter_harvest_complete" };
  }
  return { exit: false };
}
