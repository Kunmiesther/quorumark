import type { ProviderOutcome } from "@/lib/ai/committee/schema";

export type AiUsageFeature =
  | "onyx_council"
  | "decision_council"
  | "paper_entry_council"
  | "paper_position_council"
  | "diagnostic_council"
  | "onyx_brain"
  | "setup_guide"
  | "live_advisory"
  | "tp_council";

type Price = { input: number; output: number; cachedInput?: number; source: string };

// USD per one million tokens. Keep this deliberately small and versioned.
// Unknown models remain visible in the dashboard with $0 estimated cost instead
// of silently inventing a price.
const PRICE_PER_MILLION: Record<string, Price> = {
  "zai-org/GLM-5.3-Flash": { input: 0.15, output: 0.5, cachedInput: 0.03, source: "together:2026-09-09" },
  "Qwen/Qwen3.5-9B": { input: 0.17, output: 0.25, source: "together:2026-09-09" },
  "Qwen/Qwen3.8-Flash": { input: 0.15, output: 0.47, source: "together:2026-09-09" },
  "deepseek-chat": { input: 0.14, output: 0.28, cachedInput: 0.0028, source: "deepseek:2026-09-09" },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cachedInput: 0.0028, source: "deepseek:2026-09-09" },
};

export function estimateAiUsageCost(outcome: Pick<ProviderOutcome, "model" | "usage">) {
  const usage = outcome.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const price = PRICE_PER_MILLION[outcome.model];
  if (!price) return { usage, cost: 0, source: "unpriced" };
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (uncachedInput * price.input +
      usage.cachedInputTokens * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000;
  return { usage, cost, source: price.source };
}

export function createAiUsageCollector(userId: string | null, feature: AiUsageFeature) {
  const attempts: ProviderOutcome[] = [];
  return {
    onAttempt(outcome: ProviderOutcome) {
      attempts.push(outcome);
    },
    async flush() {
      if (attempts.length === 0) return;
      try {
        const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
        const client = await ledgerClient();
        const { error } = await client.from("ai_usage_events").insert(
          attempts.map((outcome) => {
            const { usage, cost, source } = estimateAiUsageCost(outcome);
            return {
              user_id: userId,
              feature,
              provider: outcome.provider,
              model: outcome.model,
              status: outcome.available ? "success" : outcome.reason === "timeout" ? "timeout" : "error",
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cached_input_tokens: usage.cachedInputTokens,
              estimated_cost_usd: cost,
              latency_ms: Math.max(0, Math.trunc(outcome.latencyMs)),
              pricing_source: source,
            };
          }),
        );
        if (error) throw error;
      } catch (error) {
        // Metering must never block an advisory or trading workflow.
        console.warn("AI usage metering failed", error instanceof Error ? error.message : "unknown error");
      } finally {
        attempts.length = 0;
      }
    },
  };
}

export async function recordRawAiUsage(input: {
  userId: string | null;
  feature: AiUsageFeature;
  provider: string;
  model: string;
  status: "success" | "error" | "timeout";
  latencyMs: number;
  body?: unknown;
}) {
  const body = input.body as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  } | undefined;
  const usage = {
    inputTokens: Math.max(0, Math.trunc(body?.usage?.prompt_tokens ?? 0)),
    outputTokens: Math.max(0, Math.trunc(body?.usage?.completion_tokens ?? 0)),
      cachedInputTokens: Math.max(
        0,
        Math.trunc(body?.usage?.prompt_cache_hit_tokens ?? body?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      ),
  };
  const { cost, source } = estimateAiUsageCost({ model: input.model, usage });
  try {
    const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
    const client = await ledgerClient();
    const { error } = await client.from("ai_usage_events").insert({
      user_id: input.userId,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      status: input.status,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      estimated_cost_usd: cost,
      latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
      pricing_source: source,
    });
    if (error) throw error;
  } catch (error) {
    console.warn("AI usage metering failed", error instanceof Error ? error.message : "unknown error");
  }
}
