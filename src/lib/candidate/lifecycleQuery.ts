/**
 * Server-side lifecycle loader shared by the candidate and decision-flow
 * server functions. Read-only: it selects the canonical candidate row, its
 * shadow evaluation and the state of the order intent already correlated by
 * the pre-existing idempotency key. No write, no execution import.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseEvaluationRow, type CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import {
  deriveLifecycleStates,
  parseCandidateRow,
  type CandidateLifecycleDto,
} from "@/lib/candidate/lifecycle";

export const CANDIDATE_COLUMNS =
  "candidate_id, connection_id, strategy, symbol, timeframe, direction, candle_close_at, " +
  "market_data_at, freshness_ms, entry_zone, invalidation, tp_ladder, evidence, " +
  "evidence_hash, schema_version, technical_decision, technical_reason, idempotency_key, " +
  "ai_shadow_state, created_at";

export const EVALUATION_COLUMNS =
  "id, candidate_id, strategy, symbol, timeframe, candle_close_at, schema_version, " +
  "evidence_hash, verdict, consensus_direction, consensus_confidence, risk_flags, " +
  "available_roles, unavailable_roles, risk_dissent, outcomes, total_latency_ms, advisory, " +
  "prompt_version, scorer_version, shadow_score, score_band";

/** Latest candidate for a symbol, joined to its own persisted proof. */
export async function loadLatestLifecycleForSymbol(
  supabase: SupabaseClient,
  symbol: string,
): Promise<CandidateLifecycleDto | null> {
  const { data: rows } = await supabase
    .from("strategy_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("symbol", symbol)
    .order("candle_close_at", { ascending: false })
    .limit(1);

  const candidate = parseCandidateRow(rows?.[0]);
  if (!candidate) return null;

  const [evalRes, intentRes] = await Promise.all([
    supabase
      .from("ai_committee_evaluations")
      .select(EVALUATION_COLUMNS)
      .eq("candidate_id", candidate.candidateId)
      .eq("evidence_hash", candidate.evidenceHash)
      .maybeSingle(),
    candidate.idempotencyKey
      ? supabase
          .from("order_intents")
          .select("state")
          .eq("client_order_id", candidate.idempotencyKey.slice(0, 64))
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const intentRow = (intentRes.data ?? null) as { state?: unknown } | null;
  const orderState = intentRow && typeof intentRow.state === "string" ? intentRow.state : null;
  const evaluation: CommitteeEvaluationDto | null = parseEvaluationRow(evalRes.data);

  return {
    candidate,
    evaluation,
    orderState,
    states: deriveLifecycleStates(candidate, evaluation, orderState),
  };
}
