import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({ range: z.enum(["24h", "7d", "30d"]).default("7d") });
export type AiUsageRange = z.infer<typeof inputSchema>["range"];

interface UsageRow {
  id: string;
  feature: string;
  provider: string;
  model: string;
  status: "success" | "error" | "timeout";
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  estimated_cost_usd: number;
  latency_ms: number;
  pricing_source: string;
  created_at: string;
}

export interface AiUsageBreakdown {
  key: string;
  provider: string;
  model: string;
  requests: number;
  tokens: number;
  costUsd: number;
  failures: number;
}

export interface AiUsageDay {
  date: string;
  requests: number;
  costUsd: number;
}

export interface AiUsageFeatureBreakdown {
  feature: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface AdminAiUsageReport {
  range: AiUsageRange;
  generatedAt: string;
  startsAt: string;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    successRate: number;
    averageLatencyMs: number;
    unpricedRequests: number;
  };
  daily: AiUsageDay[];
  breakdown: AiUsageBreakdown[];
  features: AiUsageFeatureBreakdown[];
  recent: UsageRow[];
}

async function assertAdmin(supabase: unknown, userId: string) {
  const client = supabase as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await client.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(`admin_check_failed: ${error.message}`);
  if (data !== true) throw new Error("Forbidden: admin role required");
}

function startFor(range: AiUsageRange): Date {
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

export const getAdminAiUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => inputSchema.parse(input))
  .handler(async (args: unknown): Promise<AdminAiUsageReport> => {
    const { context, data } = args as {
      context: { supabase: unknown; userId: string };
      data: { range: AiUsageRange };
    };
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const startsAt = startFor(data.range);
    const client = supabaseAdmin as unknown as SupabaseClient;
    const { data: rawRows, error } = await client
      .from("ai_usage_events")
      .select("id, feature, provider, model, status, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, latency_ms, pricing_source, created_at")
      .gte("created_at", startsAt.toISOString())
      .order("created_at", { ascending: false })
      .limit(20_000);
    if (error) throw new Error(`usage_read_failed: ${error.message}`);

    const rows = (rawRows ?? []) as UsageRow[];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let successes = 0;
    let latency = 0;
    let unpricedRequests = 0;
    const byModel = new Map<string, AiUsageBreakdown>();
    const byDay = new Map<string, AiUsageDay>();
    const byFeature = new Map<string, AiUsageFeatureBreakdown>();

    for (const row of rows) {
      inputTokens += Number(row.input_tokens ?? 0);
      outputTokens += Number(row.output_tokens ?? 0);
      cachedInputTokens += Number(row.cached_input_tokens ?? 0);
      costUsd += Number(row.estimated_cost_usd ?? 0);
      latency += Number(row.latency_ms ?? 0);
      if (row.status === "success") successes += 1;
      if (row.pricing_source === "unpriced") unpricedRequests += 1;

      const key = `${row.provider}:${row.model}`;
      const model = byModel.get(key) ?? {
        key,
        provider: row.provider,
        model: row.model,
        requests: 0,
        tokens: 0,
        costUsd: 0,
        failures: 0,
      };
      model.requests += 1;
      model.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
      model.costUsd += Number(row.estimated_cost_usd ?? 0);
      if (row.status !== "success") model.failures += 1;
      byModel.set(key, model);

      const feature = byFeature.get(row.feature) ?? { feature: row.feature, requests: 0, tokens: 0, costUsd: 0 };
      feature.requests += 1;
      feature.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
      feature.costUsd += Number(row.estimated_cost_usd ?? 0);
      byFeature.set(row.feature, feature);

      const dayKey = row.created_at.slice(0, 10);
      const day = byDay.get(dayKey) ?? { date: dayKey, requests: 0, costUsd: 0 };
      day.requests += 1;
      day.costUsd += Number(row.estimated_cost_usd ?? 0);
      byDay.set(dayKey, day);
    }

    return {
      range: data.range,
      generatedAt: new Date().toISOString(),
      startsAt: startsAt.toISOString(),
      totals: {
        requests: rows.length,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd,
        successRate: rows.length ? (successes / rows.length) * 100 : 0,
        averageLatencyMs: rows.length ? latency / rows.length : 0,
        unpricedRequests,
      },
      daily: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
      breakdown: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
      features: Array.from(byFeature.values()).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
      recent: rows.slice(0, 30),
    };
  });
