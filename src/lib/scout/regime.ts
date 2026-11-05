/**
 * MARKET REGIME CLASSIFIER — Scout intelligence-plane regime (P1).
 *
 * READ-ONLY MODULE. See `scout-no-execution-imports.test.ts`.
 *
 * Purpose: produce a single, typed classification of "what kind of market is
 * this symbol in right now?" that ONYX can consume to select FORMATION
 * (precision / staged / adaptive-DCA / wait / hedge-evaluation). This is the
 * Scout intelligence-plane regime — distinct from `src/lib/paper/regime.ts`
 * which is a candle-derived 3-class strategy router used inside the paper
 * engine.
 *
 * DETERMINISTIC AND VERSIONED. Every input is already-computed evidence from
 * this scan: `ConsensusResult` (bias/readiness/confidence/conflict/weighted
 * score/availability), the persisted `scout_signal_state` transition, and
 * the fleet context breadth. No new indicators, no unversioned thresholds.
 * All thresholds live in `REGIME_CONFIG_V1` below, tagged by
 * `REGIME_SCHEMA_VERSION` so persisted rows can be replayed coherently.
 *
 * SEVEN CATEGORIES (business rule from the strategy addendum):
 *   1. strong_uptrend                 — confirmed long trend
 *   2. strong_downtrend               — confirmed short trend
 *   3. developing_trend               — moderate / building trend, either dir
 *   4. ranging                        — no directional edge, balanced
 *   5. volatile                       — high conflict / MTF disagreement
 *   6. reversal_forming               — prior direction just invalidated
 *   7. opposing_to_open_position      — confirmed opposing trend vs. an OPEN
 *                                       position; only emitted when caller
 *                                       supplies `openPositionDirection`.
 *   + unknown                          — insufficient evidence (fail-safe)
 *
 * FAIL-SAFE: any missing/stale required input → `unknown` with an explanatory
 * reason code. Never invent evidence.
 */

import type { ConsensusResult, ScoutHealth } from "./types";
import type { SignalState } from "./state";
import type { EvidenceDirection } from "./evidence";

// ─── Versioning ────────────────────────────────────────────────────────────
/**
 * Bump when the regime output SHAPE or the classification RULES change.
 * Persisted with every regime row so replay stays coherent.
 */
export const REGIME_SCHEMA_VERSION = 1 as const;

// ─── Types ─────────────────────────────────────────────────────────────────
export type MarketRegime =
  | "strong_uptrend"
  | "strong_downtrend"
  | "developing_trend"
  | "ranging"
  | "volatile"
  | "reversal_forming"
  | "opposing_to_open_position"
  | "unknown";

export type RegimeReasonCode =
  | "confirmed_long_alignment"
  | "confirmed_short_alignment"
  | "armed_long_alignment"
  | "armed_short_alignment"
  | "building_directional"
  | "balanced_low_score"
  | "mtf_conflict_high"
  | "state_invalidated"
  | "htf_flipped_prior_direction"
  | "opposing_confirmed_vs_open_long"
  | "opposing_confirmed_vs_open_short"
  | "insufficient_data"
  | "htf_stale_or_missing"
  | "signal_state_missing";

export interface RegimeConfigV1 {
  /** Confidence floor to call a trend "strong". */
  strongConfidenceMin: number;
  /** Maximum tolerated MTF conflict for a "strong" call. */
  strongConflictMax: number;
  /** |weighted_score| floor for a "strong" call. */
  strongScoreMagnitudeMin: number;
  /** Conflict threshold above which we call the tape volatile. */
  volatileConflictMin: number;
  /** |weighted_score| below which balanced/no-signal maps to ranging. */
  rangingScoreMagnitudeMax: number;
  /** Availability floor — below this we return `unknown`. */
  minAvailability: number;
  /** Confidence floor for the opposing-to-open-position emit. */
  opposingConfidenceMin: number;
}

/**
 * Named, documented alias set for the thresholds this classifier uses. All
 * thresholds are derived from existing Scout signals — nothing new was
 * introduced beyond what the consensus/state modules already emit. They live
 * here (not in `versions.ts`) so tuning them requires bumping
 * `REGIME_SCHEMA_VERSION`, which every persisted row records.
 */
export const REGIME_CONFIG_V1: RegimeConfigV1 = {
  strongConfidenceMin: 0.55,
  strongConflictMax: 0.35,
  strongScoreMagnitudeMin: 0.45,
  volatileConflictMin: 0.55,
  rangingScoreMagnitudeMax: 0.20,
  minAvailability: 0.4,
  opposingConfidenceMin: 0.45,
};

export interface RegimeInput {
  consensus: ConsensusResult;
  /**
   * Direction chosen by the state reducer (long/short/none). Together with
   * `signalState` it distinguishes "confirmed" from "building".
   */
  signalDirection: EvidenceDirection;
  signalState: SignalState | null;
  /** Reason codes attached to the current signal state (e.g. `invalidated_*`). */
  stateReasonCodes: readonly string[];
  /** True if H4 + D evidence are fresh + present. */
  htfValid: boolean;
  /** Fleet health — offline/stale → `unknown`. */
  health: ScoutHealth;
  /**
   * If the caller already has an OPEN paper/live position on this symbol,
   * pass its direction. Enables category 7 (opposing_to_open_position). When
   * omitted, the classifier ignores the "opposing to open" rule.
   */
  openPositionDirection?: EvidenceDirection | null;
}

export interface RegimeEvidence {
  regime: MarketRegime;
  confidence: number;
  weightedScore: number;
  conflict: number;
  availability: number;
  bias: ConsensusResult["bias"];
  readiness: ConsensusResult["readiness"];
  signalState: SignalState | null;
  signalDirection: EvidenceDirection;
  htfValid: boolean;
  reasonCodes: RegimeReasonCode[];
  /** Schema version so persisted rows can be replayed coherently. */
  schemaVersion: number;
}

// ─── Classifier (deterministic, order-sensitive rules) ─────────────────────
/**
 * Rule precedence — evaluated top-to-bottom, first match wins:
 *
 *   1. Availability / health guard          → unknown
 *   2. Opposing-to-open-position guard      → opposing_to_open_position
 *   3. Signal state INVALIDATED / HTF flip  → reversal_forming
 *   4. High MTF conflict                    → volatile
 *   5. Confirmed strong trend               → strong_up/downtrend
 *   6. Armed but not yet confirmed          → developing_trend (strong dir)
 *   7. Building directional alignment       → developing_trend
 *   8. Balanced / low-score                 → ranging
 *   9. Fallback                             → unknown
 *
 * Determinism: same input → same output. Idempotent.
 */
export function classifyMarketRegime(
  input: RegimeInput,
  cfg: RegimeConfigV1 = REGIME_CONFIG_V1,
): RegimeEvidence {
  const { consensus, signalDirection, signalState, htfValid, health } = input;
  const reasonCodes: RegimeReasonCode[] = [];

  const base: Omit<RegimeEvidence, "regime" | "reasonCodes"> = {
    confidence: consensus.confidence,
    weightedScore: consensus.weightedScore,
    conflict: consensus.conflict,
    availability: consensus.availability,
    bias: consensus.bias,
    readiness: consensus.readiness,
    signalState,
    signalDirection,
    htfValid,
    schemaVersion: REGIME_SCHEMA_VERSION,
  };

  const emit = (regime: MarketRegime): RegimeEvidence => ({
    ...base,
    regime,
    reasonCodes: [...reasonCodes],
  });

  // 1. Availability / health guard — fail safe.
  if (health === "offline") {
    reasonCodes.push("insufficient_data");
    return emit("unknown");
  }
  if (consensus.availability < cfg.minAvailability) {
    reasonCodes.push("insufficient_data");
    return emit("unknown");
  }
  if (!htfValid) {
    reasonCodes.push("htf_stale_or_missing");
    // Still classify — we may see clear invalidation or high conflict — but
    // "strong" categories require htfValid (checked below).
  }
  if (signalState === null) {
    reasonCodes.push("signal_state_missing");
  }

  // 2. Opposing-to-open-position — highest business-rule precedence when a
  //    position is on the book and market is confirmed against it. Requires
  //    the same evidence bar as a "strong" call, plus opposite direction.
  const openDir = input.openPositionDirection ?? "none";
  if (openDir !== "none" && signalDirection !== "none" && signalDirection !== openDir) {
    const strongEnough =
      consensus.confidence >= cfg.opposingConfidenceMin &&
      consensus.conflict <= cfg.strongConflictMax &&
      (signalState === "ARMED" || signalState === "CONFIRMED");
    if (strongEnough) {
      reasonCodes.push(
        openDir === "long"
          ? "opposing_confirmed_vs_open_long"
          : "opposing_confirmed_vs_open_short",
      );
      return emit("opposing_to_open_position");
    }
  }

  // 3. Reversal — the state reducer just invalidated the prior direction, or
  //    HTF flipped. Both surface via `stateReasonCodes` from state.ts.
  const invalidated =
    signalState === "INVALIDATED" ||
    input.stateReasonCodes.includes("invalidated_structure") ||
    input.stateReasonCodes.includes("invalidated_flip_blocked");
  const htfFlipped = input.stateReasonCodes.includes("invalidated_htf_flipped");
  if (invalidated || htfFlipped) {
    reasonCodes.push(htfFlipped ? "htf_flipped_prior_direction" : "state_invalidated");
    return emit("reversal_forming");
  }

  // 4. Volatile — MTF disagreement dominates.
  if (consensus.conflict >= cfg.volatileConflictMin) {
    reasonCodes.push("mtf_conflict_high");
    return emit("volatile");
  }

  // 5/6. Confirmed / armed strong trend — both need htfValid + score magnitude
  //      + low conflict + high confidence.
  const scoreMag = Math.abs(consensus.weightedScore);
  const strong =
    htfValid &&
    consensus.confidence >= cfg.strongConfidenceMin &&
    consensus.conflict <= cfg.strongConflictMax &&
    scoreMag >= cfg.strongScoreMagnitudeMin;

  if (strong && signalState === "CONFIRMED" && signalDirection !== "none") {
    reasonCodes.push(
      signalDirection === "long" ? "confirmed_long_alignment" : "confirmed_short_alignment",
    );
    return emit(signalDirection === "long" ? "strong_uptrend" : "strong_downtrend");
  }
  if (strong && signalState === "ARMED" && signalDirection !== "none") {
    reasonCodes.push(
      signalDirection === "long" ? "armed_long_alignment" : "armed_short_alignment",
    );
    return emit("developing_trend");
  }

  // 7. Building directional alignment — trend not yet strong enough to be
  //    "strong", but there IS a direction taking shape.
  if (
    signalState === "BUILDING" &&
    signalDirection !== "none" &&
    scoreMag > cfg.rangingScoreMagnitudeMax
  ) {
    reasonCodes.push("building_directional");
    return emit("developing_trend");
  }

  // 8. Balanced / low-score → ranging.
  if (
    (consensus.bias === "balanced" || consensus.bias === "no-signal") &&
    scoreMag <= cfg.rangingScoreMagnitudeMax &&
    consensus.conflict < cfg.volatileConflictMin
  ) {
    reasonCodes.push("balanced_low_score");
    return emit("ranging");
  }

  // 9. Fallback.
  reasonCodes.push("insufficient_data");
  return emit("unknown");
}
