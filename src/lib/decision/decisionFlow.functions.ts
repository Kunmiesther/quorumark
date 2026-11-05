/**
 * Live Decision Flow server functions.
 *
 * AUTHORITY: NONE. Every handler is read-only with respect to trading. The
 * only writes reachable from this module are the advisory AI opinion ledger
 * and a typed diagnostic audit row in `bot_events`. No signer, broker,
 * exchange credential, order-intent write, or ApeX call is imported here or
 * transitively.
 *
 * WHAT CHANGED AND WHY: this used to read `PAPER_TICK_REASONS` — an event
 * emitted by the PAPER engine — and present it as the live worker's decision.
 * The panel was showing paper-simulation reasons under a "live" heading. It
 * now reads `strategy_decisions`, which only the live worker writes.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  DEFAULT_FLOW_SYMBOL,
  deriveFlowSteps,
  deriveSeats,
  flowHeadline,
  parseDecisionRow,
  parseOpinionRow,
  type AiOpinion,
  type DecisionFlowDto,
  type DecisionRecord,
  type DecisionRoomEntry,
} from "@/lib/decision/decisionFlow";
import {
  SHADOW_CHECK_COOLDOWN_MS,
  SHADOW_CHECK_EVENT,
  type ShadowCheckResult,
} from "@/lib/decision/shadowCheck.server.types";
import { pendingSchema } from "@/lib/decision/pendingTables";
import {
  deriveWorkerHealth,
  PRODUCTION_LIVE_SELECTOR,
  WORKER_HEARTBEAT_COLUMNS,
  type WorkerHeartbeatRow,
} from "@/lib/health/workerHealth";

export const DECISION_COLUMNS =
  "decision_id, connection_id, symbol, strategy, armed_leg, timeframe, candle_close_at, " +
  "direction, reason_code, reason, entry_zone, invalidation, take_profits, evidence_hash, " +
  "execution_state, execution_reason_code, safety_checks, order_intent, apex_result, created_at, " +
  "trace_id, terminal_outcome, terminal_reason, terminal_at, simulated_intent";

export const OPINION_COLUMNS =
  "decision_id, role, provider, model, status, direction, confidence, summary, risk_flags, " +
  "latency_ms, prompt_version, evidence_hash, unavailable_reason, evaluated_at";

/** Authoritative, validated projection for one symbol's newest decision. */
export const getLiveDecisionFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const symbol = String(i.symbol ?? DEFAULT_FLOW_SYMBOL)
      .trim()
      .slice(0, 32)
      .toUpperCase();
    return { symbol: symbol || DEFAULT_FLOW_SYMBOL };
  })
  .handler(async ({ data, context }): Promise<DecisionFlowDto> => {
    const nowMs = Date.now();
    const [heartbeatRes, decisionRes] = await Promise.all([
      context.supabase
        .from("worker_heartbeats")
        .select(WORKER_HEARTBEAT_COLUMNS)
        .eq("environment", PRODUCTION_LIVE_SELECTOR.environment)
        .order("last_seen_at", { ascending: false })
        .limit(50),
      pendingSchema(context.supabase)
        .from("strategy_decisions")
        .select(DECISION_COLUMNS)
        .eq("symbol", data.symbol)
        .order("candle_close_at", { ascending: false })
        .limit(1),
    ]);

    const rows = (heartbeatRes.data ?? []) as WorkerHeartbeatRow[];
    const worker = deriveWorkerHealth(rows, nowMs, PRODUCTION_LIVE_SELECTOR);
    const { healthPayload: _ignored, ...workerSafe } = worker;

    const decision: DecisionRecord | null = parseDecisionRow((decisionRes.data ?? [])[0]);

    let opinions: AiOpinion[] = [];
    if (decision) {
      const { data: opinionRows } = await pendingSchema(context.supabase)
        .from("ai_decision_opinions")
        .select(OPINION_COLUMNS)
        .eq("decision_id", decision.decisionId);
      opinions = (opinionRows ?? [])
        .map(parseOpinionRow)
        .filter((o): o is AiOpinion => o !== null);
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      symbol: data.symbol,
      worker: workerSafe,
      decision,
      opinions,
      seats: deriveSeats(decision, opinions),
      steps: deriveFlowSteps({ worker: workerSafe, decision, nowMs }),
      headline: flowHeadline(decision),
    };
  });

/**
 * Ask the three committee seats about one recorded decision.
 *
 * NON-BLOCKING BY CONSTRUCTION: this runs in the web process, which has no
 * import path and no network route to the worker, the broker, the signer, or
 * ApeX. It cannot delay a trade, because the trade was already decided and
 * either submitted or not, in a different process, before this is ever
 * called. Its only effect is to append advisory rows.
 *
 * Idempotent on (decision_id, role, evidence_hash), so polling this on every
 * refresh re-reads the stored opinions instead of re-spending model budget.
 */
export const evaluateDecisionCommittee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const decisionId = String(i.decisionId ?? "").trim();
    if (!decisionId) throw new Error("decisionId is required");
    return { decisionId: decisionId.slice(0, 64) };
  })
  .handler(async ({ data, context }): Promise<AiOpinion[]> => {
    const { evaluateDecision } = await import("@/lib/ai/committee/decisionEvaluate.server");
    return evaluateDecision(context.supabase, context.userId, data.decisionId);
  });

/**
 * Owner-only connectivity proof: one synthetic TEST snapshot through all
 * three seats. Cannot create a decision, an order intent, or reach ApeX, and
 * its result is never mixed into decision history.
 *
 * This is a DIAGNOSTIC. It is not, and must never be presented as, evidence
 * that the committee evaluated a real candle.
 */
export const runShadowAiCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShadowCheckResult> => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (isAdmin !== true) throw new Error("forbidden: owner only");

    const since = new Date(Date.now() - SHADOW_CHECK_COOLDOWN_MS).toISOString();
    const { data: recent } = await context.supabase
      .from("bot_events")
      .select("id")
      .eq("user_id", context.userId)
      .eq("event", SHADOW_CHECK_EVENT)
      .gte("created_at", since)
      .limit(1);
    if ((recent ?? []).length > 0) {
      throw new Error("Rate limited — one shadow AI check per minute.");
    }

    const nowMs = Date.now();
    const { runShadowSelfTest } = await import("@/lib/decision/shadowCheck.server");
    const result = await runShadowSelfTest(nowMs);

    await context.supabase.from("bot_events").insert({
      user_id: context.userId,
      level: "info",
      event: SHADOW_CHECK_EVENT,
      detail: {
        diagnostic: true,
        test_candidate_id: result.testCandidateId,
        total_latency_ms: result.totalLatencyMs,
        seats: result.outcomes.map((o) => ({
          role: o.role,
          model: o.model,
          available: o.available,
          latency_ms: o.latencyMs,
        })),
      },
    });

    return result;
  });

/**
 * AI DECISION ROOM — the recent, real, stored evaluations.
 *
 * READ-ONLY. Returns exactly what is persisted: the deterministic signal,
 * each seat's status/direction/confidence/rationale (or its recorded reason
 * for being unavailable), the consolidated orchestration verdict, the risk
 * check, and the terminal outcome. Nothing is inferred, simulated or
 * animated — an empty list means the system has recorded nothing yet.
 */
export const listDecisionRoom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const n = Number(i.limit);
    return { limit: Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 50) : 15 };
  })
  .handler(async ({ data, context }) => {
    const { data: decisionRows } = await pendingSchema(context.supabase)
      .from("strategy_decisions")
      .select(DECISION_COLUMNS + ", risk_check")
      .order("candle_close_at", { ascending: false })
      .limit(data.limit);

    const decisions = (decisionRows ?? []) as unknown as Array<Record<string, unknown>>;
    const ids = decisions.map((d) => String(d.decision_id));
    if (ids.length === 0) {
      return { generatedAt: new Date().toISOString(), entries: [] as DecisionRoomEntry[] };
    }

    const [{ data: opinionRows }, { data: evalRows }] = await Promise.all([
      pendingSchema(context.supabase)
        .from("ai_decision_opinions")
        .select(OPINION_COLUMNS)
        .in("decision_id", ids),
      context.supabase
        .from("ai_committee_evaluations")
        .select(
          "candidate_id, verdict, consensus_direction, consensus_confidence, " +
            "available_roles, unavailable_roles, risk_dissent, risk_flags",
        )
        .in("candidate_id", ids),
    ]);

    const byDecision = new Map<string, AiOpinion[]>();
    for (const raw of opinionRows ?? []) {
      const parsed = parseOpinionRow(raw);
      if (!parsed) continue;
      const list = byDecision.get(parsed.decisionId) ?? [];
      list.push(parsed);
      byDecision.set(parsed.decisionId, list);
    }
    const evalByDecision = new Map<string, Record<string, unknown>>();
    for (const raw of (evalRows ?? []) as unknown as Array<Record<string, unknown>>) {
      evalByDecision.set(String(raw.candidate_id), raw);
    }

    const entries: DecisionRoomEntry[] = decisions.map((row) => {
      const decision = parseDecisionRow(row);
      const id = String(row.decision_id);
      const risk = (row.risk_check ?? null) as Record<string, unknown> | null;
      const summary = evalByDecision.get(id) ?? null;
      return {
        decisionId: id,
        traceId: row.trace_id == null ? null : String(row.trace_id),
        symbol: String(row.symbol ?? ""),
        timeframe: String(row.timeframe ?? "15m"),
        strategy: String(row.strategy ?? ""),
        candleCloseAt: String(row.candle_close_at ?? ""),
        deterministicDirection: String(row.direction ?? "wait"),
        deterministicReason: String(row.reason ?? row.reason_code ?? ""),
        opinions: byDecision.get(id) ?? [],
        orchestration: summary
          ? {
              verdict: String(summary.verdict ?? ""),
              consensusDirection:
                summary.consensus_direction == null ? null : String(summary.consensus_direction),
              consensusConfidence:
                summary.consensus_confidence == null ? null : Number(summary.consensus_confidence),
              availableRoles: (summary.available_roles ?? []) as string[],
              unavailableRoles: (summary.unavailable_roles ?? []) as string[],
              riskDissent: Boolean(summary.risk_dissent),
            }
          : null,
        risk: risk
          ? {
              passed: Boolean(risk.passed),
              code: String(risk.code ?? ""),
              detail: String(risk.detail ?? ""),
            }
          : null,
        terminalOutcome: row.terminal_outcome == null ? null : String(row.terminal_outcome),
        terminalReason: row.terminal_reason == null ? null : String(row.terminal_reason),
        executionState: decision?.executionState ?? "not_reached",
      };
    });

    return { generatedAt: new Date().toISOString(), entries };
  });
