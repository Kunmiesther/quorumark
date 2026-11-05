// Validated wire contract between the committee server functions and the UI.
//
// The UI never reinterprets raw database JSON: every row crosses the server
// boundary through `parseEvaluationRow`, which either yields a fully typed
// DTO or null. Nothing downstream sees `any`.

import { z } from "zod";
import { DIRECTIONS, ROLES, providerOutcomeSchema } from "./schema";
import { SCORE_BANDS, type ScoreBand } from "./score";

export const shadowVerdictSchema = z.enum([
  "shadow_endorse",
  "shadow_weak_endorse",
  "shadow_reject",
  "shadow_no_consensus",
  "shadow_unavailable",
]);
export type ShadowVerdict = z.infer<typeof shadowVerdictSchema>;

/** Persisted row shape, tolerant of nullable columns but never of wrong types. */
const evaluationRowSchema = z.object({
  id: z.string().optional(),
  candidate_id: z.string(),
  strategy: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  candle_close_at: z.string(),
  schema_version: z.string().nullish(),
  evidence_hash: z.string().nullish(),
  verdict: shadowVerdictSchema,
  consensus_direction: z.enum(DIRECTIONS).nullish(),
  consensus_confidence: z.coerce.number().nullish(),
  risk_flags: z.array(z.string()).nullish(),
  available_roles: z.array(z.enum(ROLES)).nullish(),
  unavailable_roles: z.array(z.enum(ROLES)).nullish(),
  risk_dissent: z.boolean().nullish(),
  outcomes: z.array(providerOutcomeSchema).nullish(),
  total_latency_ms: z.number().nullish(),
  prompt_version: z.string().nullish(),
  scorer_version: z.string().nullish(),
  shadow_score: z.coerce.number().nullish(),
  score_band: z.enum(SCORE_BANDS).nullish(),
  advisory: z.literal(true),
});

export interface CommitteeEvaluationDto {
  id: string | null;
  candidateId: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  candleCloseAt: string;
  schemaVersion: string | null;
  evidenceHash: string | null;
  verdict: ShadowVerdict;
  consensusDirection: (typeof DIRECTIONS)[number] | null;
  consensusConfidence: number | null;
  riskFlags: string[];
  availableRoles: (typeof ROLES)[number][];
  unavailableRoles: (typeof ROLES)[number][];
  riskDissent: boolean;
  outcomes: z.infer<typeof providerOutcomeSchema>[];
  totalLatencyMs: number | null;
  /** Versioned prompt generation that produced these opinions. */
  promptVersion: string | null;
  /** Versioned deterministic scorer that produced `shadowScore`. */
  scorerVersion: string | null;
  /** 0..100, persisted as computed. Never recomputed downstream. */
  shadowScore: number | null;
  scoreBand: ScoreBand | null;
  /** Constant. Rendered by the UI as the SHADOW banner. */
  advisory: true;
}

/** Parse one persisted row. Returns null when the row does not validate. */
export function parseEvaluationRow(row: unknown): CommitteeEvaluationDto | null {
  const parsed = evaluationRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    id: r.id ?? null,
    candidateId: r.candidate_id,
    strategy: r.strategy,
    symbol: r.symbol,
    timeframe: r.timeframe,
    candleCloseAt: r.candle_close_at,
    schemaVersion: r.schema_version ?? null,
    evidenceHash: r.evidence_hash ?? null,
    verdict: r.verdict,
    consensusDirection: r.consensus_direction ?? null,
    consensusConfidence: r.consensus_confidence ?? null,
    riskFlags: r.risk_flags ?? [],
    availableRoles: r.available_roles ?? [],
    unavailableRoles: r.unavailable_roles ?? [],
    riskDissent: r.risk_dissent ?? false,
    outcomes: r.outcomes ?? [],
    totalLatencyMs: r.total_latency_ms ?? null,
    promptVersion: r.prompt_version ?? null,
    scorerVersion: r.scorer_version ?? null,
    shadowScore: r.shadow_score ?? null,
    scoreBand: r.score_band ?? null,
    advisory: true,
  };
}
