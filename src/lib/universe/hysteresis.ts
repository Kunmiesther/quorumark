/**
 * Rank-band hysteresis and cooldown.
 *
 * Prevents symbols from oscillating in and out of the ranked set on small
 * score changes. A symbol must beat its previous adjusted score by
 * `enterBand` to enter 'ranked' from 'eligible', and must drop below its
 * previous score minus `exitBand` to leave 'ranked'. A `cooldownMs` window
 * after a transition suppresses further transitions in either direction.
 *
 * Kept entirely separate from `scout_bias_state`; the two policies serve
 * different purposes and must not couple.
 */
import type { RankedSymbol, RankingBucket } from "./types";

export interface RankHysteresisConfig {
  enterBand: number;   // score delta required to move up
  exitBand: number;    // score delta required to move down
  cooldownMs: number;  // suppress transitions this long after last change
}

export const DEFAULT_HYSTERESIS: RankHysteresisConfig = {
  enterBand: 0.05,
  exitBand: 0.08,
  cooldownMs: 5 * 60_000,
};

export interface PriorRankState {
  symbol: string;
  lastBucket: RankingBucket;
  lastRank: number | null;
  lastAdjustedScore: number;
  cooldownUntil: number | null;
  lastTransitionAt: number | null;
}

export interface HysteresisResult {
  symbol: string;
  finalBucket: RankingBucket;
  finalRank: number | null;
  adjustedScore: number;
  transitioned: boolean;
  cooldownActive: boolean;
}

/**
 * Apply hysteresis to a freshly-ranked set. Returns a per-symbol decision
 * whose bucket / rank the caller should persist. Score is unchanged.
 */
export function applyRankHysteresis(
  ranked: RankedSymbol[],
  prior: Map<string, PriorRankState>,
  now: number,
  cfg: RankHysteresisConfig = DEFAULT_HYSTERESIS,
): HysteresisResult[] {
  return ranked.map((r) => {
    const p = prior.get(r.symbol);
    if (!p) {
      return {
        symbol: r.symbol,
        finalBucket: r.bucket,
        finalRank: r.rank,
        adjustedScore: r.adjustedScore,
        transitioned: r.bucket !== "watching",
        cooldownActive: false,
      };
    }

    const cooldownActive = p.cooldownUntil != null && p.cooldownUntil > now;
    if (cooldownActive) {
      // Freeze at prior bucket; carry the fresh score for the UI but
      // don't change bucket/rank until the cooldown lifts.
      return {
        symbol: r.symbol,
        finalBucket: p.lastBucket,
        finalRank: p.lastRank,
        adjustedScore: r.adjustedScore,
        transitioned: false,
        cooldownActive: true,
      };
    }

    const delta = r.adjustedScore - p.lastAdjustedScore;
    // Moving up requires enterBand; moving down requires exitBand.
    const wantsUp =
      (p.lastBucket === "eligible" && r.bucket === "ranked") ||
      (p.lastBucket === "watching" && r.bucket !== "watching");
    const wantsDown =
      (p.lastBucket === "ranked" && (r.bucket === "eligible" || r.bucket === "rejected")) ||
      (p.lastBucket === "eligible" && r.bucket === "rejected");

    if (wantsUp && delta < cfg.enterBand) {
      return {
        symbol: r.symbol,
        finalBucket: p.lastBucket,
        finalRank: p.lastRank,
        adjustedScore: r.adjustedScore,
        transitioned: false,
        cooldownActive: false,
      };
    }
    if (wantsDown && Math.abs(delta) < cfg.exitBand) {
      return {
        symbol: r.symbol,
        finalBucket: p.lastBucket,
        finalRank: p.lastRank,
        adjustedScore: r.adjustedScore,
        transitioned: false,
        cooldownActive: false,
      };
    }

    return {
      symbol: r.symbol,
      finalBucket: r.bucket,
      finalRank: r.rank,
      adjustedScore: r.adjustedScore,
      transitioned: r.bucket !== p.lastBucket || r.rank !== p.lastRank,
      cooldownActive: false,
    };
  });
}
