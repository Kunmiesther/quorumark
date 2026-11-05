// Owner/client-facing reads for the mandatory paper AI orchestration trail.
// RLS-scoped: a user only ever sees their own traces and opinions.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { pendingSchema } from "@/lib/decision/pendingTables";

export interface PaperSeatOpinion {
  role: string;
  provider: string;
  model: string;
  status: string;
  direction: string | null;
  confidence: number | null;
  summary: string | null;
  riskFlags: string[];
  latencyMs: number | null;
  unavailableReason: string | null;
}

export interface PaperOrchestrationEntry {
  traceId: string;
  symbol: string;
  direction: string;
  strategy: string;
  createdAt: string;
  participation: string;
  degraded: boolean;
  degradedReason: string | null;
  committeeVerdict: string | null;
  onyxDecision: string;
  onyxRationale: string;
  onyxConfidence: number | null;
  riskPassed: boolean;
  riskCode: string | null;
  terminalOutcome: string;
  paperPositionId: string | null;
  paperTradeId: string | null;
  opinions: PaperSeatOpinion[];
}

export interface PaperParticipationMetrics {
  full3of3: number;
  degraded2of3: number;
  degraded1of3: number;
  aiUnavailable: number;
  tradeCandidates: number;
  waitDecisions: number;
  orchestrations: number;
  missingTraceViolations: number;
}

export const listPaperOrchestrations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { limit?: number } | undefined) => ({
    limit: Math.min(Math.max(input?.limit ?? 20, 1), 50),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: rows } = await pendingSchema(supabase)
      .from("paper_ai_orchestrations")
      .select(
        "trace_id, symbol, direction, strategy, created_at, participation, degraded, degraded_reason, " +
          "committee_verdict, onyx_decision, onyx_rationale, onyx_confidence, risk_passed, risk_code, " +
          "terminal_outcome, paper_position_id, paper_trade_id",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);

    const traceIds = (rows ?? []).map((r) => String((r as unknown as Record<string, unknown>).trace_id));
    const opinionsByTrace = new Map<string, PaperSeatOpinion[]>();
    if (traceIds.length) {
      const { data: opinions } = await pendingSchema(supabase)
        .from("paper_ai_opinions")
        .select(
          "trace_id, role, provider, model, status, direction, confidence, summary, risk_flags, latency_ms, unavailable_reason",
        )
        .in("trace_id", traceIds);
      for (const raw of opinions ?? []) {
        const o = raw as unknown as Record<string, unknown>;
        const list = opinionsByTrace.get(String(o.trace_id)) ?? [];
        list.push({
          role: String(o.role),
          provider: String(o.provider),
          model: String(o.model),
          status: String(o.status),
          direction: (o.direction as string | null) ?? null,
          confidence: o.confidence == null ? null : Number(o.confidence),
          summary: (o.summary as string | null) ?? null,
          riskFlags: (o.risk_flags as string[] | null) ?? [],
          latencyMs: o.latency_ms == null ? null : Number(o.latency_ms),
          unavailableReason: (o.unavailable_reason as string | null) ?? null,
        });
        opinionsByTrace.set(String(o.trace_id), list);
      }
    }

    const { data: metricsRaw } = await pendingSchema(supabase)
      .from("paper_ai_participation_metrics")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    const metricsRow = (metricsRaw ?? null) as Record<string, unknown> | null;

    const metrics: PaperParticipationMetrics = {
      full3of3: Number(metricsRow?.full_3_of_3 ?? 0),
      degraded2of3: Number(metricsRow?.degraded_2_of_3 ?? 0),
      degraded1of3: Number(metricsRow?.degraded_1_of_3 ?? 0),
      aiUnavailable: Number(metricsRow?.ai_unavailable ?? 0),
      tradeCandidates: Number(metricsRow?.trade_candidates ?? 0),
      waitDecisions: Number(metricsRow?.wait_decisions ?? 0),
      orchestrations: Number(metricsRow?.orchestrations ?? 0),
      missingTraceViolations: Number(metricsRow?.missing_trace_violations ?? 0),
    };

    const entries: PaperOrchestrationEntry[] = (rows ?? []).map((row) => {
      const r = row as unknown as Record<string, unknown>;
      return {
      traceId: String(r.trace_id),
      symbol: String(r.symbol),
      direction: String(r.direction),
      strategy: String(r.strategy),
      createdAt: String(r.created_at),
      participation: String(r.participation),
      degraded: Boolean(r.degraded),
      degradedReason: (r.degraded_reason as string | null) ?? null,
      committeeVerdict: (r.committee_verdict as string | null) ?? null,
      onyxDecision: String(r.onyx_decision),
      onyxRationale: String(r.onyx_rationale ?? ""),
      onyxConfidence: r.onyx_confidence == null ? null : Number(r.onyx_confidence),
      riskPassed: Boolean(r.risk_passed),
      riskCode: (r.risk_code as string | null) ?? null,
      terminalOutcome: String(r.terminal_outcome),
      paperPositionId: (r.paper_position_id as string | null) ?? null,
      paperTradeId: (r.paper_trade_id as string | null) ?? null,
      opinions: opinionsByTrace.get(String(r.trace_id)) ?? [],
    };
    });

    return { entries, metrics };
  });
