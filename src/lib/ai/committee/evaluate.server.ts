// SERVER-ONLY shadow-evaluation core.
//
// AUTHORITY: NONE. This module reads an immutable snapshot, asks three models
// for an independent opinion, and appends one sanitized advisory record. It
// imports no signer, broker, exchange credential, or mutation endpoint, and
// the verdict it returns is the verdict that was persisted — never recomputed
// downstream.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateCommittee } from "./aggregate";
import { parseEvaluationRow, type CommitteeEvaluationDto } from "./dto";
import { COMMITTEE_SCHEMA_VERSION, type MarketSnapshot } from "./schema";
import { scoreCommittee } from "./score";
import { createAiUsageCollector } from "@/lib/ai/usage.server";

export const EVALUATIONS_TABLE = "ai_committee_evaluations";
export const EVALUATION_COLUMNS =
  "id, candidate_id, strategy, symbol, timeframe, candle_close_at, schema_version, " +
  "evidence_hash, verdict, consensus_direction, consensus_confidence, risk_flags, " +
  "available_roles, unavailable_roles, risk_dissent, outcomes, total_latency_ms, advisory, " +
  "prompt_version, scorer_version, shadow_score, score_band";

/**
 * Evaluate one snapshot exactly once per (candidate, evidence hash).
 *
 * Idempotency is durable, not in-memory: a replayed worker cycle or a second
 * browser tab re-reads the stored record instead of re-spending model budget.
 */
export async function evaluateSnapshot(
  reader: SupabaseClient,
  userId: string,
  snapshot: MarketSnapshot,
): Promise<CommitteeEvaluationDto | null> {
  const { runFirstRound, evidenceHash, PROMPT_VERSION } = await import("./providers.server");
  const hash = await evidenceHash(snapshot);

  const existing = await reader
    .from(EVALUATIONS_TABLE)
    .select(EVALUATION_COLUMNS)
    .eq("candidate_id", snapshot.candidate_id)
    .eq("evidence_hash", hash)
    .maybeSingle();
  if (existing.data) return parseEvaluationRow(existing.data);

  const started = Date.now();
  const usage = createAiUsageCollector(userId, "onyx_council");
  // Only model-provider keys are read here. No exchange/signer/broker secret.
  const outcomes = await runFirstRound(snapshot, {
    LOVABLE_API_KEY: process.env.LOVABLE_API_KEY,
    TURTLEBOT_TOGETHER_API_KEY: process.env.TURTLEBOT_TOGETHER_API_KEY,
    TURTLEBOT_DEEPSEEK_API_KEY: process.env.TURTLEBOT_DEEPSEEK_API_KEY,
    TURTLEBOT_DEEPSEEK_MODEL: process.env.TURTLEBOT_DEEPSEEK_MODEL,
    TURTLEBOT_GEMINI_MODEL: process.env.TURTLEBOT_GEMINI_MODEL,
    TURTLEBOT_GLM_MODEL: process.env.TURTLEBOT_GLM_MODEL,
    TURTLEBOT_GLM_PROVIDER: process.env.TURTLEBOT_GLM_PROVIDER,
    TURTLEBOT_ZAI_API_KEY: process.env.TURTLEBOT_ZAI_API_KEY,
    TURTLEBOT_ZAI_MODEL: process.env.TURTLEBOT_ZAI_MODEL,
    TURTLEBOT_QWEN_MODEL: process.env.TURTLEBOT_QWEN_MODEL,
    TURTLEBOT_OPENROUTER_API_KEY: process.env.TURTLEBOT_OPENROUTER_API_KEY,
    TURTLEBOT_OPENROUTER_LEAD_MODEL: process.env.TURTLEBOT_OPENROUTER_LEAD_MODEL,
    TURTLEBOT_OPENROUTER_RISK_MODEL: process.env.TURTLEBOT_OPENROUTER_RISK_MODEL,
    TURTLEBOT_OPENROUTER_STRUCTURE_MODEL: process.env.TURTLEBOT_OPENROUTER_STRUCTURE_MODEL,
  }, undefined, { onAttempt: usage.onAttempt });
  await usage.flush();
  const totalLatencyMs = Date.now() - started;
  const verdict = aggregateCommittee(outcomes);
  // Deterministic, versioned shadow score. Persisted exactly as computed here
  // so the UI renders the recorded number rather than re-deriving one.
  const score = scoreCommittee(outcomes, snapshot.deterministic.proposed_direction);

  const { ledgerClient } = await import("./ledger.server");
  const ledger = await ledgerClient();
  const inserted = await ledger
    .from(EVALUATIONS_TABLE)
    .insert({
      user_id: userId,
      candidate_id: snapshot.candidate_id,
      strategy: snapshot.strategy,
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      candle_close_at: new Date(snapshot.candle_close_ms || Date.now()).toISOString(),
      schema_version: COMMITTEE_SCHEMA_VERSION,
      evidence_hash: hash,
      snapshot,
      outcomes,
      verdict: verdict.verdict,
      consensus_direction: verdict.consensusDirection,
      consensus_confidence: verdict.consensusConfidence,
      risk_flags: verdict.riskFlags,
      available_roles: verdict.availableRoles,
      unavailable_roles: verdict.unavailableRoles,
      risk_dissent: verdict.riskDissent,
      total_latency_ms: totalLatencyMs,
      prompt_version: PROMPT_VERSION,
      scorer_version: score.scorerVersion,
      shadow_score: score.score,
      score_band: score.band,
      advisory: true,
    })
    .select(EVALUATION_COLUMNS)
    .maybeSingle();

  // Concurrent duplicate: the unique (candidate_id, evidence_hash) pair lost
  // the race. Re-read rather than reporting a failure.
  if (!inserted.data) {
    const raced = await reader
      .from(EVALUATIONS_TABLE)
      .select(EVALUATION_COLUMNS)
      .eq("candidate_id", snapshot.candidate_id)
      .eq("evidence_hash", hash)
      .maybeSingle();
    return parseEvaluationRow(raced.data);
  }

  // Record availability on the candidate row so the UI can distinguish
  // "not asked yet" from "asked, providers were down".
  const anyAvailable = outcomes.some((o) => o.available);
  await ledger
    .from("strategy_candidates")
    .update({ ai_shadow_state: anyAvailable ? "ai_shadow_evaluated" : "ai_shadow_unavailable" })
    .eq("candidate_id", snapshot.candidate_id)
    .eq("user_id", userId);

  return parseEvaluationRow(inserted.data);
}
