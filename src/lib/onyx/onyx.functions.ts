/**
 * Onyx decision server function — Stage 1: OBSERVE-AND-RECOMMEND.
 *
 * Reads: Scout report (passed in from the client hook) + fleet state
 *        (paper_wallets, paper_positions, paper_trades) via the caller's
 *        authenticated Supabase client (RLS-scoped).
 * Applies: deterministic guardrails (code, not model).
 * Reasons: via TurtleBot's configured Together provider over the FILTERED set.
 * Returns: structured decisions + rationale + guardrails audit.
 *
 * NEVER writes. NEVER opens or closes a position. NEVER touches the paper
 * engine, worker, Accumulator, Hunter, or trend filter. Pure read + reason.
 */

import { createServerFn } from "@tanstack/react-start";
import { resolveGlmTransport, glmGenerationOptions } from "@/lib/ai/glmTransport.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ScoutReport } from "@/hooks/useScout";
import { newCorrelationId } from "@/lib/ops/correlation";
import { emitOpsEvent } from "@/lib/ops/emit";
import { recordRawAiUsage } from "@/lib/ai/usage.server";
import {
  applyGuardrails,
  DEFAULT_GUARDRAILS,
  type FleetState,
  type FilteredOption,
  type GuardrailConfig,
  type OnyxOption,
  type OpenPosSummary,
  type RecentTradeSummary,
  type WalletSummary,
} from "@/lib/onyx/guardrails";
import { parseOnyxModelResponse, type OnyxModelResponse } from "@/lib/onyx/modelResponse";

export type OnyxAction = "deploy" | "hold" | "skip" | "bench";

export interface OnyxDecision {
  action: OnyxAction;
  symbol: string;
  turtle: "hunter" | "accumulator" | null;
  direction: "long" | "short" | null;
  walletKey: string | null;
  priority: number; // 1 = highest
  rationale: string;
}

export interface OnyxBrainResult {
  ranAt: string; // ISO
  model: string;
  advisory: true;
  fleet: {
    walletCount: number;
    openCount: number;
    altOpenCount: number;
    freeWalletCount: number;
    benchedWallets: string[];
  };
  guardrailConfig: GuardrailConfig;
  filtered: FilteredOption[];
  options: OnyxOption[];
  decisions: OnyxDecision[];
  narrative: string;
  aiError: string | null;
}

interface OnyxTickInput {
  reports: ScoutReport[];
}


// Strip the ScoutReport down to the fields the model needs — cheap tokens,
// no PII, no fleet leakage. Guardrails run in code before this is built.
function summariseOptions(options: OnyxOption[]) {
  return options.slice(0, 12).map((o) => ({
    symbol: o.symbol,
    turtle: o.turtle,
    direction: o.direction,
    wallet: o.candidateWalletKey,
    movement: Math.round(o.movement),
    trend: o.trend,
    trend_strength: o.trendStrength == null ? null : Math.round(o.trendStrength),
    volatility: o.volatility == null ? null : Math.round(o.volatility),
    momentum: o.momentum == null ? null : Math.round(o.momentum),
  }));
}

function coerceDecisions(raw: OnyxModelResponse, allowed: OnyxOption[]): OnyxDecision[] {
  const bySymbol = new Map(allowed.map((o) => [o.symbol, o] as const));
  const out: OnyxDecision[] = [];
  for (const d of raw.decisions ?? []) {
    const action = String(d.action ?? "").toLowerCase() as OnyxAction;
    if (!["deploy", "hold", "skip", "bench"].includes(action)) continue;
    const symbol = String(d.symbol ?? "");
    const opt = bySymbol.get(symbol);
    // For deploy: must be inside allowed set + honour its turtle/direction/wallet.
    if (action === "deploy") {
      if (!opt) continue;
      out.push({
        action: "deploy",
        symbol,
        turtle: opt.turtle,
        direction: opt.direction,
        walletKey: opt.candidateWalletKey,
        priority: Number.isFinite(d.priority) ? Number(d.priority) : out.length + 1,
        rationale: String(d.rationale ?? "").slice(0, 400),
      });
    } else {
      out.push({
        action,
        symbol,
        turtle: opt?.turtle ?? null,
        direction: opt?.direction ?? null,
        walletKey: opt?.candidateWalletKey ?? null,
        priority: Number.isFinite(d.priority) ? Number(d.priority) : out.length + 1,
        rationale: String(d.rationale ?? "").slice(0, 400),
      });
    }
  }
  // Only deploys count against capacity; guardrails already sized `options`.
  return out;
}

async function askModel(
  apiKey: string,
  model: string,
  userId: string,
  options: OnyxOption[],
  filtered: FilteredOption[],
  fleet: FleetState,
  cfg: GuardrailConfig,
  benched: string[],
  freeWalletCount: number,
): Promise<{ result: OnyxModelResponse; error: string | null }> {
  const system =
    "You are ONYX, TurtleBot's decision commander in OBSERVE-AND-RECOMMEND mode. " +
    "You DO NOT execute trades. You produce structured deployment RECOMMENDATIONS " +
    "over a set of opportunities that has ALREADY been filtered by hard-coded " +
    "safety guardrails (risk, capacity, counter-trend, benched wallets). You may " +
    "never override those guardrails. You may recommend fewer deploys than free " +
    "wallets allow if diversification or edge is weak. Prefer highest-movement, " +
    "trend-aligned Accumulator or high-volatility Hunter setups. Avoid stacking " +
    "the whole fleet on correlated alts. Output STRICT JSON only, no prose.";

  const user = {
    stage: "observe_and_recommend",
    guardrails: cfg,
    fleet: {
      wallets_total: fleet.wallets.length,
      wallets_free: freeWalletCount,
      open_positions: fleet.openPositions.map((p) => ({
        wallet: p.wallet_key,
        symbol: p.symbol,
        direction: p.direction,
      })),
      benched_wallets: benched,
    },
    allowed_options: summariseOptions(options),
    filtered_summary: filtered.slice(0, 20).map((f) => ({
      symbol: f.symbol,
      reason: f.reason,
    })),
    output_schema: {
      decisions: [
        {
          action: "deploy | hold | skip | bench",
          symbol:
            "SYMBOL from allowed_options (for deploy) or from filtered/open (for hold/skip/bench)",
          priority: "integer, 1 = highest",
          rationale: "one-sentence plain-language reason",
        },
      ],
      narrative: "2-3 sentence commander's summary",
    },
    rules: [
      "Only 'deploy' entries may reference allowed_options.",
      "Do not invent symbols.",
      "Total 'deploy' entries must not exceed fleet.wallets_free.",
      "Return valid JSON matching output_schema; no markdown fences.",
    ],
  };

  const started = Date.now();
  try {
    const glm = resolveGlmTransport(process.env);
    const res = await fetch(glm.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...glmGenerationOptions({ ...glm, model }, 1200),
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      await recordRawAiUsage({
        userId,
        feature: "onyx_brain",
        provider: resolveGlmTransport(process.env).provider,
        model,
        status: "error",
        latencyMs: Date.now() - started,
      });
      const text = await res.text().catch(() => "");
      if (res.status === 429) return { result: {}, error: "AI rate limited — try again shortly." };
      if (res.status === 402)
        return { result: {}, error: "AI credits exhausted for this workspace." };
      return { result: {}, error: `AI gateway ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    await recordRawAiUsage({
      userId,
      feature: "onyx_brain",
      provider: resolveGlmTransport(process.env).provider,
      model,
      status: "success",
      latencyMs: Date.now() - started,
      body,
    });
    const parsed = parseOnyxModelResponse(body.choices?.[0]?.message?.content);
    return parsed
      ? { result: parsed, error: null }
      : {
          result: {},
          error: "AI returned an unreadable structured response; no trade was recommended.",
        };
  } catch (e) {
    await recordRawAiUsage({
      userId,
      feature: "onyx_brain",
      provider: resolveGlmTransport(process.env).provider,
      model,
      status: "error",
      latencyMs: Date.now() - started,
    });
    return { result: {}, error: (e as Error).message };
  }
}

export const runOnyxBrain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown): OnyxTickInput => {
    const i = input as { reports?: unknown };
    if (!i || !Array.isArray(i.reports)) {
      return { reports: [] };
    }
    return { reports: i.reports as ScoutReport[] };
  })
  .handler(async ({ data, context }): Promise<OnyxBrainResult> => {
    const { supabase, userId } = context;
    const decisionStartedAt = Date.now();
    const correlationId = newCorrelationId();

    // ── Fleet snapshot (read-only). ──
    const [walletsRes, posRes, tradesRes] = await Promise.all([
      supabase
        .from("paper_wallets")
        .select("wallet_key,balance,floor_hit,open_position_id")
        .eq("user_id", userId),
      supabase
        .from("paper_positions")
        .select("wallet_key,symbol,direction")
        .eq("user_id", userId)
        .eq("status", "open"),
      supabase
        .from("paper_trades")
        .select("wallet_key,exit_reason,closed_at")
        .eq("user_id", userId)
        .order("closed_at", { ascending: false })
        .limit(200),
    ]);

    const wallets: WalletSummary[] = (walletsRes.data ?? []).map((w) => ({
      wallet_key: w.wallet_key,
      balance: Number(w.balance ?? 0),
      floor_hit: Boolean(w.floor_hit),
      open_position_id: w.open_position_id ?? null,
    }));
    const openPositions: OpenPosSummary[] = (posRes.data ?? []).map((p) => ({
      wallet_key: p.wallet_key,
      symbol: p.symbol,
      direction: p.direction as "long" | "short",
    }));
    const recentTrades: RecentTradeSummary[] = (tradesRes.data ?? []).map((t) => ({
      wallet_key: t.wallet_key,
      exit_reason: String(t.exit_reason ?? ""),
      closed_at: String(t.closed_at ?? ""),
    }));

    const fleet: FleetState = { wallets, openPositions, recentTrades };
    const guard = applyGuardrails(data.reports, fleet, DEFAULT_GUARDRAILS);

    const { apiKey, model } = resolveGlmTransport(process.env);
    let decisions: OnyxDecision[] = [];
    let narrative = "";
    let aiError: string | null = null;

    if (!apiKey) {
      aiError = "TurtleBot AI provider is not configured — showing guardrail output only.";
    } else if (guard.options.length === 0) {
      narrative = "No opportunities cleared the guardrails this cycle. Standing down.";
    } else {
      const { result, error } = await askModel(
        apiKey,
        model,
        context.userId,
        guard.options,
        guard.filtered,
        fleet,
        guard.config,
        guard.benchedWallets,
        guard.freeWalletCount,
      );
      aiError = error;
      decisions = coerceDecisions(result, guard.options);
      narrative = typeof result.narrative === "string" ? result.narrative.slice(0, 600) : "";
      // Enforce capacity even if the model overshoots.
      let deploys = 0;
      decisions = decisions.map((d) => {
        if (d.action !== "deploy") return d;
        if (deploys >= guard.freeWalletCount) {
          return { ...d, action: "hold", rationale: `${d.rationale} (held: fleet at capacity)` };
        }
        deploys++;
        return d;
      });
    }

    const ranAt = new Date().toISOString();
    const decisionLatencyMs = Date.now() - decisionStartedAt;

    // Persist a decision ledger row + emit correlation events (best-effort).
    // Fail-open telemetry: if these writes fail we still return the result.
    try {
      const rows = decisions.length
        ? decisions.map((d) => ({
            user_id: userId,
            correlation_id: correlationId,
            symbol: d.symbol,
            side: d.direction,
            decision: d.action,
            reject_reason: null,
            strategy: d.turtle,
            wallet_id: null,
            confidence: null,
            envelope_version: 1,
            rules_version: 1,
            supporting_codes: [],
            conflicting_codes: [],
            risk_check: { advisory: true } as Record<string, unknown>,
            decision_at: ranAt,
            decision_latency_ms: decisionLatencyMs,
            detail: { rationale: d.rationale, priority: d.priority } as Record<string, unknown>,
          }))
        : [
            {
              user_id: userId,
              correlation_id: correlationId,
              symbol: "-",
              side: null,
              decision: "hold",
              reject_reason:
                guard.options.length === 0
                  ? "no_options_after_guardrails"
                  : (aiError ?? "no_decisions"),
              strategy: null,
              wallet_id: null,
              confidence: null,
              envelope_version: 1,
              rules_version: 1,
              supporting_codes: [],
              conflicting_codes: [],
              risk_check: { advisory: true } as Record<string, unknown>,
              decision_at: ranAt,
              decision_latency_ms: decisionLatencyMs,
              detail: { narrative } as Record<string, unknown>,
            },
          ];
      await supabase.from("onyx_decisions" as never).insert(rows as never);
    } catch {
      // silent
    }
    await emitOpsEvent(supabase, {
      correlation_id: correlationId,
      stage: "onyx_decision",
      component: "onyx",
      severity: aiError ? "warn" : "info",
      message: aiError ?? `${decisions.length} decisions, ${guard.options.length} options`,
      detail: {
        deploys: decisions.filter((d) => d.action === "deploy").length,
        free_wallets: guard.freeWalletCount,
      },
      latency_ms: decisionLatencyMs,
    });

    return {
      ranAt,
      model,
      advisory: true,
      fleet: {
        walletCount: wallets.length,
        openCount: guard.openCount,
        altOpenCount: guard.altOpenCount,
        freeWalletCount: guard.freeWalletCount,
        benchedWallets: guard.benchedWallets,
      },
      guardrailConfig: guard.config,
      filtered: guard.filtered,
      options: guard.options,
      decisions,
      narrative,
      aiError,
    };
  });
