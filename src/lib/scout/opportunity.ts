/**
 * SCOUT OPPORTUNITY DTO — pure, read-only, no I/O.
 *
 * Consumed by the paper eligibility gate. The opportunity records WHAT
 * Scout observed for a given side at a given tick; it does NOT decide
 * whether the paper engine may execute it. That is the gate's job.
 */
import type { AnnotatedDualEvaluation, Side, SideEvaluation } from "./dualDirection";

export type OpportunityLifecycleState =
  | "none"
  | "watching"
  | "confirmed"
  | "weakening"
  | "invalidated";

export interface ScoutOpportunity {
  symbol: string;
  side: Side;
  state: OpportunityLifecycleState;
  /** Confidence in [0, 1] — copy of the side's weighted score. */
  confidence: number;
  /** True when the underlying evidence is fresh across every aligned timeframe. */
  fresh: boolean;
  /** Timeframes that voted for this side, ordered by weight desc. */
  supportingTimeframes: string[];
  /** Reason codes (sorted, deduped) supporting or qualifying this side. */
  reasonCodes: string[];
  /** ISO timestamp of first detection at any non-`none` state. */
  firstDetectedAt: string | null;
  /** ISO timestamp of the first `confirmed` transition. */
  confirmedAt: string | null;
  /** ISO timestamp of the most recent `weakening` transition. */
  weakenedAt: string | null;
  /** ISO timestamp of the most recent `invalidated` transition. */
  invalidatedAt: string | null;
}

export interface OpportunityHistory {
  firstDetectedAt: string | null;
  confirmedAt: string | null;
  weakenedAt: string | null;
  invalidatedAt: string | null;
}

/**
 * Build a fresh opportunity DTO from a side evaluation. The `history`
 * argument carries the caller-known lifecycle timestamps (persisted in
 * `scout_signal_state.opportunity`). A pure function of its inputs.
 */
export function buildOpportunity(
  symbol: string,
  evaluation: SideEvaluation,
  nowIso: string,
  history: OpportunityHistory,
): ScoutOpportunity {
  const state: OpportunityLifecycleState = evaluation.state;
  const isDetected = state !== "none";
  const isConfirmed = state === "confirmed";
  const isWeakening = state === "weakening";
  const isInvalidated = state === "invalidated";
  return {
    symbol,
    side: evaluation.side,
    state,
    confidence: evaluation.weightedScore,
    fresh: !evaluation.hasFreshnessGap,
    supportingTimeframes: [...evaluation.alignedTfs],
    reasonCodes: [...evaluation.reasonCodes],
    firstDetectedAt: isDetected ? (history.firstDetectedAt ?? nowIso) : history.firstDetectedAt,
    confirmedAt: isConfirmed ? (history.confirmedAt ?? nowIso) : history.confirmedAt,
    weakenedAt: isWeakening ? nowIso : history.weakenedAt,
    invalidatedAt: isInvalidated ? nowIso : history.invalidatedAt,
  };
}

/**
 * Build BOTH opportunities from an annotated evaluation. The position
 * context is intentionally NOT threaded into the DTO — display-layer code
 * reads it separately from `AnnotatedDualEvaluation.context`.
 */
export function buildBothOpportunities(
  symbol: string,
  annotated: AnnotatedDualEvaluation,
  nowIso: string,
  longHistory: OpportunityHistory,
  shortHistory: OpportunityHistory,
): { long: ScoutOpportunity; short: ScoutOpportunity } {
  return {
    long: buildOpportunity(symbol, annotated.long, nowIso, longHistory),
    short: buildOpportunity(symbol, annotated.short, nowIso, shortHistory),
  };
}
