// SERVER-ONLY consolidated orchestration record.
//
// AUTHORITY: NONE. This reads rows that already exist (`strategy_decisions`,
// `ai_decision_opinions`) and writes exactly one advisory summary row into
// `ai_committee_evaluations`. It calls no provider, no signer, no broker and
// no venue. It cannot change a decision, an intent, or an outcome.
//
// WHY IT EXISTS: the three seats each persisted their own opinion, and the
// decision persisted its own terminal outcome, but nothing wrote the single
// per-candidate record that ties the orchestration together. Without it the
// trail existed only as a join a human had to know how to write.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateCommittee } from "./aggregate";
import { COMMITTEE_SCHEMA_VERSION, type CommitteeDirection, type ProviderOutcome } from "./schema";
import { pendingSchema } from "@/lib/decision/pendingTables";

export const EVALUATIONS_TABLE = "ai_committee_evaluations";

interface OpinionRow {
  role: string;
  provider: string;
  model: string;
  status: string;
  direction: string | null;
  confidence: number | null;
  summary: string | null;
  risk_flags: string[] | null;
  latency_ms: number | null;
  prompt_version: string | null;
  evidence_hash: string | null;
  unavailable_reason: string | null;
}

function toCommitteeDirection(direction: string | null): CommitteeDirection {
  if (direction === "long" || direction === "short") return direction;
  return "no_trade";
}

/**
 * Adapt a persisted opinion row back into the shape the pure aggregator
 * consumes. Only fields the aggregator actually reads are populated —
 * per-seat evidence sub-scores are NOT persisted on the opinion row and are
 * therefore not invented here, which is also why no shadow score is written.
 */
function toOutcome(row: OpinionRow): ProviderOutcome {
  const base = {
    role: row.role as ProviderOutcome["role"],
    provider: row.provider,
    model: row.model,
    latencyMs: Number(row.latency_ms ?? 0),
  };
  if (row.status !== "evaluated") {
    return {
      ...base,
      available: false,
      reason: (row.unavailable_reason ?? "http_error") as never,
      detail: String(row.unavailable_reason ?? "unavailable"),
    };
  }
  return {
    ...base,
    available: true,
    response: {
      schema_version: COMMITTEE_SCHEMA_VERSION,
      direction: toCommitteeDirection(row.direction),
      confidence: Number(row.confidence ?? 0),
      entry_zone: null,
      invalidation: null,
      tp_levels: [],
      evidence: {
        trend: 0, pivots: 0, volume: 0, liquidity: 0, fvg: 0, historical_similarity: 0,
      },
      risk_flags: (row.risk_flags ?? []).map((f) => String(f).slice(0, 64)),
      summary: String(row.summary ?? ""),
    },
  } as ProviderOutcome;
}

export interface ConsolidateResult {
  decisionId: string;
  verdict: string;
  seats: number;
  created: boolean;
}

/**
 * Write (once) the consolidated orchestration record for one decision.
 * Idempotent on (user_id, candidate_id, evidence_hash) — the same unique key
 * the table already enforces. `candidate_id` carries the decision id, which
 * is the identity spine linking opinions, ONYX/terminal outcome and intent.
 */
export async function consolidateDecision(
  ledger: SupabaseClient,
  decisionId: string,
): Promise<ConsolidateResult | null> {
  const { data: decision } = await pendingSchema(ledger)
    .from("strategy_decisions")
    .select(
      "decision_id, user_id, symbol, strategy, timeframe, candle_close_at, direction, " +
        "evidence_hash, trace_id, terminal_outcome, terminal_reason, risk_check, simulated_intent",
    )
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (!decision) return null;

  const d = decision as unknown as Record<string, unknown>;
  const evidenceHash = String(d.evidence_hash ?? "");

  const { data: opinionRows } = await pendingSchema(ledger)
    .from("ai_decision_opinions")
    .select(
      "role, provider, model, status, direction, confidence, summary, risk_flags, " +
        "latency_ms, prompt_version, evidence_hash, unavailable_reason",
    )
    .eq("decision_id", decisionId)
    .eq("evidence_hash", evidenceHash);

  const opinions = (opinionRows ?? []) as unknown as OpinionRow[];
  if (opinions.length === 0) return null;

  const outcomes = opinions.map(toOutcome);
  const verdict = aggregateCommittee(outcomes);

  const { error } = await ledger.from(EVALUATIONS_TABLE).upsert(
    {
      user_id: String(d.user_id),
      candidate_id: decisionId,
      strategy: String(d.strategy ?? "unknown"),
      symbol: String(d.symbol ?? ""),
      timeframe: String(d.timeframe ?? "15m"),
      candle_close_at: String(d.candle_close_at),
      schema_version: COMMITTEE_SCHEMA_VERSION,
      evidence_hash: evidenceHash,
      // The orchestration trail, as stored — never recomputed for display.
      snapshot: {
        decision_id: decisionId,
        trace_id: d.trace_id ?? null,
        deterministic_direction: d.direction ?? null,
        terminal_outcome: d.terminal_outcome ?? null,
        terminal_reason: d.terminal_reason ?? null,
        risk_check: d.risk_check ?? null,
        simulated_intent: d.simulated_intent ?? null,
      },
      outcomes: opinions.map((o) => ({
        role: o.role,
        provider: o.provider,
        model: o.model,
        status: o.status,
        direction: o.direction,
        confidence: o.confidence,
        summary: o.summary,
        risk_flags: o.risk_flags ?? [],
        latency_ms: o.latency_ms,
        unavailable_reason: o.unavailable_reason,
      })),
      verdict: verdict.verdict,
      consensus_direction: verdict.consensusDirection,
      consensus_confidence: verdict.consensusConfidence,
      risk_flags: verdict.riskFlags,
      available_roles: verdict.availableRoles,
      unavailable_roles: verdict.unavailableRoles,
      risk_dissent: verdict.riskDissent,
      total_latency_ms: opinions.reduce((a, o) => a + Number(o.latency_ms ?? 0), 0),
      prompt_version: String(opinions[0]?.prompt_version ?? "prompt.v1"),
      advisory: true,
    },
    { onConflict: "user_id,candidate_id,evidence_hash", ignoreDuplicates: true },
  );

  return {
    decisionId,
    verdict: verdict.verdict,
    seats: opinions.length,
    created: !error,
  };
}
