// Pure rolling metrics for the AI committee intelligence surface.
//
// AUTHORITY: NONE. Every number here is derived from persisted evaluation
// rows. Nothing is inferred, extrapolated, or joined to unrelated trades.

import { ROLES, type CommitteeRole } from "@/lib/ai/committee/schema";
import type { CommitteeEvaluationDto, ShadowVerdict } from "@/lib/ai/committee/dto";

export const INTELLIGENCE_METRICS_VERSION = "intel.v1";

export interface WindowMetrics {
  key: "1h" | "24h" | "7d";
  evaluations: number;
  /** Share of evaluations where all three seats answered. Null with no sample. */
  fullParticipation: number | null;
  /** Share of evaluations where every available seat matched the consensus. */
  agreementRate: number | null;
}

export interface SeatMetrics {
  role: CommitteeRole;
  provider: string | null;
  model: string | null;
  asked: number;
  available: number;
  availabilityRate: number | null;
  medianLatencyMs: number | null;
  /** Most recent recorded unavailability reason, when the seat last failed. */
  lastUnavailableReason: string | null;
}

export interface IntelligenceMetrics {
  version: string;
  windows: WindowMetrics[];
  seats: SeatMetrics[];
  directions: { long: number; short: number; no_trade: number };
  verdicts: Partial<Record<ShadowVerdict, number>>;
  /** Evaluations in the 7d window whose candidate has a closed outcome. */
  matchedOutcomes: number;
  /** Evaluations in the 7d window with no attributable closed outcome yet. */
  awaitingOutcome: number;
  sample7d: number;
}

const WINDOWS: { key: WindowMetrics["key"]; ms: number }[] = [
  { key: "1h", ms: 3_600_000 },
  { key: "24h", ms: 86_400_000 },
  { key: "7d", ms: 7 * 86_400_000 },
];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function evalTime(e: CommitteeEvaluationDto): number {
  const t = Date.parse(e.candleCloseAt);
  return Number.isFinite(t) ? t : 0;
}

export function buildIntelligenceMetrics(
  evaluations: CommitteeEvaluationDto[],
  nowMs: number,
  matchedCandidateIds: Set<string>,
): IntelligenceMetrics {
  const windows: WindowMetrics[] = WINDOWS.map(({ key, ms }) => {
    const rows = evaluations.filter((e) => nowMs - evalTime(e) <= ms);
    const full = rows.filter((e) => e.outcomes.filter((o) => o.available).length === ROLES.length);
    const agreeing = rows.filter((e) => {
      const avail = e.outcomes.filter((o) => o.available);
      if (!avail.length || !e.consensusDirection) return false;
      return avail.every((o) => o.available && o.response.direction === e.consensusDirection);
    });
    return {
      key,
      evaluations: rows.length,
      fullParticipation: rows.length ? full.length / rows.length : null,
      agreementRate: rows.length ? agreeing.length / rows.length : null,
    };
  });

  const seats: SeatMetrics[] = ROLES.map((role) => {
    const outcomes = evaluations
      .map((e) => e.outcomes.find((o) => o.role === role))
      .filter((o): o is NonNullable<typeof o> => o != null);
    const ok = outcomes.filter((o) => o.available);
    const lastFail = outcomes.find((o) => !o.available);
    return {
      role,
      provider: outcomes[0]?.provider ?? null,
      model: outcomes[0]?.model ?? null,
      asked: outcomes.length,
      available: ok.length,
      availabilityRate: outcomes.length ? ok.length / outcomes.length : null,
      medianLatencyMs: median(outcomes.map((o) => o.latencyMs).filter(Number.isFinite)),
      lastUnavailableReason: lastFail && !lastFail.available ? lastFail.reason : null,
    };
  });

  const directions = { long: 0, short: 0, no_trade: 0 };
  const verdicts: Partial<Record<ShadowVerdict, number>> = {};
  for (const e of evaluations) {
    verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
    for (const o of e.outcomes) {
      if (o.available) directions[o.response.direction] += 1;
    }
  }

  const matched = evaluations.filter((e) => matchedCandidateIds.has(e.candidateId)).length;

  return {
    version: INTELLIGENCE_METRICS_VERSION,
    windows,
    seats,
    directions,
    verdicts,
    matchedOutcomes: matched,
    awaitingOutcome: evaluations.length - matched,
    sample7d: evaluations.length,
  };
}
