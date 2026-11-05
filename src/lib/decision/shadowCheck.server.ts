/**
 * SERVER-ONLY diagnostic: one sanitized TEST candidate through the three
 * committee seats.
 *
 * AUTHORITY: NONE, and deliberately weaker than the live path:
 *   • It builds an immutable synthetic snapshot — it never reads or writes
 *     `strategy_candidates`, `ai_committee_evaluations`, `order_intents`.
 *   • It imports only the provider layer. No signer, broker, exchange
 *     credential, or order helper is reachable from this module.
 *   • Results are ephemeral: returned to the caller, never mixed into live
 *     candidate or trade history. The only persisted trace is a typed audit
 *     row in `bot_events` (event = SHADOW_AI_CHECK) used for rate limiting.
 */
import type { MarketSnapshot } from "@/lib/ai/committee/schema";
import { TEST_CANDIDATE_PREFIX, type ShadowCheckResult } from "./shadowCheck.server.types";

export type { ShadowCheckResult };

/**
 * Fixed, self-describing market snapshot. Values are synthetic and labelled
 * as such in the strategy field so no model output can be mistaken for an
 * opinion about a real position.
 */
export function buildTestSnapshot(nowMs: number): MarketSnapshot {
  const closes = Array.from({ length: 40 }, (_, i) => 3000 + Math.round(Math.sin(i / 4) * 25));
  return {
    candidate_id: `${TEST_CANDIDATE_PREFIX}${nowMs}`,
    strategy: "diagnostic_selftest",
    symbol: "TEST-USDT",
    timeframe: "5m",
    candle_close_ms: nowMs,
    deterministic: {
      proposed_direction: "long",
      entry: 3000,
      entry_zone: { low: 2990, high: 3010 },
      invalidation: 2950,
      tp_levels: [3050, 3100, 3150],
      regime: "trend",
      trend_state: "up",
      trend_slope_pct: 0.12,
      atr_pct: 0.8,
      recent_closes: closes,
      recent_highs: closes.map((c) => c + 8),
      recent_lows: closes.map((c) => c - 8),
      volume_profile: closes.map((_, i) => 1000 + i * 5),
    },
  };
}

/** Run the three seats once against the synthetic snapshot. */
export async function runShadowSelfTest(nowMs: number): Promise<ShadowCheckResult> {
  const { runFirstRound, PROMPT_VERSION } = await import("@/lib/ai/committee/providers.server");
  const { createAiUsageCollector } = await import("@/lib/ai/usage.server");
  const { COMMITTEE_SCHEMA_VERSION } = await import("@/lib/ai/committee/schema");
  const snapshot = buildTestSnapshot(nowMs);
  const started = Date.now();
  const usage = createAiUsageCollector(null, "diagnostic_council");
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
  }, undefined, { onAttempt: usage.onAttempt });
  await usage.flush();
  return {
    ranAt: new Date(nowMs).toISOString(),
    testCandidateId: snapshot.candidate_id,
    diagnostic: true,
    schemaVersion: COMMITTEE_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    totalLatencyMs: Date.now() - started,
    outcomes,
  };
}
