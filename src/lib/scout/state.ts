/**
 * Signal state reducer. PURE. Idempotent under (user_id, symbol, scan_id).
 *
 * States: WATCHING → BUILDING → ARMED → CONFIRMED → WEAKENING → INVALIDATED.
 *
 * Rules:
 *  - ARMED requires H1+M15+M5 aligned AND H4/D not stale/missing.
 *  - CONFIRMED requires 2 consecutive aligned scans OR a score delta ≥ 0.35.
 *  - Direction flip forbidden: must pass through INVALIDATED first.
 *  - Retry idempotency: replaying the same `scan_id` returns the same output.
 *
 * READ-ONLY MODULE.
 */

import type { EvidenceDirection } from "./evidence";
import type { StateReasonCode } from "./reasonCodes";
import { STATE_SCHEMA_VERSION } from "./versions";

export type SignalState =
  | "WATCHING"
  | "BUILDING"
  | "ARMED"
  | "CONFIRMED"
  | "WEAKENING"
  | "INVALIDATED";

export interface CurrentState {
  state: SignalState;
  direction: EvidenceDirection;
  entered_at: number;
  prior_state: SignalState | null;
  last_scan_id: string | null;
  aligned_streak: number;
  last_score: number;
  reason_codes: StateReasonCode[];
}

export interface StateInput {
  scan_id: string;
  now: number;
  /** Weighted MTF score in [-1, +1] (from consensus). */
  weighted_score: number;
  /** True when H4 and D evidence are both fresh and non-empty. */
  htf_valid: boolean;
  /** True when H1, M15, M5 evidence all agree on the same direction. */
  ltf_aligned: boolean;
  /** Aligned direction (only meaningful when ltf_aligned=true). */
  aligned_direction: EvidenceDirection;
  /** True if structure is broken against `current.direction` (e.g. adverse BOS). */
  structure_broken: boolean;
  /** True if HTF bias has flipped opposite the current direction. */
  htf_flipped: boolean;
}

export const HYSTERESIS_STREAK = 2;
export const SCORE_DELTA_JUMP = 0.35;

export const INITIAL_STATE: CurrentState = {
  state: "WATCHING",
  direction: "none",
  entered_at: 0,
  prior_state: null,
  last_scan_id: null,
  aligned_streak: 0,
  last_score: 0,
  reason_codes: [],
};

export interface Transition {
  from: SignalState;
  to: SignalState;
  scan_id: string;
  at: number;
  direction: EvidenceDirection;
  weighted_score: number;
  reason_codes: StateReasonCode[];
  state_schema_version: number;
}

export interface ReducerResult {
  next: CurrentState;
  transition: Transition | null;
}

/**
 * Reduce one scan into the next state. Replaying the same `scan_id` returns
 * an identical `next` and a null `transition` (idempotent).
 */
export function reduceState(current: CurrentState, input: StateInput): ReducerResult {
  if (current.last_scan_id === input.scan_id) {
    return { next: current, transition: null };
  }

  const reasons: StateReasonCode[] = [];
  const from = current.state;
  let next: SignalState = current.state;
  let direction: EvidenceDirection = current.direction;
  let aligned_streak = current.aligned_streak;

  // Invalidation always wins.
  if (input.structure_broken && current.direction !== "none") {
    reasons.push("invalidated_structure");
    next = "INVALIDATED";
    direction = "none";
    aligned_streak = 0;
  } else if (input.htf_flipped && current.direction !== "none") {
    reasons.push("invalidated_htf_flipped");
    next = "INVALIDATED";
    direction = "none";
    aligned_streak = 0;
  } else if (!input.htf_valid) {
    reasons.push("htf_missing_or_stale");
    // Fall back to WATCHING (never ARMED without HTF).
    if (current.state === "ARMED" || current.state === "CONFIRMED") {
      next = "WEAKENING";
    } else {
      next = "WATCHING";
    }
    aligned_streak = 0;
  } else if (!input.ltf_aligned) {
    reasons.push("ltf_not_aligned");
    if (current.state === "ARMED" || current.state === "CONFIRMED") {
      reasons.push("weakening_ltf_lost");
      next = "WEAKENING";
    } else {
      next = current.state === "INVALIDATED" ? "WATCHING" : "BUILDING";
    }
    aligned_streak = 0;
  } else {
    // Aligned + HTF valid.
    // Direction flip blocked: must invalidate first.
    if (
      current.direction !== "none" &&
      input.aligned_direction !== "none" &&
      current.direction !== input.aligned_direction
    ) {
      reasons.push("invalidated_flip_blocked");
      next = "INVALIDATED";
      direction = "none";
      aligned_streak = 0;
    } else {
      direction = input.aligned_direction;
      aligned_streak = current.aligned_streak + 1;
      const delta = Math.abs(input.weighted_score - current.last_score);
      const armedByStreak = aligned_streak >= HYSTERESIS_STREAK;
      // Jump requires a prior baseline scan so the first-ever alignment
      // never auto-arms from the zero-initialised last_score.
      const armedByJump = current.last_scan_id !== null && delta >= SCORE_DELTA_JUMP;
      if (armedByStreak || armedByJump) {
        if (armedByJump) reasons.push("score_delta_jump");
        reasons.push("aligned_confirmed");
        // First qualification → ARMED; second in a row → CONFIRMED.
        if (current.state === "ARMED" || current.state === "CONFIRMED") {
          next = "CONFIRMED";
        } else {
          next = "ARMED";
        }
      } else {
        reasons.push("aligned_pending_hysteresis");
        next = "BUILDING";
      }
    }
  }

  const changed = next !== from || direction !== current.direction;
  const nextState: CurrentState = {
    state: next,
    direction,
    entered_at: changed ? input.now : current.entered_at || input.now,
    prior_state: changed ? from : current.prior_state,
    last_scan_id: input.scan_id,
    aligned_streak,
    last_score: input.weighted_score,
    reason_codes: reasons,
  };

  const transition: Transition | null = changed
    ? {
        from,
        to: next,
        scan_id: input.scan_id,
        at: input.now,
        direction,
        weighted_score: input.weighted_score,
        reason_codes: reasons,
        state_schema_version: STATE_SCHEMA_VERSION,
      }
    : null;

  return { next: nextState, transition };
}
