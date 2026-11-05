/**
 * Module 2 — Universe funding rotator.
 *
 * Pure ranking + hysteresis. Given a set of candidate symbols with
 * projected net APRs, return:
 *   - the ordered ranking table (for the "arbiter_ranking" telemetry event)
 *   - the SET of symbols that should be HELD this cycle (top N)
 *   - the rotation plan against a current held-set
 *
 * Ties are broken by symbol string order (deterministic).
 */
import { ARBITER } from "../parityConstants";

export const MAX_CONCURRENT_PAIRS: number = ARBITER.max_concurrent_pairs;
export const ROTATION_HYSTERESIS_PCT: number = ARBITER.rotation_hysteresis_pct;

export interface RankedSymbol {
  symbol: string;
  netApr: number;
  fundingRate: number;
}

export interface RotationPlan {
  ranking: RankedSymbol[];
  target: string[];
  toClose: string[];
  toOpen: string[];
}

function rank(candidates: RankedSymbol[]): RankedSymbol[] {
  return [...candidates].sort((a, b) => {
    if (b.netApr !== a.netApr) return b.netApr - a.netApr;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Compute the rotation plan. `held` is the current set of held pair symbols.
 * A held pair is REPLACED by a challenger only if the challenger's netApr
 * exceeds the held pair's by at least ROTATION_HYSTERESIS_PCT (relative).
 *
 * Deterministic tie-breaking + hysteresis prevents churn on tiny APR wiggle.
 */
export function planRotation(
  candidates: RankedSymbol[],
  held: Array<{ symbol: string; netApr: number }>,
  maxPairs: number = MAX_CONCURRENT_PAIRS,
  hysteresis: number = ROTATION_HYSTERESIS_PCT,
): RotationPlan {
  const ranking = rank(candidates);
  const heldMap = new Map(held.map((h) => [h.symbol, h.netApr]));

  // Start from the currently-held set. For each held pair, check whether a
  // higher-ranked NON-held candidate beats it by the hysteresis margin.
  const target = new Set(heldMap.keys());
  const heldByApr = [...heldMap.entries()].sort((a, b) => a[1] - b[1]); // weakest first

  for (const cand of ranking) {
    if (target.has(cand.symbol)) continue;
    if (target.size < maxPairs) {
      target.add(cand.symbol);
      continue;
    }
    // Full — challenger must beat the weakest held by hysteresis to displace.
    const weakest = heldByApr.find(([sym]) => target.has(sym));
    if (!weakest) break;
    const [weakSym, weakApr] = weakest;
    const threshold = weakApr * (1 + hysteresis);
    if (cand.netApr > threshold) {
      target.delete(weakSym);
      target.add(cand.symbol);
      // Re-sort: refreshed weakest is now recomputed from target ∩ heldMap.
    }
  }

  const toClose = [...heldMap.keys()].filter((s) => !target.has(s));
  const toOpen = [...target].filter((s) => !heldMap.has(s));
  return {
    ranking,
    target: [...target].sort(),
    toClose: toClose.sort(),
    toOpen: toOpen.sort(),
  };
}
