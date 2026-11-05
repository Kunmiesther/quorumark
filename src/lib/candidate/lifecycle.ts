// Candidate lifecycle view-model: pure, client-safe, no I/O.
//
// The lifecycle only ever reports states that are provable from persisted
// facts. There is deliberately no code path that infers a transition — an
// unknown stage renders as unknown rather than as progress.

import { z } from "zod";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

export const LIFECYCLE_STAGES = [
  "candidate_created",
  "technical_validated",
  "technical_rejected",
  "ai_shadow_pending",
  "ai_shadow_evaluated",
  "ai_shadow_unavailable",
  "execution_approved",
  "execution_rejected",
  "order_submitted",
  "order_failed",
  "filled",
  "cancelled",
  "closed",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** JSON-compatible evidence values: safe to cross the server-fn boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const candidateRowSchema = z.object({
  candidate_id: z.string(),
  connection_id: z.string().nullish(),
  strategy: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  direction: z.enum(["long", "short"]),
  candle_close_at: z.string(),
  market_data_at: z.string().nullish(),
  freshness_ms: z.number().nullish(),
  entry_zone: z.object({ low: z.number(), high: z.number() }).nullish(),
  invalidation: z.coerce.number().nullish(),
  tp_ladder: z.array(z.record(z.string(), z.number())).nullish(),
  evidence: z.record(z.string(), jsonValueSchema).nullish(),
  evidence_hash: z.string(),
  schema_version: z.string().nullish(),
  technical_decision: z.enum(["technical_validated", "technical_rejected"]),
  technical_reason: z.string().nullish(),
  idempotency_key: z.string().nullish(),
  ai_shadow_state: z.enum([
    "ai_shadow_pending",
    "ai_shadow_evaluated",
    "ai_shadow_unavailable",
  ]),
  created_at: z.string().nullish(),
});

export interface CandidateRecord {
  candidateId: string;
  connectionId: string | null;
  strategy: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  candleCloseAt: string;
  marketDataAt: string | null;
  freshnessMs: number | null;
  entryZone: { low: number; high: number } | null;
  invalidation: number | null;
  tpLadder: Record<string, number>[];
  evidence: Record<string, JsonValue>;
  evidenceHash: string;
  schemaVersion: string | null;
  technicalDecision: "technical_validated" | "technical_rejected";
  technicalReason: string | null;
  idempotencyKey: string | null;
  aiShadowState: "ai_shadow_pending" | "ai_shadow_evaluated" | "ai_shadow_unavailable";
  createdAt: string | null;
}

export interface CandidateLifecycleDto {
  candidate: CandidateRecord;
  evaluation: CommitteeEvaluationDto | null;
  /** `order_intents.state` for the correlated intent, when one exists. */
  orderState: string | null;
  states: LifecycleStage[];
}

/** Parse one persisted candidate row. Returns null when it does not validate. */
export function parseCandidateRow(row: unknown): CandidateRecord | null {
  const parsed = candidateRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    candidateId: r.candidate_id,
    connectionId: r.connection_id ?? null,
    strategy: r.strategy,
    symbol: r.symbol,
    timeframe: r.timeframe,
    direction: r.direction,
    candleCloseAt: r.candle_close_at,
    marketDataAt: r.market_data_at ?? null,
    freshnessMs: r.freshness_ms ?? null,
    entryZone: r.entry_zone ?? null,
    invalidation: r.invalidation ?? null,
    tpLadder: r.tp_ladder ?? [],
    evidence: r.evidence ?? {},
    evidenceHash: r.evidence_hash,
    schemaVersion: r.schema_version ?? null,
    technicalDecision: r.technical_decision,
    technicalReason: r.technical_reason ?? null,
    idempotencyKey: r.idempotency_key ?? null,
    aiShadowState: r.ai_shadow_state,
    createdAt: r.created_at ?? null,
  };
}

export function evidenceString(c: CandidateRecord, key: string): string | null {
  const v = c.evidence[key];
  return typeof v === "string" ? v : null;
}
export function evidenceNumber(c: CandidateRecord, key: string): number | null {
  const v = c.evidence[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function evidenceNumbers(c: CandidateRecord, key: string): number[] {
  const v = c.evidence[key];
  return Array.isArray(v)
    ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
}

/** Map `order_intents.state` onto the lifecycle vocabulary. */
function orderStages(state: string | null): LifecycleStage[] {
  switch (state) {
    case "previewed":
    case "confirmed":
    case "queued":
    case "signing":
      return ["execution_approved"];
    case "submitted":
    case "open":
    case "partially_filled":
      return ["execution_approved", "order_submitted"];
    case "filled":
      return ["execution_approved", "order_submitted", "filled"];
    case "cancelled":
    case "cancellation_pending":
      return ["execution_approved", "order_submitted", "cancelled"];
    case "rejected":
      return ["execution_rejected"];
    case "failed":
    case "reconciliation_required":
      return ["execution_approved", "order_failed"];
    default:
      return [];
  }
}

/**
 * Ordered list of stages this candidate has provably reached. Out-of-order or
 * missing evidence simply omits a stage; nothing is back-filled.
 */
export function deriveLifecycleStates(
  candidate: CandidateRecord,
  evaluation: CommitteeEvaluationDto | null,
  orderState: string | null,
): LifecycleStage[] {
  const stages: LifecycleStage[] = ["candidate_created", candidate.technicalDecision];
  if (evaluation) {
    stages.push(
      evaluation.availableRoles.length > 0 ? "ai_shadow_evaluated" : "ai_shadow_unavailable",
    );
  } else if (candidate.aiShadowState === "ai_shadow_unavailable") {
    stages.push("ai_shadow_unavailable");
  } else {
    stages.push("ai_shadow_pending");
  }
  stages.push(...orderStages(orderState));
  return stages;
}

/** How the UI should frame this candidate relative to "now". */
export type CandidateFreshness = "current" | "stale";

export function candidateFreshness(
  candidate: CandidateRecord,
  nowMs: number,
  maxAgeMs: number,
): CandidateFreshness {
  const closed = Date.parse(candidate.candleCloseAt);
  if (!Number.isFinite(closed)) return "stale";
  return nowMs - closed <= maxAgeMs ? "current" : "stale";
}

/** Midpoint of the proven entry zone, or null when no zone was persisted. */
export function candidateEntry(candidate: CandidateRecord): number | null {
  const z = candidate.entryZone;
  if (!z || !Number.isFinite(z.low) || !Number.isFinite(z.high)) return null;
  return (z.low + z.high) / 2;
}

/**
 * Absolute TP prices implied by the persisted ladder.
 *
 * The ladder is stored as risk multiples, not prices, so the chart needs the
 * deterministic geometry entry ± rr × |entry − invalidation|. This is pure
 * projection of persisted facts — it never invents a level: with no entry
 * zone, no invalidation, or no ladder the result is empty.
 */
export function candidateTpPrices(candidate: CandidateRecord): number[] {
  const entry = candidateEntry(candidate);
  const inv = candidate.invalidation;
  if (entry == null || inv == null || !Number.isFinite(inv)) return [];
  const risk = Math.abs(entry - inv);
  if (!(risk > 0)) return [];
  const sign = candidate.direction === "long" ? 1 : -1;
  return candidate.tpLadder
    .map((rung) => {
      const rr = rung.rr_multiple;
      return typeof rr === "number" && Number.isFinite(rr) ? entry + sign * rr * risk : null;
    })
    .filter((n): n is number => n != null);
}

/** Count of seats that returned a validated opinion matching the consensus. */
export function agreementCount(evaluation: CommitteeEvaluationDto | null): {
  agree: number;
  available: number;
} {
  if (!evaluation) return { agree: 0, available: 0 };
  const available = evaluation.outcomes.filter((o) => o.available);
  const dir = evaluation.consensusDirection;
  const agree =
    dir == null ? 0 : available.filter((o) => o.available && o.response.direction === dir).length;
  return { agree, available: available.length };
}

