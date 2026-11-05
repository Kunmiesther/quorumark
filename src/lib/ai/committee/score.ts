// Deterministic, versioned SHADOW scorer.
//
// AUTHORITY: NONE. The score is a recorded opinion about a candidate; no
// consumer may gate, size, or place an order with it.
//
// Design rules (deliberately NOT a majority vote):
//   • Every seat contributes a weighted, signed alignment with the
//     deterministic proposal, scaled by its own evidence quality.
//   • Missing seats are penalised, never renormalised away. A committee that
//     half-answered cannot score like one that fully answered.
//   • Risk-officer dissent applies a fixed downgrade.
//   • Pure and total: same outcomes in, same score out, forever.

import type { CommitteeDirection, CommitteeRole, ProviderOutcome, ProviderOutcomeOk } from "./schema";

/** Bump on any change to weights, penalties, or band thresholds. */
export const SCORER_VERSION = "scorer.v1";

export const ROLE_WEIGHTS: Record<CommitteeRole, number> = {
  lead: 0.35,
  risk: 0.4,
  structure: 0.25,
};

/** Fewer available seats than this can only ever score `insufficient`. */
export const MIN_SCORED_SEATS = 2;
/** Fixed downgrade (in raw [-1,1] space) when the risk officer dissents. */
export const RISK_DISSENT_PENALTY = 0.15;

export const SCORE_BANDS = ["strong", "moderate", "weak", "avoid", "insufficient"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export interface ShadowScore {
  scorerVersion: string;
  /** 0..100. 50 means "the committee adds nothing either way". */
  score: number;
  band: ScoreBand;
  /** Fraction of total seat weight that actually answered. */
  completeness: number;
  /** Per-seat contribution, for display and audit. */
  contributions: { role: CommitteeRole; weight: number; alignment: number; quality: number }[];
  notes: string[];
}

function isOk(o: ProviderOutcome): o is ProviderOutcomeOk {
  return o.available === true;
}

/** Signed agreement of one seat with the deterministic proposal, in [-1,1]. */
export function alignment(
  seatDirection: CommitteeDirection,
  proposed: CommitteeDirection,
  confidence: number,
): number {
  const c = Math.min(1, Math.max(0, confidence));
  if (proposed === "no_trade") {
    // Nothing was proposed; a directional seat cannot "agree" with it.
    return seatDirection === "no_trade" ? 0 : -0.5 * c;
  }
  if (seatDirection === proposed) return c;
  if (seatDirection === "no_trade") return -0.5 * c;
  return -c; // opposite direction
}

/** Evidence quality multiplier in [0.5, 1]: weak evidence dilutes any vote. */
export function evidenceQuality(e: {
  trend: number;
  pivots: number;
  volume: number;
  liquidity: number;
  fvg: number;
  historical_similarity: number;
}): number {
  const vals = [e.trend, e.pivots, e.volume, e.liquidity, e.fvg, e.historical_similarity];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return 0.5 + 0.5 * mean;
}

export function bandForScore(score: number): Exclude<ScoreBand, "insufficient"> {
  if (score >= 75) return "strong";
  if (score >= 60) return "moderate";
  if (score >= 45) return "weak";
  return "avoid";
}

export function scoreCommittee(
  outcomes: ProviderOutcome[],
  proposedDirection: CommitteeDirection,
): ShadowScore {
  const ok = outcomes.filter(isOk);
  const totalWeight = Object.values(ROLE_WEIGHTS).reduce((a, b) => a + b, 0);
  const answeredWeight = ok.reduce((a, o) => a + (ROLE_WEIGHTS[o.role] ?? 0), 0);
  const completeness = totalWeight > 0 ? answeredWeight / totalWeight : 0;
  const notes: string[] = [];

  const contributions = ok.map((o) => ({
    role: o.role,
    weight: ROLE_WEIGHTS[o.role] ?? 0,
    alignment: alignment(o.response.direction, proposedDirection, o.response.confidence),
    quality: evidenceQuality(o.response.evidence),
  }));

  if (ok.length < MIN_SCORED_SEATS) {
    notes.push(`only ${ok.length} of ${outcomes.length} seats answered; not scoreable`);
    return {
      scorerVersion: SCORER_VERSION,
      score: 50,
      band: "insufficient",
      completeness,
      contributions,
      notes,
    };
  }

  // Weighted mean over ALL seat weight, so silence pulls toward neutral.
  const weighted = contributions.reduce((a, c) => a + c.weight * c.alignment * c.quality, 0);
  let raw = totalWeight > 0 ? weighted / totalWeight : 0;
  if (completeness < 1) {
    notes.push(`completeness ${(completeness * 100).toFixed(0)}% — unanswered seats score as zero`);
  }

  const lead = ok.find((o) => o.role === "lead");
  const risk = ok.find((o) => o.role === "risk");
  if (lead && risk && risk.response.direction !== lead.response.direction) {
    raw -= RISK_DISSENT_PENALTY;
    notes.push("risk officer dissents from lead thesis");
  }
  if (!risk) notes.push("risk seat unavailable — score carries no adversarial check");

  const clamped = Math.min(1, Math.max(-1, raw));
  const score = Math.round(50 * (1 + clamped) * 100) / 100;

  return {
    scorerVersion: SCORER_VERSION,
    score,
    band: bandForScore(score),
    completeness,
    contributions,
    notes,
  };
}
