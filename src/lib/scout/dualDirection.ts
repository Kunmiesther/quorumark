/**
 * SCOUT DUAL-DIRECTION EVALUATION — pure, read-only, position-agnostic.
 *
 * Contract: Scout evaluates the LONG and SHORT sides of every symbol
 * independently and emits a per-side score, state, and reason codes. Raw
 * scores are computed BEFORE any position-aware step; open positions may
 * only be attached later as display context via `annotateWithPositionContext`.
 *
 * This module knows nothing about wallets, order intents, execution
 * eligibility, or `paper_positions`. It never imports from `src/lib/paper/`.
 * Consumers that need to place orders go through the paper eligibility gate
 * (`src/lib/paper/dualDirectionGate.ts`).
 */

export type Side = "long" | "short";
export type Timeframe = "M5" | "M15" | "H1" | "H4";
export type SideState = "none" | "watching" | "confirmed" | "weakening" | "invalidated";

export interface TimeframeEvidence {
  /** Timeframe key. */
  tf: Timeframe;
  /**
   * Signed per-timeframe score in [-1, +1]. Positive = bullish, negative =
   * bearish. Zero or null when the timeframe is unavailable/stale/missing.
   */
  score: number | null;
  /** True if the timeframe's most recent closed candle is fresh. */
  fresh: boolean;
  /**
   * True if a required input (candles, EMAs, ATR) is missing so this
   * timeframe cannot contribute either side. Missing-context timeframes
   * count as `insufficient_evidence`, never as bullish or bearish.
   */
  missingContext?: boolean;
  /** Optional reason codes for this timeframe, e.g. `stale_data`, `ema_stack_up`. */
  reasons?: readonly string[];
}

export interface DualThresholds {
  /**
   * Minimum weighted score (in [0, 1]) required to enter the CONFIRMED
   * state on either side. Weighted score = mean of aligned timeframes'
   * absolute scores, weighted by `TF_WEIGHTS`.
   */
  confirmed: number;
  /** Minimum weighted score to enter WATCHING (below → NONE). */
  watching: number;
  /** Minimum number of aligned timeframes required for CONFIRMED. */
  minAlignedTfs: number;
}

export const DEFAULT_THRESHOLDS: DualThresholds = {
  confirmed: 0.4,
  watching: 0.2,
  minAlignedTfs: 3,
};

/**
 * Per-timeframe weights. Longer horizons dominate. Sum need not equal 1;
 * the weighted-score computation normalises by the sum of aligned weights.
 */
export const TF_WEIGHTS: Record<Timeframe, number> = {
  H4: 0.4,
  H1: 0.3,
  M15: 0.2,
  M5: 0.1,
};

export interface SideEvaluation {
  side: Side;
  state: SideState;
  /** Weighted, normalised absolute score in [0, 1] for this side. */
  weightedScore: number;
  /** Timeframes whose signed score aligns with this side, in order. */
  alignedTfs: Timeframe[];
  /** Reason codes assembled from aligned timeframes plus meta-codes. */
  reasonCodes: string[];
  /** True if any contributing timeframe is stale/missing. */
  hasFreshnessGap: boolean;
  /** True if no contributing timeframe supplied evidence at all. */
  insufficientEvidence: boolean;
}

export interface DualEvaluation {
  long: SideEvaluation;
  short: SideEvaluation;
  /** Dominant side, or `balanced` when both are within `BALANCE_EPS`. */
  dominant: Side | "balanced";
}

/** Tolerance below which both sides are treated as balanced (display only). */
export const BALANCE_EPS = 0.05;

function evaluateSide(
  side: Side,
  evidence: readonly TimeframeEvidence[],
  thresholds: DualThresholds,
): SideEvaluation {
  const sign = side === "long" ? 1 : -1;
  const aligned: TimeframeEvidence[] = [];
  const reasons = new Set<string>();
  let hasFreshnessGap = false;
  let anyEvidence = false;

  let numerator = 0;
  let denominator = 0;

  for (const ev of evidence) {
    if (ev.missingContext) {
      reasons.add("insufficient_evidence");
      continue;
    }
    if (ev.score == null || !Number.isFinite(ev.score)) {
      reasons.add("insufficient_evidence");
      continue;
    }
    anyEvidence = true;
    const w = TF_WEIGHTS[ev.tf] ?? 0;
    const signed = ev.score * sign;
    // Only timeframes whose signed score is positive contribute to THIS side.
    if (signed <= 0) continue;
    aligned.push(ev);
    numerator += Math.abs(signed) * w;
    denominator += w;
    if (!ev.fresh) hasFreshnessGap = true;
    for (const r of ev.reasons ?? []) reasons.add(r);
  }

  const weightedScore = denominator > 0 ? numerator / denominator : 0;

  let state: SideState = "none";
  if (aligned.length >= thresholds.minAlignedTfs && weightedScore >= thresholds.confirmed) {
    state = "confirmed";
  } else if (weightedScore >= thresholds.watching && aligned.length > 0) {
    state = "watching";
  }

  if (hasFreshnessGap) reasons.add("stale_data");

  return {
    side,
    state,
    weightedScore,
    alignedTfs: aligned
      .map((e) => e.tf)
      .sort((a, b) => (TF_WEIGHTS[b] - TF_WEIGHTS[a])),
    reasonCodes: [...reasons].sort(),
    hasFreshnessGap,
    insufficientEvidence: !anyEvidence,
  };
}

/**
 * Evaluate both directions independently. Deterministic and pure; identical
 * inputs always produce identical outputs. Callers MUST NOT filter or
 * modify `evidence` based on any open position — pass raw market evidence.
 */
export function evaluateDualDirection(
  evidence: readonly TimeframeEvidence[],
  thresholds: DualThresholds = DEFAULT_THRESHOLDS,
): DualEvaluation {
  const long = evaluateSide("long", evidence, thresholds);
  const short = evaluateSide("short", evidence, thresholds);
  const diff = long.weightedScore - short.weightedScore;
  const dominant: Side | "balanced" =
    Math.abs(diff) < BALANCE_EPS ? "balanced" : diff > 0 ? "long" : "short";
  return { long, short, dominant };
}

/**
 * Attach open-position CONTEXT to a dual evaluation for display only. This
 * MUST NOT change any score, state, or reason code — only decorate the
 * result with the caller-visible position awareness.
 */
export interface PositionContext {
  hasOpenLongLadder: boolean;
  hasOpenShortLadder: boolean;
}

export interface AnnotatedDualEvaluation extends DualEvaluation {
  context: PositionContext;
}

export function annotateWithPositionContext(
  evaluation: DualEvaluation,
  context: PositionContext,
): AnnotatedDualEvaluation {
  // Structural clone so callers cannot mutate the raw evaluation via the
  // annotated one. Scores/state/reason codes are copied byte-for-byte.
  return {
    long: { ...evaluation.long, alignedTfs: [...evaluation.long.alignedTfs], reasonCodes: [...evaluation.long.reasonCodes] },
    short: { ...evaluation.short, alignedTfs: [...evaluation.short.alignedTfs], reasonCodes: [...evaluation.short.reasonCodes] },
    dominant: evaluation.dominant,
    context: { ...context },
  };
}
