/**
 * Bias hysteresis — prevents rapid flipping.
 *
 * A new bias replaces the current one only if:
 *   - it holds for ≥ HYSTERESIS_STREAK consecutive scans, OR
 *   - |Δ weighted score| ≥ HYSTERESIS_JUMP.
 * Otherwise the previous bias persists and streak is reset.
 *
 * Pure — takes the previous state, returns the new state. Callers persist to
 * `scout_bias_state`.
 */
import type { Bias } from "./types";

export const HYSTERESIS_STREAK = 2;
export const HYSTERESIS_JUMP = 0.35;

export interface BiasState {
  bias: Bias;
  streak: number;
  lastScore: number;
}

export interface HysteresisInput {
  prev: BiasState | null;
  proposedBias: Bias;
  proposedScore: number;
}

export function applyHysteresis({
  prev,
  proposedBias,
  proposedScore,
}: HysteresisInput): { bias: Bias; state: BiasState } {
  if (!prev) {
    return {
      bias: proposedBias,
      state: { bias: proposedBias, streak: 1, lastScore: proposedScore },
    };
  }
  if (proposedBias === prev.bias) {
    return {
      bias: proposedBias,
      state: { bias: proposedBias, streak: prev.streak + 1, lastScore: proposedScore },
    };
  }
  const jump = Math.abs(proposedScore - prev.lastScore);
  const nextStreak = 1;
  const shouldFlipNow = jump >= HYSTERESIS_JUMP;
  if (shouldFlipNow) {
    return {
      bias: proposedBias,
      state: { bias: proposedBias, streak: nextStreak, lastScore: proposedScore },
    };
  }
  // Not enough evidence — hold previous bias but remember pending direction.
  return {
    bias: prev.bias,
    state: { bias: prev.bias, streak: Math.max(1, prev.streak - 1), lastScore: proposedScore },
  };
}
