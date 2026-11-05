// Customer-facing identity for the Turtle Bot intelligence layer.
//
// RULE: customer surfaces name the three seats Lead Strategist, Risk Guardian
// and Market Structure Analyst, with ONYX as the final synthesis. Vendor and
// model provenance (OpenAI, Claude, Gemini, model ids, latency) stays in the
// database, logs, audit exports and owner-only "Technical details".

import type { CommitteeRole } from "@/lib/ai/committee/schema";

/** Canonical customer-facing label for the collective. */
export const AI_LABEL = "AI" as const;

/** Simple customer-facing states. */
export const AI_STATE = {
  active: "AI ACTIVE",
  reviewing: "AI REVIEWING",
  degraded: "AI DEGRADED",
  unavailable: "AI UNAVAILABLE",
  decision: "AI DECISION",
} as const;
export type AiState = keyof typeof AI_STATE;

/** ONYX is deterministic synthesis, never presented as a fourth model. */
export const ONYX_IDENTITY = {
  name: "ONYX",
  decision: "ONYX DECISION",
  remit: "Final deterministic synthesis and recommendation",
} as const;

/** Internal role → provenance name. Owner technical diagnostics only. */
export const ROLE_TECHNICAL_NAME: Record<CommitteeRole, string> = {
  lead: "lead",
  risk: "risk",
  structure: "structure",
};

/**
 * Customer-facing seat identities. Owner correction 2026-08-03: clients see
 * the three strategist roles by name. Vendors/models stay owner-only.
 */
export const ROLE_DISPLAY: Record<CommitteeRole, { name: string; short: string; remit: string }> = {
  lead: { name: "Lead Strategist", short: "Lead", remit: "Directional thesis and trade construction" },
  risk: { name: "Risk Guardian", short: "Risk", remit: "Downside, exposure and veto authority" },
  structure: {
    name: "Market Structure Analyst",
    short: "Structure",
    remit: "Liquidity, structure and momentum context",
  },
};

const SEAT_ORDER: CommitteeRole[] = ["lead", "risk", "structure"];

export function roleName(role: CommitteeRole): string {
  return ROLE_DISPLAY[role].name;
}
export function roleShort(role: CommitteeRole): string {
  return ROLE_DISPLAY[role].short;
}
export function roleRemit(role: CommitteeRole): string {
  return ROLE_DISPLAY[role].remit;
}

/**
 * Seat label by rendered position. Positions map to the canonical seat order,
 * so opinion lists render the real strategist names rather than "Review N".
 */
export function aiReviewLabel(index: number): string {
  const role = SEAT_ORDER[index];
  return role ? ROLE_DISPLAY[role].name : `Review ${index + 1}`;
}


/**
 * Collective state derived from real availability. Never reports unavailable
 * while at least one current opinion exists.
 */
export function aiCollectiveState(opts: {
  asked: number;
  available: number;
  pending?: boolean;
}): AiState {
  if (opts.pending && opts.available === 0) return "reviewing";
  if (opts.asked === 0) return "unavailable";
  if (opts.available === 0) return "unavailable";
  if (opts.available < opts.asked) return "degraded";
  return "active";
}

export function aiStateLabel(state: AiState): string {
  return AI_STATE[state];
}

/** "2/3 reviewed" participation indicator. */
export function participationLabel(available: number, asked: number): string {
  return `${available}/${asked || 0} reviewed`;
}
