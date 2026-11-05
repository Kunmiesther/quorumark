// Deterministic Onyx synthesis for one candidate.
//
// Onyx EXPLAINS; it never recomputes. Every sentence below is assembled from
// fields already persisted on the lifecycle DTO — no model call, no inference,
// no invented value. Missing data yields fewer sentences, never a guess.

import {
  agreementCount,
  candidateEntry,
  candidateTpPrices,
  type CandidateLifecycleDto,
} from "@/lib/candidate/lifecycle";

const VERDICT_PHRASE: Record<string, string> = {
  shadow_endorse: "the committee endorsed the thesis",
  shadow_weak_endorse: "the committee weakly endorsed the thesis",
  shadow_reject: "the committee rejected the thesis",
  shadow_no_consensus: "the committee reached no consensus",
  shadow_unavailable: "no committee opinion was available",
};

function fmt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "unknown" : String(Number(n.toFixed(6)));
}

/** Concise deterministic explanation of the deterministic strategy leg. */
export function deterministicExplanation(dto: CandidateLifecycleDto): string {
  const c = dto.candidate;
  const parts = [
    `${c.strategy} proposed a ${c.direction} on ${c.symbol} from the completed ${c.timeframe} candle.`,
  ];
  const entry = candidateEntry(c);
  if (entry != null) parts.push(`Entry midpoint ${fmt(entry)}.`);
  if (c.invalidation != null) parts.push(`Invalidation ${fmt(c.invalidation)}.`);
  const tps = candidateTpPrices(c);
  if (tps.length) parts.push(`Targets ${tps.map(fmt).join(", ")}.`);
  parts.push(
    c.technicalDecision === "technical_validated"
      ? "Technical validation passed."
      : `Technical validation rejected${c.technicalReason ? `: ${c.technicalReason}` : ""}.`,
  );
  return parts.join(" ");
}

/** Concise deterministic synthesis of the persisted shadow record. */
export function onyxSynthesis(dto: CandidateLifecycleDto): string {
  const ev = dto.evaluation;
  if (!ev) {
    return dto.candidate.aiShadowState === "ai_shadow_unavailable"
      ? "No shadow opinion is on record for this candidate; the providers were unreachable."
      : "The shadow committee has not answered for this evidence hash yet.";
  }
  const { agree, available } = agreementCount(ev);
  const sentences = [
    `${VERDICT_PHRASE[ev.verdict] ?? ev.verdict} with ${agree} of ${available} available seats aligned on ${ev.consensusDirection ?? "no direction"}.`,
  ];
  if (ev.consensusConfidence != null) {
    sentences.push(`Recorded consensus confidence ${Math.round(ev.consensusConfidence * 100)}%.`);
  }
  if (ev.unavailableRoles.length) {
    sentences.push(`Seats unavailable: ${ev.unavailableRoles.join(", ")}.`);
  }
  if (ev.riskDissent) sentences.push("The risk officer dissented.");
  if (ev.riskFlags.length) sentences.push(`Risk flags: ${ev.riskFlags.slice(0, 6).join(", ")}.`);
  sentences.push(
    dto.orderState
      ? `Correlated order intent state: ${dto.orderState}.`
      : "No live order is associated with this candidate.",
  );
  return sentences.join(" ");
}
