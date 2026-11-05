// Pure aggregation of independent first-round provider outcomes into a
// SHADOW verdict. No I/O. No authority. The deterministic engine remains
// the source of truth; this only scores, recommends, or rejects.

import type {
  CommitteeDirection,
  CommitteeRole,
  ProviderOutcome,
  ProviderOutcomeOk,
} from "./schema";
import type { ShadowVerdict } from "./dto";

export type { ShadowVerdict };


export interface CommitteeVerdict {
  verdict: ShadowVerdict;
  /** Always true. Persisted so no consumer can mistake this for authority. */
  advisory: true;
  /** Direction the available models agree on, or null. */
  consensusDirection: CommitteeDirection | null;
  /** Mean confidence across available models that voted the consensus. */
  consensusConfidence: number | null;
  availableRoles: CommitteeRole[];
  unavailableRoles: CommitteeRole[];
  /** Union of every risk flag reported by any available model. */
  riskFlags: string[];
  /** True when the adversarial risk officer dissents from the lead. */
  riskDissent: boolean;
  notes: string[];
}

/** Minimum providers that must answer for any verdict other than unavailable. */
export const MIN_AVAILABLE_PROVIDERS = 2;

function isOk(o: ProviderOutcome): o is ProviderOutcomeOk {
  return o.available === true;
}

function mean(ns: number[]): number | null {
  if (!ns.length) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

export function aggregateCommittee(outcomes: ProviderOutcome[]): CommitteeVerdict {
  const ok = outcomes.filter(isOk);
  const availableRoles = ok.map((o) => o.role);
  const unavailableRoles = outcomes.filter((o) => !isOk(o)).map((o) => o.role);
  const riskFlags = Array.from(
    new Set(ok.flatMap((o) => o.response.risk_flags.map((f) => String(f).slice(0, 64)))),
  ).sort();
  const notes: string[] = [];

  const lead = ok.find((o) => o.role === "lead") ?? null;
  const risk = ok.find((o) => o.role === "risk") ?? null;
  const riskDissent = Boolean(
    lead && risk && risk.response.direction !== lead.response.direction,
  );

  if (ok.length < MIN_AVAILABLE_PROVIDERS) {
    notes.push(
      `only ${ok.length} of ${outcomes.length} providers answered; fail-closed`,
    );
    return {
      verdict: "shadow_unavailable",
      advisory: true,
      consensusDirection: null,
      consensusConfidence: null,
      availableRoles,
      unavailableRoles,
      riskFlags,
      riskDissent,
      notes,
    };
  }

  // Tally directions across available models.
  const tally = new Map<CommitteeDirection, ProviderOutcomeOk[]>();
  for (const o of ok) {
    const list = tally.get(o.response.direction) ?? [];
    list.push(o);
    tally.set(o.response.direction, list);
  }
  let top: CommitteeDirection | null = null;
  let topVoters: ProviderOutcomeOk[] = [];
  let tied = false;
  for (const [dir, voters] of tally) {
    if (voters.length > topVoters.length) {
      top = dir;
      topVoters = voters;
      tied = false;
    } else if (top !== null && voters.length === topVoters.length) {
      tied = true;
    }
  }

  if (tied || top === null) {
    notes.push("no majority direction among available models");
    return {
      verdict: "shadow_no_consensus",
      advisory: true,
      consensusDirection: null,
      consensusConfidence: null,
      availableRoles,
      unavailableRoles,
      riskFlags,
      riskDissent,
      notes,
    };
  }

  const consensusConfidence = mean(topVoters.map((o) => o.response.confidence));

  if (top === "no_trade") {
    notes.push("majority of available models recommend standing down");
    return {
      verdict: "shadow_reject",
      advisory: true,
      consensusDirection: "no_trade",
      consensusConfidence,
      availableRoles,
      unavailableRoles,
      riskFlags,
      riskDissent,
      notes,
    };
  }

  // The risk officer holds a soft veto: dissent downgrades, never upgrades.
  if (riskDissent) {
    notes.push("risk officer dissents from lead thesis");
  }
  const unanimous = topVoters.length === ok.length;
  const strong = (consensusConfidence ?? 0) >= 0.66;
  // A full endorsement requires the risk officer to have actually spoken. If
  // that seat is unavailable the strongest possible verdict is a weak endorse.
  const riskHeard = ok.some((o) => o.role === "risk");
  if (!riskHeard) notes.push("risk officer unavailable — endorsement capped");

  const verdict: ShadowVerdict =
    unanimous && strong && riskHeard && !riskDissent
      ? "shadow_endorse"
      : "shadow_weak_endorse";

  return {
    verdict,
    advisory: true,
    consensusDirection: top,
    consensusConfidence,
    availableRoles,
    unavailableRoles,
    riskFlags,
    riskDissent,
    notes,
  };
}
