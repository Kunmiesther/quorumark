/**
 * Deterministic universe ranker.
 *
 * Every eligible symbol is scored on a fixed set of components. Ties are
 * broken by symbol string ascending — same inputs always yield the same
 * ordering. WAIT-direction symbols are ranked (so the UI can display them)
 * but cannot produce entry intents downstream.
 */
import type {
  EligibleSymbol,
  RankedSymbol,
  RankingDirection,
  ScoreComponents,
} from "./types";

/** Signal-side inputs supplied by the caller (from Scout / regime). */
export interface RankingSignalInputs {
  symbol: string;
  regimeScore: number;        // -1..1
  alignmentScore: number;     // 0..1
  readinessScore: number;     // 0..1
  confidenceScore: number;    // 0..1
  volatilityScore: number;    // 0..1  (higher = more actionable, saturates)
  freshnessScore: number;     // 0..1
  direction: RankingDirection;
  signalFresh: boolean;
}

/** Ranking weights v1. Bump RANKING_VERSION when this changes. */
const WEIGHTS = {
  regime: 0.25,
  alignment: 0.15,
  readiness: 0.15,
  confidence: 0.15,
  liquidity: 0.10,
  freshness: 0.10,
  volatility: 0.10,
} as const;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function liquidityScore(volumeUsd: number | null): number {
  if (volumeUsd == null || volumeUsd <= 0) return 0;
  // Log-scale, saturating at $500M/day.
  const norm = Math.log10(volumeUsd) / Math.log10(500_000_000);
  return clamp01(norm);
}

export function scoreOne(
  eligible: EligibleSymbol,
  signal: RankingSignalInputs,
): { raw: number; components: ScoreComponents } {
  const components: ScoreComponents = {
    regime: clamp01(Math.abs(signal.regimeScore)),
    alignment: clamp01(signal.alignmentScore),
    readiness: clamp01(signal.readinessScore),
    confidence: clamp01(signal.confidenceScore),
    liquidity: liquidityScore(eligible.instrument.volume24hUsd),
    freshness: clamp01(signal.freshnessScore),
    volatility: clamp01(signal.volatilityScore),
  };
  const raw =
    components.regime * WEIGHTS.regime +
    components.alignment * WEIGHTS.alignment +
    components.readiness * WEIGHTS.readiness +
    components.confidence * WEIGHTS.confidence +
    components.liquidity * WEIGHTS.liquidity +
    components.freshness * WEIGHTS.freshness +
    components.volatility * WEIGHTS.volatility;
  return { raw, components };
}

export interface RankInputs {
  eligible: EligibleSymbol[];
  signals: Map<string, RankingSignalInputs>;
  /**
   * Hysteresis-adjusted scores keyed by symbol. When present, ranking uses
   * these values instead of `raw` for ordering (raw is still persisted).
   */
  adjustedScores?: Map<string, number>;
  /** Maximum number of symbols to place in bucket='ranked'. */
  topN: number;
}

/**
 * Deterministic ranking pass.
 *   - eligible=false + reasons.length>0 → bucket='rejected'
 *   - eligible=true, no signal          → bucket='eligible'
 *   - eligible=true, signal wait        → bucket='ranked' but direction='wait'
 *   - eligible=true, signal direction   → bucket='ranked', ordered by score
 *   - stable tie-break by symbol ascending
 *   - only the top N ranked slots receive a numeric rank; overflow becomes bucket='eligible'
 */
export function rankUniverse(inputs: RankInputs): RankedSymbol[] {
  const { eligible, signals, adjustedScores, topN } = inputs;
  const scored: RankedSymbol[] = eligible.map((e) => {
    if (!e.eligible) {
      return {
        symbol: e.instrument.symbol,
        bucket: "rejected",
        rank: null,
        rawScore: 0,
        adjustedScore: 0,
        direction: "none",
        components: {
          regime: 0, alignment: 0, readiness: 0, confidence: 0,
          liquidity: 0, freshness: 0, volatility: 0,
        },
        rejectionReasons: e.reasons,
        instrument: e.instrument,
        signalFresh: false,
      };
    }
    const sig = signals.get(e.instrument.symbol);
    if (!sig) {
      return {
        symbol: e.instrument.symbol,
        bucket: "eligible",
        rank: null,
        rawScore: 0,
        adjustedScore: 0,
        direction: "none",
        components: {
          regime: 0, alignment: 0, readiness: 0, confidence: 0,
          liquidity: 0, freshness: 0, volatility: 0,
        },
        rejectionReasons: [],
        instrument: e.instrument,
        signalFresh: false,
      };
    }
    const { raw, components } = scoreOne(e, sig);
    const adjusted = adjustedScores?.get(e.instrument.symbol) ?? raw;
    return {
      symbol: e.instrument.symbol,
      bucket: "ranked",
      rank: null,
      rawScore: raw,
      adjustedScore: adjusted,
      direction: sig.direction,
      components,
      rejectionReasons: [],
      instrument: e.instrument,
      signalFresh: sig.signalFresh,
    };
  });

  const rankable = scored.filter((s) => s.bucket === "ranked");
  rankable.sort((a, b) => {
    if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
    return a.symbol.localeCompare(b.symbol);
  });
  const cap = Math.max(0, Math.floor(topN));
  rankable.forEach((s, i) => {
    if (i < cap) s.rank = i + 1;
    else s.bucket = "eligible";
  });

  scored.sort((a, b) => {
    // Ranked first (by rank), then eligible, then rejected — deterministic.
    const bucketOrder = { ranked: 0, eligible: 1, rejected: 2, watching: 3 };
    const ao = bucketOrder[a.bucket];
    const bo = bucketOrder[b.bucket];
    if (ao !== bo) return ao - bo;
    if (a.rank != null && b.rank != null) return a.rank - b.rank;
    return a.symbol.localeCompare(b.symbol);
  });
  return scored;
}
