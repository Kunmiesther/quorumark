// SERVER-ONLY committee evaluation, keyed to a DECISION.
//
// AUTHORITY: NONE, structurally.
//   • This module runs in the web process. The trading path runs in the
//     Railway worker. There is no import edge and no network route from here
//     to the worker, the broker, the signer, or ApeX — so this cannot delay,
//     approve, reject, size, sign or submit anything, whatever it returns.
//   • It writes exactly one table, `ai_decision_opinions`, whose every row is
//     `advisory = true` by database constraint.
//   • It is called AFTER the decision is recorded and after execution has
//     already happened or not. It is a spectator with a notebook.
//
// WHAT CHANGED AND WHY: the committee used to be keyed on `candidate_id`, and
// a candidate only existed when a setup CONFIRMED. So the models were never
// asked about a WAIT — which is the overwhelming majority of candles and the
// part with the most to learn from. Keying on the decision means every
// completed candle gets three independent opinions.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseOpinionRow, type AiOpinion } from "@/lib/decision/decisionFlow";
import { pendingSchema } from "@/lib/decision/pendingTables";
import type { CommitteeDirection, MarketSnapshot } from "./schema";
import { createAiUsageCollector } from "@/lib/ai/usage.server";

export const OPINIONS_TABLE = "ai_decision_opinions";
export const OPINION_COLUMNS =
  "decision_id, role, provider, model, status, direction, confidence, summary, risk_flags, " +
  "latency_ms, prompt_version, evidence_hash, unavailable_reason, evaluated_at";

const DECISION_COLUMNS =
  "decision_id, user_id, symbol, strategy, timeframe, candle_close_at, direction, " +
  "entry_zone, invalidation, take_profits, evidence, evidence_hash";

/** Keep the HTTP status for diagnosis, never the provider body or credentials. */
export function opinionFailureReason(reason: string, detail: string): string {
  const status = /^provider responded ([45]\d{2})(?::|$)/.exec(detail)?.[1];
  return reason === "http_error" && status ? `http_error:HTTP_${status}` : reason;
}

/** `wait` is this repository's word; the committee contract says `no_trade`. */
function toCommitteeDirection(direction: string): CommitteeDirection {
  if (direction === "long" || direction === "short") return direction;
  return "no_trade";
}

/** …and back again, for the column's own vocabulary. */
function toDecisionDirection(direction: CommitteeDirection): "long" | "short" | "wait" {
  return direction === "no_trade" ? "wait" : direction;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
}

/**
 * Build the snapshot from the DECISION's own stored evidence.
 *
 * Deliberately no re-fetch: reading fresh candles here would mean the models
 * evaluated a different market from the one the strategy decided on, while
 * the record claimed a matching evidence hash.
 */
export function snapshotFromDecision(row: Record<string, unknown>): MarketSnapshot {
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const market = (evidence.market ?? {}) as Record<string, unknown>;
  const zone = row.entry_zone as { low?: unknown; high?: unknown } | null;
  const closes = numbers(market.closes);
  return {
    // The committee contract names this field `candidate_id`; it carries the
    // decision id. Same identity spine, one name behind.
    candidate_id: String(row.decision_id ?? ""),
    strategy: String(row.strategy ?? "unknown"),
    symbol: String(row.symbol ?? ""),
    timeframe: String(row.timeframe ?? "15m"),
    candle_close_ms: Date.parse(String(row.candle_close_at ?? "")) || 0,
    deterministic: {
      proposed_direction: toCommitteeDirection(String(row.direction ?? "wait")),
      entry: closes.length > 0 ? closes[closes.length - 1] : null,
      entry_zone:
        zone && typeof zone.low === "number" && typeof zone.high === "number"
          ? { low: zone.low, high: zone.high }
          : null,
      invalidation: typeof row.invalidation === "number" ? row.invalidation : null,
      tp_levels: numbers(row.take_profits),
      regime: evidence.regime == null ? null : String(evidence.regime).slice(0, 32),
      trend_state: null,
      trend_slope_pct: null,
      atr_pct: null,
      recent_closes: closes,
      recent_highs: numbers(market.highs),
      recent_lows: numbers(market.lows),
      volume_profile: [],
    },
  };
}

/**
 * Ask all three seats about one decision, exactly once per
 * (decision, role, evidence hash).
 *
 * Provider failures return RECORDED rows. Storage failures throw a bounded
 * stage code: they must not masquerade as an unasked or completed review.
 * A provider that did not
 * answer is stored as `unavailable` with its reason — never converted into
 * agreement with the deterministic decision, and never omitted so that a
 * reader could assume consent.
 */
export async function evaluateDecision(
  reader: SupabaseClient,
  userId: string,
  decisionId: string,
): Promise<AiOpinion[]> {
  const { data: decisionRow, error: decisionError } = await pendingSchema(reader)
    .from("strategy_decisions")
    .select(DECISION_COLUMNS)
    .eq("decision_id", decisionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (decisionError) throw new Error("AI_DECISION_READ_FAILED");
  if (!decisionRow) return [];

  const evidenceHash = String(
    (decisionRow as unknown as Record<string, unknown>).evidence_hash ?? "",
  );

  const existing = await pendingSchema(reader)
    .from(OPINIONS_TABLE)
    .select(OPINION_COLUMNS)
    .eq("decision_id", decisionId)
    .eq("evidence_hash", evidenceHash);
  if (existing.error) throw new Error("AI_OPINION_READ_FAILED");
  const stored = (existing.data ?? [])
    .map(parseOpinionRow)
    .filter((o): o is AiOpinion => o !== null);
  // Three seats already recorded for this exact evidence: nothing to ask.
  if (stored.length >= 3) return stored;

  const { runFirstRound, PROMPT_VERSION } = await import("./providers.server");
  const snapshot = snapshotFromDecision(decisionRow as unknown as Record<string, unknown>);
  const usage = createAiUsageCollector(userId, "decision_council");
  const outcomes = await runFirstRound(
    snapshot,
    {
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
    },
    undefined,
    { onAttempt: usage.onAttempt },
  );
  await usage.flush();

  const rows = outcomes.map((o) => ({
    decision_id: decisionId,
    user_id: userId,
    role: o.role,
    provider: o.provider,
    model: o.model,
    status: o.available ? "evaluated" : "unavailable",
    direction: o.available ? toDecisionDirection(o.response.direction) : null,
    confidence: o.available ? o.response.confidence : null,
    summary: o.available ? o.response.summary.slice(0, 600) : null,
    risk_flags: o.available ? o.response.risk_flags.slice(0, 12) : [],
    latency_ms: Math.trunc(o.latencyMs),
    prompt_version: PROMPT_VERSION,
    evidence_hash: evidenceHash,
    unavailable_reason: o.available ? null : opinionFailureReason(o.reason, o.detail),
    advisory: true,
  }));

  const { ledgerClient } = await import("./ledger.server");
  const ledger = await ledgerClient();
  // ignoreDuplicates: a concurrent second tab loses the race and re-reads.
  const { error: writeError } = await pendingSchema(ledger)
    .from(OPINIONS_TABLE)
    .upsert(rows, { onConflict: "decision_id,role,evidence_hash", ignoreDuplicates: true });
  if (writeError) throw new Error("AI_OPINION_WRITE_FAILED");

  const { data: after, error: rereadError } = await pendingSchema(reader)
    .from(OPINIONS_TABLE)
    .select(OPINION_COLUMNS)
    .eq("decision_id", decisionId)
    .eq("evidence_hash", evidenceHash);
  if (rereadError) throw new Error("AI_OPINION_VERIFY_FAILED");
  const verified = (after ?? []).map(parseOpinionRow).filter((o): o is AiOpinion => o !== null);
  if (verified.length < 3) throw new Error("AI_OPINION_PERSISTENCE_INCOMPLETE");
  return verified;
}
