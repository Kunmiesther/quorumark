// Owner/client-facing reads for the agentic trading OS.
// Everything here is RLS-scoped: a user only ever sees their own rows.
// Nothing here can enable live execution — the promotion gate is read-only
// from the app, and flipping it requires an explicit owner action guarded by
// a database trigger.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { pendingSchema } from "@/lib/decision/pendingTables";
import {
  DEFAULT_THRESHOLDS,
  evaluatePromotion,
  maxDrawdownPct,
  profitFactor,
  type PromotionEvaluation,
  type PromotionMetrics,
  type PromotionThresholds,
} from "@/lib/agentic/promotionGate";

export interface AgentHealth {
  agent: string;
  state: "healthy" | "degraded" | "unavailable";
  lastRunAt: string | null;
  latencyMs: number | null;
  detail: string;
}

export interface ManagementEventView {
  id: string;
  traceId: string;
  parentTraceId: string | null;
  positionId: string;
  symbol: string;
  direction: string;
  sequence: number;
  trigger: string;
  participation: string;
  degraded: boolean;
  action: string;
  rationale: string;
  riskPassed: boolean;
  riskCode: string | null;
  applied: boolean;
  applyBlockedReason: string | null;
  createdAt: string;
  opinions: {
    role: string;
    provider: string;
    model: string;
    status: string;
    direction: string | null;
    confidence: number | null;
    summary: string | null;
    latencyMs: number | null;
    unavailableReason: string | null;
  }[];
}

export interface PerformanceView {
  sampleSize: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnl: number;
  expectancy: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  fullParticipation: number;
  degradedParticipation: number;
  degradedRatePct: number;
  unattributedTrades: number;
  byStrategy: { key: string; trades: number; netPnl: number; winRatePct: number }[];
  byModel: { key: string; scored: number; correct: number; accuracyPct: number }[];
  byRegime: { key: string; trades: number; netPnl: number; winRatePct: number }[];
}

export interface RuleProposalView {
  id: string;
  scope: string;
  title: string;
  rationale: string;
  sampleSize: number;
  status: string;
  createdAt: string;
}

function bucket(rows: Array<Record<string, unknown>>, field: string) {
  const map = new Map<string, { trades: number; netPnl: number; wins: number }>();
  for (const r of rows) {
    const key = (r[field] as string | null) ?? "unknown";
    const agg = map.get(key) ?? { trades: 0, netPnl: 0, wins: 0 };
    agg.trades += 1;
    agg.netPnl += Number(r.pnl_net ?? 0);
    if (String(r.outcome) === "win") agg.wins += 1;
    map.set(key, agg);
  }
  return Array.from(map.entries())
    .map(([key, a]) => ({
      key,
      trades: a.trades,
      netPnl: Number(a.netPnl.toFixed(2)),
      winRatePct: a.trades ? Number(((a.wins / a.trades) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.trades - a.trades);
}

/** Full agentic command-center payload for the signed-in user. */
export const getAgenticOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const db = pendingSchema(supabase);

    const [orchRes, eventsRes, reviewsRes, gateRes, proposalsRes, heartbeatRes] = await Promise.all([
      db
        .from("paper_ai_orchestrations")
        .select("trace_id, symbol, direction, strategy, created_at, participation, degraded, onyx_decision, terminal_outcome, risk_passed, risk_code, paper_position_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(60),
      db
        .from("paper_position_events")
        .select("id, trace_id, parent_trace_id, paper_position_id, symbol, direction, sequence, trigger, participation, degraded, onyx_action, onyx_rationale, risk_passed, risk_code, action_applied, apply_blocked_reason, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(40),
      db
        .from("paper_trade_reviews")
        .select("pnl_net, outcome, strategy, regime, participation, model_attribution, unattributed, closed_at")
        .eq("user_id", userId)
        .order("closed_at", { ascending: true })
        .limit(1000),
      db.from("agentic_promotion_gate").select("*").eq("user_id", userId).maybeSingle(),
      db
        .from("agentic_rule_proposals")
        .select("id, scope, title, rationale, sample_size, status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20),
      // worker_heartbeats is keyed by worker_id and is admin-read-only — it
      // has no user_id and no created_at. Selecting non-existent columns
      // silently yields null and would make Scout read "unavailable" for
      // everyone, which is a false statement about the worker.
      db
        .from("worker_heartbeats")
        .select("worker_id, environment, status, mode, version, last_seen_at")
        .order("last_seen_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const orchestrations = (orchRes.data ?? []) as unknown as Array<Record<string, unknown>>;
    const eventRows = (eventsRes.data ?? []) as unknown as Array<Record<string, unknown>>;
    const reviews = (reviewsRes.data ?? []) as unknown as Array<Record<string, unknown>>;

    // ── Management timeline with its model opinions ────────────────────
    const eventIds = eventRows.map((e) => String(e.id));
    const opinionsByEvent = new Map<string, ManagementEventView["opinions"]>();
    if (eventIds.length) {
      const { data: ops } = await db
        .from("paper_position_event_opinions")
        .select("event_id, role, provider, model, status, direction, confidence, summary, latency_ms, unavailable_reason")
        .in("event_id", eventIds);
      for (const rawOp of ops ?? []) {
        const o = rawOp as unknown as Record<string, unknown>;
        const list = opinionsByEvent.get(String(o.event_id)) ?? [];
        list.push({
          role: String(o.role),
          provider: String(o.provider),
          model: String(o.model),
          status: String(o.status),
          direction: (o.direction as string | null) ?? null,
          confidence: o.confidence == null ? null : Number(o.confidence),
          summary: (o.summary as string | null) ?? null,
          latencyMs: o.latency_ms == null ? null : Number(o.latency_ms),
          unavailableReason: (o.unavailable_reason as string | null) ?? null,
        });
        opinionsByEvent.set(String(o.event_id), list);
      }
    }

    const managementEvents: ManagementEventView[] = eventRows.map((e) => ({
      id: String(e.id),
      traceId: String(e.trace_id),
      parentTraceId: (e.parent_trace_id as string | null) ?? null,
      positionId: String(e.paper_position_id),
      symbol: String(e.symbol),
      direction: String(e.direction),
      sequence: Number(e.sequence ?? 0),
      trigger: String(e.trigger),
      participation: String(e.participation),
      degraded: Boolean(e.degraded),
      action: String(e.onyx_action),
      rationale: String(e.onyx_rationale ?? ""),
      riskPassed: Boolean(e.risk_passed),
      riskCode: (e.risk_code as string | null) ?? null,
      applied: Boolean(e.action_applied),
      applyBlockedReason: (e.apply_blocked_reason as string | null) ?? null,
      createdAt: String(e.created_at),
      opinions: opinionsByEvent.get(String(e.id)) ?? [],
    }));

    // ── Performance ────────────────────────────────────────────────────
    const wins = reviews.filter((r) => String(r.outcome) === "win").length;
    const losses = reviews.filter((r) => String(r.outcome) === "loss").length;
    const netPnl = reviews.reduce((s, r) => s + Number(r.pnl_net ?? 0), 0);
    const grossProfit = reviews.reduce((s, r) => s + Math.max(0, Number(r.pnl_net ?? 0)), 0);
    const grossLoss = reviews.reduce((s, r) => s + Math.max(0, -Number(r.pnl_net ?? 0)), 0);
    const fullParticipation = reviews.filter((r) => r.participation === "full_3_of_3").length;
    const degradedParticipation = reviews.length - fullParticipation;

    const modelMap = new Map<string, { scored: number; correct: number }>();
    for (const r of reviews) {
      const attribution = Array.isArray(r.model_attribution) ? (r.model_attribution as Array<Record<string, unknown>>) : [];
      for (const a of attribution) {
        if (a.correct == null) continue;
        const key = `${a.role ?? "seat"}:${a.model ?? "model"}`;
        const agg = modelMap.get(key) ?? { scored: 0, correct: 0 };
        agg.scored += 1;
        if (a.correct === true) agg.correct += 1;
        modelMap.set(key, agg);
      }
    }

    const performance: PerformanceView = {
      sampleSize: reviews.length,
      wins,
      losses,
      winRatePct: reviews.length ? Number(((wins / reviews.length) * 100).toFixed(1)) : 0,
      netPnl: Number(netPnl.toFixed(2)),
      expectancy: reviews.length ? Number((netPnl / reviews.length).toFixed(4)) : 0,
      profitFactor: profitFactor(grossProfit, grossLoss),
      maxDrawdownPct: maxDrawdownPct(reviews.map((r) => Number(r.pnl_net ?? 0))),
      fullParticipation,
      degradedParticipation,
      degradedRatePct: reviews.length ? Number(((degradedParticipation / reviews.length) * 100).toFixed(1)) : 0,
      unattributedTrades: reviews.filter((r) => r.unattributed === true).length,
      byStrategy: bucket(reviews, "strategy"),
      byRegime: bucket(reviews, "regime"),
      byModel: Array.from(modelMap.entries())
        .map(([key, a]) => ({
          key,
          scored: a.scored,
          correct: a.correct,
          accuracyPct: a.scored ? Number(((a.correct / a.scored) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.scored - a.scored),
    };

    // ── Trace integrity ────────────────────────────────────────────────
    const { count: positionsTotal } = await db
      .from("paper_positions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    const { count: positionsTraced } = await db
      .from("paper_positions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .not("orchestration_trace_id", "is", null);
    // Only positions opened AFTER the orchestration contract took effect for
    // this account count as violations; older rows are legacy and are never
    // back-filled with a fabricated trace.
    //
    // The boundary is DERIVED, not a hardcoded date: a wall-clock literal
    // straddles the moment the trigger actually landed and mislabels legacy
    // rows on the wrong side of it as violations. The first traced position
    // is the first observable proof the contract was in force, so untraced
    // rows at or after it are the only genuine violations. Past that point
    // the DB trigger makes an untraced insert impossible, so this figure is
    // expected to be 0 and is a check on the trigger, not a substitute.
    const { data: firstTracedRow } = await db
      .from("paper_positions")
      .select("created_at")
      .eq("user_id", userId)
      .not("orchestration_trace_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const contractSince = (firstTracedRow as { created_at?: string } | null)?.created_at ?? null;

    let missingTraceViolations = 0;
    if (contractSince != null) {
      const { count } = await db
        .from("paper_positions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("orchestration_trace_id", null)
        .gte("created_at", contractSince);
      missingTraceViolations = count ?? 0;
    }

    const executions = positionsTotal ?? 0;
    // Legacy rows predate the contract; counting them against integrity would
    // permanently understate a pipeline that is in fact compliant.
    const legacyUntraced = executions - (positionsTraced ?? 0) - missingTraceViolations;
    const inScope = executions - Math.max(0, legacyUntraced);
    const executionIntegrityPct = inScope > 0
      ? ((positionsTraced ?? 0) / inScope) * 100
      : 100;


    // ── Promotion gate (read-only, disabled) ───────────────────────────
    const gateRow = (gateRes.data ?? null) as Record<string, unknown> | null;
    const thresholds: PromotionThresholds = gateRow
      ? {
          minSampleSize: Number(gateRow.min_sample_size),
          minNetPnl: Number(gateRow.min_net_pnl),
          minExpectancy: Number(gateRow.min_expectancy),
          minProfitFactor: Number(gateRow.min_profit_factor),
          maxDrawdownPct: Number(gateRow.max_drawdown_pct),
          maxDegradedRatePct: Number(gateRow.max_degraded_rate_pct),
          requireZeroMissingTrace: Boolean(gateRow.require_zero_missing_trace),
          requireZeroRiskViolations: Boolean(gateRow.require_zero_risk_violations),
        }
      : DEFAULT_THRESHOLDS;

    const riskRuleViolations = orchestrations.filter((o) => o.terminal_outcome === "PIPELINE_ERROR").length;

    const metrics: PromotionMetrics = {
      sampleSize: performance.sampleSize,
      netPnl: performance.netPnl,
      expectancy: performance.expectancy,
      profitFactor: performance.profitFactor,
      maxDrawdownPct: performance.maxDrawdownPct,
      degradedRatePct: performance.degradedRatePct,
      missingTraceViolations,
      riskRuleViolations,
      executionIntegrityPct,
    };

    const promotion: PromotionEvaluation = evaluatePromotion(metrics, thresholds, {
      ownerApproved: Boolean(gateRow?.owner_approved),
      agenticLiveEnabled: Boolean(gateRow?.agentic_live_enabled),
      // Owner-set is asserted only by an explicit approval action.
      thresholdsAreOwnerSet: Boolean(gateRow?.owner_approved_at),
    });

    // ── Agent health ───────────────────────────────────────────────────
    const heartbeat = (heartbeatRes.data ?? null) as Record<string, unknown> | null;
    const lastOrchestration = orchestrations[0]?.created_at as string | undefined;
    const lastEvent = eventRows[0]?.created_at as string | undefined;
    const recentDegraded = orchestrations.slice(0, 10).filter((o) => o.degraded).length;
    const fresh = (iso: string | undefined, minutes: number) =>
      iso != null && Date.now() - new Date(iso).getTime() < minutes * 60_000;

    // Heartbeat visibility is admin-gated by RLS, so "no row" has two very
    // different meanings: the worker is silent, or this account simply may
    // not see it. Reporting the second as "unavailable" would state a
    // falsehood about the worker, so the two are kept apart.
    const heartbeatVisible = heartbeatRes.error == null;
    const heartbeatSeenAt = (heartbeat?.last_seen_at as string | null) ?? null;
    const heartbeatFresh = fresh(heartbeatSeenAt ?? undefined, 15);
    const health: AgentHealth[] = [
      {
        agent: "Scout surveillance",
        state: !heartbeatVisible ? "degraded"
          : heartbeat == null ? "unavailable"
          : heartbeatFresh ? "healthy" : "degraded",
        lastRunAt: heartbeatSeenAt,
        latencyMs: null,
        detail: !heartbeatVisible
          ? "worker heartbeat not visible to this account"
          : heartbeat == null
            ? "no worker heartbeat recorded"
            : `worker ${String(heartbeat.worker_id)} — ${String(heartbeat.status)}`
              + (heartbeat.version ? ` @ ${String(heartbeat.version)}` : "")
              + (heartbeatFresh ? "" : " (stale)"),
      },
      {
        agent: "Strategy evaluators",
        state: fresh(lastOrchestration, 30) ? "healthy" : orchestrations.length ? "degraded" : "unavailable",
        lastRunAt: lastOrchestration ?? null,
        latencyMs: null,
        detail: `${orchestrations.length} recent candidates orchestrated`,
      },
      {
        agent: "Three-model advisory",
        state: recentDegraded === 0 ? "healthy" : recentDegraded < 10 ? "degraded" : "unavailable",
        lastRunAt: lastOrchestration ?? null,
        latencyMs: null,
        detail: `${recentDegraded}/10 recent orchestrations ran degraded`,
      },
      {
        agent: "ONYX synthesis",
        state: orchestrations.length ? "healthy" : "unavailable",
        lastRunAt: lastOrchestration ?? null,
        latencyMs: null,
        detail: `${orchestrations.filter((o) => o.onyx_decision === "enter").length} enter decisions in window`,
      },
      {
        agent: "Consolidated risk",
        state: orchestrations.some((o) => o.risk_passed) ? "healthy" : orchestrations.length ? "degraded" : "unavailable",
        lastRunAt: lastOrchestration ?? null,
        latencyMs: null,
        detail: `${orchestrations.filter((o) => o.terminal_outcome === "NO_TRADE_RISK").length} risk rejections in window`,
      },
      {
        agent: "Position management",
        state: fresh(lastEvent, 120) ? "healthy" : managementEvents.length ? "degraded" : "unavailable",
        lastRunAt: lastEvent ?? null,
        latencyMs: null,
        detail: `${managementEvents.length} re-evaluations recorded`,
      },
      {
        agent: "Review / learning",
        state: reviews.length ? "healthy" : "unavailable",
        lastRunAt: (reviews[reviews.length - 1]?.closed_at as string | null) ?? null,
        latencyMs: null,
        detail: `${reviews.length} closed trades attributed`,
      },
    ];

    const pipeline = {
      scout: heartbeat ? 1 : 0,
      candidates: orchestrations.length,
      advisory: orchestrations.filter((o) => o.participation !== "ai_unavailable").length,
      onyxEnter: orchestrations.filter((o) => o.onyx_decision === "enter").length,
      riskPassed: orchestrations.filter((o) => o.risk_passed).length,
      executed: orchestrations.filter((o) => o.paper_position_id != null).length,
      waits: orchestrations.filter((o) => o.onyx_decision === "wait").length,
      rejected: orchestrations.filter((o) => o.onyx_decision === "reject").length,
      degraded: orchestrations.filter((o) => o.degraded).length,
    };

    const proposals: RuleProposalView[] = ((proposalsRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((p) => ({
      id: String(p.id),
      scope: String(p.scope),
      title: String(p.title),
      rationale: String(p.rationale ?? ""),
      sampleSize: Number(p.sample_size ?? 0),
      status: String(p.status),
      createdAt: String(p.created_at),
    }));

    return {
      pipeline,
      health,
      managementEvents,
      performance,
      promotion,
      promotionMetrics: metrics,
      proposals,
      integrity: {
        executions,
        traced: positionsTraced ?? 0,
        legacyUntraced: Math.max(0, legacyUntraced),
        missingTraceViolations,
        executionIntegrityPct: Number(executionIntegrityPct.toFixed(1)),
      },
    };
  });
