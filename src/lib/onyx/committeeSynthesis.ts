// Deterministic ONYX synthesis over ONE persisted committee evaluation.
//
// ONYX is not a fourth model. Every sentence is assembled from fields already
// written to the ledger — no model call, no inference, no invented value.

import { agreementCount } from "@/lib/candidate/lifecycle";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

const VERDICT_PHRASE: Record<string, string> = {
  shadow_endorse: "endorsed the thesis",
  shadow_weak_endorse: "weakly endorsed the thesis",
  shadow_reject: "rejected the thesis",
  shadow_no_consensus: "reached no consensus",
  shadow_unavailable: "recorded no usable opinion",
};

export function onyxEvaluationSynthesis(ev: CommitteeEvaluationDto): string {
  const { agree, available } = agreementCount(ev);
  const parts = [
    `The committee ${VERDICT_PHRASE[ev.verdict] ?? ev.verdict} with ${agree} of ${available} answering seats aligned on ${ev.consensusDirection ?? "no direction"}.`,
  ];
  if (ev.consensusConfidence != null) {
    parts.push(`Recorded consensus confidence ${Math.round(ev.consensusConfidence * 100)}%.`);
  }
  if (ev.shadowScore != null) {
    parts.push(
      `Deterministic shadow score ${Math.round(ev.shadowScore)}${ev.scoreBand ? ` (${ev.scoreBand})` : ""}.`,
    );
  }
  parts.push(
    ev.unavailableRoles.length
      ? `Seats unavailable: ${ev.unavailableRoles.join(", ")}.`
      : "All three seats answered.",
  );
  if (ev.riskDissent) parts.push("The risk officer dissented.");
  if (ev.riskFlags.length) parts.push(`Risk flags: ${ev.riskFlags.slice(0, 6).join(", ")}.`);
  return parts.join(" ");
}

/** Terminal outcome of the shadow verdict, phrased without speculation. */
export function verdictOutcome(ev: CommitteeEvaluationDto): string {
  switch (ev.verdict) {
    case "shadow_endorse":
      return "Advisory result: WOULD PROCEED (shadow only)";
    case "shadow_weak_endorse":
      return "Advisory result: PROCEED WITH CAUTION (shadow only)";
    case "shadow_reject":
      return "Advisory result: WAIT — thesis rejected";
    case "shadow_no_consensus":
      return "Advisory result: WAIT — no consensus";
    default:
      return "Advisory result: WAIT — committee unavailable";
  }
}

export function agoLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}
