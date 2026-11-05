/**
 * Module 5 — Cross-venue price arbitrage (DEX-ready skeleton).
 *
 * Every cycle, for each symbol, compute price divergence between every venue
 * pair in the registry. When |spread| NET of both venues' fees + slippage
 * >= min_net_bps, open a paired trade: buy cheap, sell rich. Close when
 * spread converges below exit_bps or after max_hold_candles.
 *
 * With only ApeX + Kraken/Synthetic today, real fires are rare — expected.
 * The registry gate `spreadArbEligible` disables the module when the only
 * spot venue is Synthetic (mirror by construction → no signal).
 */
import type { VenueAdapter, VenueRegistry } from "../venues";
import { spreadArbEligible } from "../venues";
import { SPREAD_ARB } from "../parityConstants";
import type { ArbiterPair, PairExitReason } from "./pair";

export const SPREAD_ARB_ENABLED: boolean = SPREAD_ARB.enabled;
export const SPREAD_ARB_MIN_NET_BPS: number = SPREAD_ARB.min_net_bps;
export const SPREAD_ARB_EXIT_BPS: number = SPREAD_ARB.exit_bps;
export const SPREAD_ARB_MAX_HOLD: number = SPREAD_ARB.max_hold_candles;

export interface SpreadCandidate {
  symbol: string;
  buyVenueId: string;
  sellVenueId: string;
  buyPrice: number;
  sellPrice: number;
  grossBps: number;
  netBps: number;
}

export interface EvaluateSpreadInputs {
  symbol: string;
  registry: VenueRegistry;
  prices: Map<string, number | null>; // venueId -> price
  notionalUsd: number;
  registryEligible?: boolean;
}

/**
 * For a single symbol, walk all venue pairs and return the best net-of-fees
 * spread candidate that clears the min_net_bps gate. Returns null when the
 * module is disabled, the registry isn't eligible (Synthetic-only), or no
 * pair clears the gate.
 */
export function evaluateSpreadEntry(inp: EvaluateSpreadInputs): SpreadCandidate | null {
  if (!SPREAD_ARB.enabled) return null;
  if (!Number.isFinite(inp.notionalUsd) || inp.notionalUsd <= 0) return null;
  const eligible = inp.registryEligible ?? spreadArbEligible(inp.registry);
  if (!eligible) return null;

  let best: SpreadCandidate | null = null;
  for (const [a, b] of inp.registry.pairs()) {
    const pa = inp.prices.get(a.venueId);
    const pb = inp.prices.get(b.venueId);
    if (pa == null || pb == null || !Number.isFinite(pa) || !Number.isFinite(pb)
      || pa <= 0 || pb <= 0) continue;

    const cheap: VenueAdapter = pa < pb ? a : b;
    const rich: VenueAdapter = pa < pb ? b : a;
    const buyPrice = Math.min(pa, pb);
    const sellPrice = Math.max(pa, pb);

    // We buy on the cheap venue → need long-side support (spot is fine).
    // We sell on the rich venue → need short-side support.
    if (!rich.supportsShort) continue;

    const grossBps = ((sellPrice - buyPrice) / buyPrice) * 10_000;
    const costs = [cheap.takerFeeBps, rich.takerFeeBps,
      cheap.estSlippageBps(inp.notionalUsd), rich.estSlippageBps(inp.notionalUsd)];
    if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) continue;
    // Reserve both entry AND unwind costs on both legs. These are paper
    // estimates, not executable quotes or a live execution authorization.
    const feesBps = 2 * costs.reduce((sum, cost) => sum + cost, 0);
    const netBps = grossBps - feesBps;
    if (netBps < SPREAD_ARB_MIN_NET_BPS) continue;
    if (!best || netBps > best.netBps) {
      best = {
        symbol: inp.symbol,
        buyVenueId: cheap.venueId,
        sellVenueId: rich.venueId,
        buyPrice,
        sellPrice,
        grossBps,
        netBps,
      };
    }
  }
  return best;
}

export interface EvaluateSpreadExitInputs {
  pair: ArbiterPair;
  currentBuyPrice: number;
  currentSellPrice: number;
  candlesHeld: number;
}

export type SpreadExitVerdict =
  | { exit: true; reason: PairExitReason }
  | { exit: false };

export function evaluateSpreadExit(inp: EvaluateSpreadExitInputs): SpreadExitVerdict {
  if (inp.candlesHeld >= SPREAD_ARB_MAX_HOLD) {
    return { exit: true, reason: "arbiter_spread_timeout" };
  }
  if (!Number.isFinite(inp.currentBuyPrice) || !Number.isFinite(inp.currentSellPrice)
    || inp.currentBuyPrice <= 0 || inp.currentSellPrice <= 0) return { exit: false };
  // A spread that crosses zero has also converged; abs() incorrectly held it.
  const currentBps =
    ((inp.currentSellPrice - inp.currentBuyPrice) / inp.currentBuyPrice) * 10_000;
  if (currentBps <= SPREAD_ARB_EXIT_BPS) {
    return { exit: true, reason: "arbiter_spread_converged" };
  }
  return { exit: false };
}
