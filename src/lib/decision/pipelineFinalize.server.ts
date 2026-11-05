// SERVER-ONLY pipeline finalizer — VALIDATION MODE, zero trading authority.
//
// WHY THIS EXISTS: every stage of the pipeline was persisted somewhere
// (decision, AI opinions, execution attempt), but nothing wrote a single
// TERMINAL outcome per evaluation. Evaluations could therefore appear to
// vanish between stages: a WAIT looked identical to a crash, and a tradeable
// decision that a risk condition stopped left no record naming the condition.
//
// AUTHORITY: NONE. This runs in the web process. It has no import edge and no
// network route to the worker, broker, signer or ApeX. It NEVER submits,
// signs, sizes, cancels or modifies a live order. The "intent" it writes is a
// SIMULATION stored on the decision row itself — it is not an `order_intents`
// row and cannot be picked up by any execution path.
//
// AI IS ADVISORY, STRUCTURALLY: the AI opinions are read here purely to be
// recorded alongside the outcome. No branch below reads a model's direction,
// confidence or availability. An absent, slow, malformed, disagreeing or
// quota-exhausted provider cannot change the terminal outcome by construction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pendingSchema } from "@/lib/decision/pendingTables";

export const TERMINAL_OUTCOMES = [
  "TRADE_CANDIDATE",
  "NO_TRADE_STRATEGY",
  "NO_TRADE_RISK",
  "PIPELINE_ERROR",
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/** A completed candle older than this cannot describe the current market. */
export const MARKET_FRESHNESS_MS = 15 * 60_000;

export interface RiskCheckResult {
  passed: boolean;
  code: string;
  detail: string;
  checks: Array<{ key: string; passed: boolean; code: string; detail: string }>;
}

export interface FinalizeResult {
  decisionId: string;
  symbol: string;
  traceId: string;
  outcome: TerminalOutcome;
  reason: string;
  risk: RiskCheckResult | null;
  intentStatus: "VALIDATED" | "REJECTED" | null;
  alreadyFinal: boolean;
}

const DECISION_COLUMNS =
  "decision_id, user_id, connection_id, symbol, strategy, timeframe, candle_close_at, " +
  "direction, reason_code, reason, entry_zone, invalidation, take_profits, evidence_hash, " +
  "execution_state, execution_reason_code, order_intent, trace_id, terminal_outcome";

interface DecisionRow {
  decision_id: string;
  user_id: string;
  connection_id: string;
  symbol: string;
  strategy: string;
  timeframe: string;
  candle_close_at: string;
  direction: string;
  reason_code: string;
  reason: string;
  entry_zone: { low: number; high: number } | null;
  invalidation: number | null;
  take_profits: number[] | null;
  evidence_hash: string;
  execution_state: string;
  execution_reason_code: string | null;
  order_intent: Record<string, unknown> | null;
  trace_id: string | null;
  terminal_outcome: string | null;
}

/**
 * ONE consolidated decision check.
 *
 * Everything that can legitimately stop a tradeable decision is evaluated
 * here, once, in one place: connection readiness, trading permission,
 * emergency halt, exposure/duplicate protection, and market freshness.
 * Nothing outside this function may independently halt an evaluation, and
 * nothing inside it is re-checked twice.
 */
export async function runConsolidatedRiskCheck(
  reader: SupabaseClient,
  row: DecisionRow,
  nowMs: number,
): Promise<RiskCheckResult> {
  const checks: RiskCheckResult["checks"] = [];
  const add = (key: string, passed: boolean, code: string, detail: string) => {
    checks.push({ key, passed, code, detail });
  };

  // 1 + 2. Connection readiness AND trading permission — one read, one gate.
  const { data: conn } = await reader
    .from("exchange_connections")
    .select("status, is_live, permission_trade, permissions_verified, environment, market_type")
    .eq("id", row.connection_id)
    .maybeSingle();
  const connReady =
    !!conn && conn.status === "verified" && conn.permission_trade === true &&
    conn.permissions_verified === true;
  add(
    "connection_ready",
    connReady,
    connReady ? "OK" : conn ? "CONNECTION_NOT_TRADE_READY" : "CONNECTION_MISSING",
    conn
      ? `status=${conn.status} trade=${conn.permission_trade} verified=${conn.permissions_verified} env=${conn.environment}`
      : "no exchange_connections row for this decision",
  );

  // 3. Emergency halt.
  const { data: halts } = await reader
    .from("kill_switches")
    .select("scope, active, reason")
    .eq("user_id", row.user_id)
    .eq("active", true);
  const halted = (halts ?? []).length > 0;
  add(
    "not_halted",
    !halted,
    halted ? "EMERGENCY_HALT_ACTIVE" : "OK",
    halted ? (halts ?? []).map((h) => `${h.scope}:${h.reason ?? ""}`).join(", ") : "no active kill switch",
  );

  // 4. Duplicate / conflicting exposure protection for this symbol.
  const { data: open } = await reader
    .from("positions")
    .select("id, pair, side, status")
    .eq("user_id", row.user_id)
    .eq("connection_id", row.connection_id)
    .eq("status", "open");
  const conflicting = (open ?? []).filter((p) => p.pair === row.symbol);
  add(
    "no_duplicate_exposure",
    conflicting.length === 0,
    conflicting.length === 0 ? "OK" : "EXISTING_EXPOSURE",
    conflicting.length === 0
      ? "no open position on this symbol"
      : `${conflicting.length} open position(s) on ${row.symbol}`,
  );

  // 5. Market freshness — the candle this decision was made on.
  const closedMs = Date.parse(row.candle_close_at);
  const fresh = Number.isFinite(closedMs) && nowMs - closedMs <= MARKET_FRESHNESS_MS;
  add(
    "market_data_fresh",
    fresh,
    fresh ? "OK" : "MARKET_DATA_STALE",
    Number.isFinite(closedMs)
      ? `candle closed ${Math.round((nowMs - closedMs) / 1000)}s ago`
      : "unparseable candle_close_at",
  );

  const failed = checks.find((c) => !c.passed);
  return {
    passed: !failed,
    code: failed ? failed.code : "OK",
    detail: failed ? failed.detail : "all consolidated checks passed",
    checks,
  };
}

/**
 * Finalize one decision: consolidated risk check, terminal outcome, and — for
 * a TRADE_CANDIDATE — a SIMULATED intent that advances to VALIDATED or
 * REJECTED with an exact reason. Never submits.
 *
 * Idempotent: a decision that already carries a terminal outcome is returned
 * unchanged, so a replayed sweep cannot create a second simulated intent.
 */
export async function finalizeDecision(
  ledger: SupabaseClient,
  decisionId: string,
  opinionCount: number,
): Promise<FinalizeResult | null> {
  const { data } = await pendingSchema(ledger)
    .from("strategy_decisions")
    .select(DECISION_COLUMNS)
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as DecisionRow;

  const traceId = row.trace_id ?? crypto.randomUUID();

  if (row.terminal_outcome) {
    return {
      decisionId,
      symbol: row.symbol,
      traceId,
      outcome: row.terminal_outcome as TerminalOutcome,
      reason: "already final",
      risk: null,
      intentStatus: null,
      alreadyFinal: true,
    };
  }

  const nowMs = Date.now();
  let outcome: TerminalOutcome;
  let reason: string;
  let risk: RiskCheckResult | null = null;
  let intent: Record<string, unknown> | null = null;
  let intentStatus: FinalizeResult["intentStatus"] = null;

  try {
    if (row.direction !== "long" && row.direction !== "short") {
      // A WAIT is a completed evaluation, not a failure.
      outcome = "NO_TRADE_STRATEGY";
      reason = row.reason_code;
    } else {
      risk = await runConsolidatedRiskCheck(ledger, row, nowMs);
      if (!risk.passed) {
        outcome = "NO_TRADE_RISK";
        reason = risk.code;
      } else {
        outcome = "TRADE_CANDIDATE";
        reason = row.reason_code;
        // VALIDATION MODE ONLY. Not an `order_intents` row; no execution path
        // reads this field.
        const zone = row.entry_zone;
        const sized = row.order_intent ?? null;
        const hasGeometry = !!zone && row.invalidation != null;
        intentStatus = hasGeometry ? "VALIDATED" : "REJECTED";
        intent = {
          mode: "validation",
          simulated: true,
          submitted: false,
          status: intentStatus,
          status_reason: hasGeometry
            ? "geometry and risk complete; live submission intentionally withheld"
            : "MISSING_ENTRY_GEOMETRY",
          trace_id: traceId,
          symbol: row.symbol,
          side: row.direction === "long" ? "BUY" : "SELL",
          entry_zone: zone,
          invalidation: row.invalidation,
          take_profits: row.take_profits ?? [],
          // Echoed from the worker's own record — never recomputed here, so
          // leverage, allocation and DCA geometry are untouched.
          worker_intent: sized,
          created_at: new Date(nowMs).toISOString(),
        };
      }
    }
  } catch (e) {
    outcome = "PIPELINE_ERROR";
    reason = (e as Error).message.slice(0, 200);
  }

  await pendingSchema(ledger)
    .from("strategy_decisions")
    .update({
      trace_id: traceId,
      terminal_outcome: outcome,
      terminal_reason: reason,
      terminal_at: new Date(nowMs).toISOString(),
      risk_check: risk
        ? ({ ...risk, ai_opinions_recorded: opinionCount, ai_advisory_only: true } as never)
        : ({ skipped: true, why: "direction is wait", ai_opinions_recorded: opinionCount } as never),
      simulated_intent: intent as never,
    })
    .eq("decision_id", decisionId);

  return {
    decisionId,
    symbol: row.symbol,
    traceId,
    outcome,
    reason,
    risk,
    intentStatus,
    alreadyFinal: false,
  };
}
