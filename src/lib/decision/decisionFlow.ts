/**
 * Live Decision Flow view-model — PURE, client-safe, no I/O.
 *
 * AUTHORITY: NONE. This module projects persisted proof into a display
 * model. It never infers a transition, never fabricates an AI call, and
 * never touches signer, broker, order or credential code.
 *
 * THE FLOW IS FOUR STEPS AND ONLY FOUR:
 *
 *     MARKET  ->  DECISION  ->  SAFETY  ->  APEX
 *
 * The AI committee is NOT a step. It is displayed beside the flow as three
 * independent opinions, because it cannot delay, approve, reject, size, sign
 * or submit anything. Rendering it inline as a stage was the interface
 * telling a lie about where authority lives.
 *
 * BANNED PHRASING — every one of these described something that was not
 * happening, and none of them may come back:
 *   "Order intent inactive"          -> the intent has a named state
 *   "AI approved the trade"          -> AI approves nothing, ever
 *   "No decision"                    -> a WAIT decision is a decision
 *   "AI unavailable" when unasked    -> "not asked" and "asked, down" differ
 *   "Execution rejected" when unreached -> "not reached" is its own state
 */

import { z } from "zod";
import type { WorkerHealth } from "@/lib/health/workerHealth";

export const FLOW_SYMBOLS = ["ETH-USDT", "BTC-USDT", "SOL-USDT"] as const;
export const DEFAULT_FLOW_SYMBOL = "ETH-USDT";

export const DIRECTIONS = ["long", "short", "wait"] as const;
export type FlowDirection = (typeof DIRECTIONS)[number];

/** Traffic-light state. `gray` means "not reached / no proof", never "ok". */
export type FlowStatus = "green" | "amber" | "red" | "gray";

export const FLOW_STEP_KEYS = ["market", "decision", "safety", "apex"] as const;
export type FlowStepKey = (typeof FLOW_STEP_KEYS)[number];

export interface FlowStep {
  key: FlowStepKey;
  label: string;
  status: FlowStatus;
  headline: string;
  detail: string;
}

/* ------------------------------------------------------------------ *
 * Persisted shapes
 * ------------------------------------------------------------------ */

export const EXECUTION_STATES = [
  "not_reached",
  "blocked",
  "intent_created",
  "submitted",
  "ambiguous",
  "rejected",
  "filled",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const SAFETY_CHECK_KEYS = [
  "connection_verified",
  "equity_usable",
  "no_conflicting_exposure",
  "order_params_valid",
] as const;
export type SafetyCheckKey = (typeof SAFETY_CHECK_KEYS)[number];

const safetyCheckSchema = z.object({
  key: z.enum(SAFETY_CHECK_KEYS),
  label: z.string(),
  // null = not evaluated because an earlier check failed. Never a pass.
  passed: z.boolean().nullable(),
  code: z.string().nullish(),
  detail: z.string().nullish(),
});

const safetySchema = z.object({
  passed: z.boolean(),
  block_code: z.string().nullish(),
  block_detail: z.string().nullish(),
  checks: z.array(safetyCheckSchema),
});

const apexResultSchema = z.object({
  status: z.string().nullish(),
  exchange_order_id: z.string().nullish(),
  exchange_status: z.string().nullish(),
  reject_reason: z.string().nullish(),
});

const orderIntentSchema = z.object({
  idempotency_key: z.string(),
  side: z.string(),
  size: z.number().nullish(),
  leverage: z.number().nullish(),
  stop_pct: z.number().nullish(),
});

const decisionRowSchema = z.object({
  decision_id: z.string(),
  connection_id: z.string(),
  symbol: z.string(),
  strategy: z.string(),
  armed_leg: z.string().nullish(),
  timeframe: z.string(),
  candle_close_at: z.string(),
  direction: z.enum(DIRECTIONS),
  reason_code: z.string(),
  reason: z.string(),
  entry_zone: z.object({ low: z.number(), high: z.number() }).nullish(),
  invalidation: z.coerce.number().nullish(),
  take_profits: z.array(z.coerce.number()).nullish(),
  evidence_hash: z.string(),
  execution_state: z.enum(EXECUTION_STATES),
  execution_reason_code: z.string().nullish(),
  safety_checks: safetySchema.nullish(),
  order_intent: orderIntentSchema.nullish(),
  apex_result: apexResultSchema.nullish(),
  created_at: z.string().nullish(),
  trace_id: z.string().nullish(),
  terminal_outcome: z
    .enum(["TRADE_CANDIDATE", "NO_TRADE_STRATEGY", "NO_TRADE_RISK", "PIPELINE_ERROR"])
    .nullish(),
  terminal_reason: z.string().nullish(),
  terminal_at: z.string().nullish(),
  simulated_intent: z
    .object({ status: z.string().nullish(), status_reason: z.string().nullish() })
    .nullish(),
});

export type TerminalOutcome =
  "TRADE_CANDIDATE" | "NO_TRADE_STRATEGY" | "NO_TRADE_RISK" | "PIPELINE_ERROR";

export interface SafetyCheckView {
  key: SafetyCheckKey;
  label: string;
  passed: boolean | null;
  code: string | null;
  detail: string | null;
}

export interface DecisionRecord {
  decisionId: string;
  connectionId: string;
  symbol: string;
  strategy: string;
  armedLeg: string | null;
  timeframe: string;
  candleCloseAt: string;
  direction: FlowDirection;
  reasonCode: string;
  reason: string;
  entryZone: { low: number; high: number } | null;
  invalidation: number | null;
  takeProfits: number[];
  evidenceHash: string;
  executionState: ExecutionState;
  executionReasonCode: string | null;
  safety: {
    passed: boolean;
    blockCode: string | null;
    blockDetail: string | null;
    checks: SafetyCheckView[];
  } | null;
  orderIntent: {
    idempotencyKey: string;
    side: string;
    size: number | null;
    leverage: number | null;
    stopPct: number | null;
  } | null;
  traceId: string | null;
  terminalOutcome: TerminalOutcome | null;
  terminalReason: string | null;
  terminalAt: string | null;
  simulatedIntent: { status: string | null; statusReason: string | null } | null;
  apexResult: {
    status: string | null;
    exchangeOrderId: string | null;
    exchangeStatus: string | null;
    rejectReason: string | null;
  } | null;
  createdAt: string | null;
}

/** Parse one persisted decision row. Returns null when it does not validate. */
export function parseDecisionRow(row: unknown): DecisionRecord | null {
  const parsed = decisionRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    decisionId: r.decision_id,
    connectionId: r.connection_id,
    symbol: r.symbol,
    strategy: r.strategy,
    armedLeg: r.armed_leg ?? null,
    timeframe: r.timeframe,
    candleCloseAt: r.candle_close_at,
    direction: r.direction,
    reasonCode: r.reason_code,
    reason: r.reason,
    entryZone: r.entry_zone ?? null,
    invalidation: r.invalidation ?? null,
    takeProfits: r.take_profits ?? [],
    evidenceHash: r.evidence_hash,
    executionState: r.execution_state,
    executionReasonCode: r.execution_reason_code ?? null,
    safety: r.safety_checks
      ? {
          passed: r.safety_checks.passed,
          blockCode: r.safety_checks.block_code ?? null,
          blockDetail: r.safety_checks.block_detail ?? null,
          checks: r.safety_checks.checks.map((c) => ({
            key: c.key,
            label: c.label,
            passed: c.passed,
            code: c.code ?? null,
            detail: c.detail ?? null,
          })),
        }
      : null,
    orderIntent: r.order_intent
      ? {
          idempotencyKey: r.order_intent.idempotency_key,
          side: r.order_intent.side,
          size: r.order_intent.size ?? null,
          leverage: r.order_intent.leverage ?? null,
          stopPct: r.order_intent.stop_pct ?? null,
        }
      : null,
    apexResult: r.apex_result
      ? {
          status: r.apex_result.status ?? null,
          exchangeOrderId: r.apex_result.exchange_order_id ?? null,
          exchangeStatus: r.apex_result.exchange_status ?? null,
          rejectReason: r.apex_result.reject_reason ?? null,
        }
      : null,
    createdAt: r.created_at ?? null,
    traceId: r.trace_id ?? null,
    terminalOutcome: r.terminal_outcome ?? null,
    terminalReason: r.terminal_reason ?? null,
    terminalAt: r.terminal_at ?? null,
    simulatedIntent: r.simulated_intent
      ? {
          status: r.simulated_intent.status ?? null,
          statusReason: r.simulated_intent.status_reason ?? null,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * AI opinions — advisory, displayed, never a step
 * ------------------------------------------------------------------ */

export const AI_ROLES = ["lead", "risk", "structure"] as const;
export type AiRole = (typeof AI_ROLES)[number];

const opinionRowSchema = z.object({
  decision_id: z.string(),
  role: z.enum(AI_ROLES),
  provider: z.string(),
  model: z.string(),
  status: z.enum(["evaluated", "unavailable"]),
  direction: z.enum(DIRECTIONS).nullish(),
  confidence: z.coerce.number().nullish(),
  summary: z.string().nullish(),
  risk_flags: z.array(z.string()).nullish(),
  latency_ms: z.number().nullish(),
  prompt_version: z.string(),
  evidence_hash: z.string(),
  unavailable_reason: z.string().nullish(),
  evaluated_at: z.string(),
});

export interface AiOpinion {
  decisionId: string;
  role: AiRole;
  provider: string;
  model: string;
  status: "evaluated" | "unavailable";
  direction: FlowDirection | null;
  confidence: number | null;
  summary: string | null;
  riskFlags: string[];
  latencyMs: number | null;
  promptVersion: string;
  evidenceHash: string;
  unavailableReason: string | null;
  evaluatedAt: string;
}

export function parseOpinionRow(row: unknown): AiOpinion | null {
  const parsed = opinionRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    decisionId: r.decision_id,
    role: r.role,
    provider: r.provider,
    model: r.model,
    status: r.status,
    direction: r.direction ?? null,
    confidence: r.confidence ?? null,
    summary: r.summary ?? null,
    riskFlags: r.risk_flags ?? [],
    latencyMs: r.latency_ms ?? null,
    promptVersion: r.prompt_version,
    evidenceHash: r.evidence_hash,
    unavailableReason: r.unavailable_reason ?? null,
    evaluatedAt: r.evaluated_at,
  };
}

/**
 * Display state for one seat. Distinguishes the three genuinely different
 * situations that used to collapse into "AI unavailable":
 *   not_asked  — no row exists; the committee has not run for this decision
 *   unavailable — asked, the provider did not answer
 *   evaluated  — asked and answered
 *
 * An `unavailable` seat is NEVER counted as agreement with the decision.
 */
export type SeatState = "evaluated" | "unavailable" | "not_asked";

export interface SeatView {
  role: AiRole;
  state: SeatState;
  provider: string | null;
  model: string | null;
  direction: FlowDirection | null;
  confidence: number | null;
  summary: string | null;
  riskFlags: string[];
  latencyMs: number | null;
  /** True when the seat answered AND matched the deterministic direction. */
  agreesWithDecision: boolean;
  /** Set only when the recorded evidence differs from the decision's. */
  staleEvidence: boolean;
}

export function deriveSeats(decision: DecisionRecord | null, opinions: AiOpinion[]): SeatView[] {
  return AI_ROLES.map((role): SeatView => {
    const found = opinions.find((o) => o.role === role) ?? null;
    if (!found) {
      return {
        role,
        state: "not_asked",
        provider: null,
        model: null,
        direction: null,
        confidence: null,
        summary: null,
        riskFlags: [],
        latencyMs: null,
        agreesWithDecision: false,
        staleEvidence: false,
      };
    }
    return {
      role,
      state: found.status,
      provider: found.provider,
      model: found.model,
      direction: found.direction,
      confidence: found.confidence,
      summary: found.status === "unavailable" ? (found.unavailableReason ?? null) : found.summary,
      riskFlags: found.riskFlags,
      latencyMs: found.latencyMs,
      // An unavailable seat can never agree. Reading silence as assent is
      // the single most dangerous thing this panel could do.
      agreesWithDecision:
        found.status === "evaluated" && decision !== null && found.direction === decision.direction,
      staleEvidence: decision !== null && found.evidenceHash !== decision.evidenceHash,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------ */

/** A decision older than this cannot describe the current market. */
export const DECISION_FRESHNESS_MS = 180_000;

export function decisionAgeMs(decision: DecisionRecord | null, nowMs: number): number | null {
  if (!decision) return null;
  const closed = Date.parse(decision.candleCloseAt);
  if (!Number.isFinite(closed)) return null;
  return Math.max(0, nowMs - closed);
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "—";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/* ------------------------------------------------------------------ *
 * Prose — one sentence per machine code, no invented meaning
 * ------------------------------------------------------------------ */

const REASON_PROSE: Record<string, string> = {
  LONG_CONFIRMED: "Long setup confirmed on the last completed candle",
  SHORT_CONFIRMED: "Short setup confirmed on the last completed candle",
  NO_CONFIRMED_ENTRY: "No confirmed entry on the last completed candle",
  REGIME_WAIT: "Regime guard is waiting — no new entries authorised",
  REGIME_UNAVAILABLE: "Regime could not be classified from this window",
  REENTRY_LOCKOUT: "Re-entry lockout is active for this symbol",
  STOP_DISTANCE_UNAVAILABLE: "No provable structural stop distance",
  EVALUATOR_NOT_WIRED: "Armed leg has no evaluator in this worker",
  TURTLE_NOT_ENABLED: "Routed Turtle is not enabled in this automation mandate",
  MARKET_DATA_UNAVAILABLE: "Market data was unusable for this candle",
  CANDLE_STALE: "Last completed candle is outside the freshness window",
  EVALUATOR_ERROR: "Strategy evaluator failed on this candle",
};

/** Human-readable reason. Falls back to the worker's own persisted text. */
export function reasonProse(reasonCode: string, reason: string): string {
  return reason || REASON_PROSE[reasonCode] || reasonCode;
}

const EXECUTION_PROSE: Record<ExecutionState, string> = {
  not_reached: "Execution not reached",
  blocked: "Stopped at a safety check",
  intent_created: "Intent created",
  submitted: "Submitted to ApeX",
  ambiguous: "Ambiguous — awaiting reconciliation",
  rejected: "Rejected",
  filled: "Filled",
};

export function executionProse(state: ExecutionState): string {
  return EXECUTION_PROSE[state];
}

/* ------------------------------------------------------------------ *
 * Step derivation — persisted proof only
 * ------------------------------------------------------------------ */

export type FlowWorkerHealth = Omit<WorkerHealth, "healthPayload">;

export interface DeriveStepsInput {
  worker: FlowWorkerHealth;
  decision: DecisionRecord | null;
  nowMs: number;
}

function marketStep({ worker, decision, nowMs }: DeriveStepsInput): FlowStep {
  if (!decision) {
    return {
      key: "market",
      label: "Market",
      status: "gray",
      headline: "No completed candle recorded",
      detail: worker.ready
        ? "The worker has not recorded a decision for this symbol yet."
        : worker.reason,
    };
  }
  const age = decisionAgeMs(decision, nowMs) ?? 0;
  const stale = age >= DECISION_FRESHNESS_MS;
  if (stale || !worker.ready) {
    return {
      key: "market",
      label: "Market",
      status: "amber",
      headline: stale ? "Last candle is stale" : "Worker not ready",
      detail: stale ? `Last completed candle closed ${formatAge(age)}.` : worker.reason,
    };
  }
  return {
    key: "market",
    label: "Market",
    status: "green",
    headline: `Last candle ${formatAge(age)}`,
    detail: `${decision.timeframe} · ${decision.strategy}${
      decision.armedLeg && decision.armedLeg !== decision.strategy
        ? ` (armed ${decision.armedLeg})`
        : ""
    }`,
  };
}

function decisionStep({ decision }: DeriveStepsInput): FlowStep {
  if (!decision) {
    return {
      key: "decision",
      label: "Decision",
      status: "gray",
      headline: "None recorded",
      detail: "No decision has been persisted for this symbol yet.",
    };
  }
  // A WAIT is a completed decision, so it is GREEN. Painting it amber would
  // say "something went wrong" about the most ordinary outcome there is.
  return {
    key: "decision",
    label: "Decision",
    status: "green",
    headline: decision.direction.toUpperCase(),
    detail: reasonProse(decision.reasonCode, decision.reason),
  };
}

function safetyStep({ decision }: DeriveStepsInput): FlowStep {
  if (!decision) {
    return {
      key: "safety",
      label: "Safety checks",
      status: "gray",
      headline: "Not reached",
      detail: "No decision to check.",
    };
  }
  if (decision.direction === "wait") {
    return {
      key: "safety",
      label: "Safety checks",
      status: "gray",
      headline: "Not reached",
      detail: "Safety checks run for a LONG or SHORT decision only.",
    };
  }
  const safety = decision.safety;
  if (!safety) {
    return {
      key: "safety",
      label: "Safety checks",
      status: "amber",
      headline: "In progress",
      detail: "The decision is tradeable; no safety record has been written yet.",
    };
  }
  if (!safety.passed) {
    const blocked = safety.checks.find((c) => c.passed === false);
    return {
      key: "safety",
      label: "Safety checks",
      status: "red",
      headline: safety.blockCode ?? "Blocked",
      detail: blocked?.detail ?? safety.blockDetail ?? `Stopped at ${blocked?.label ?? "a check"}.`,
    };
  }
  return {
    key: "safety",
    label: "Safety checks",
    status: "green",
    headline: "All four passed",
    detail: safety.checks.map((c) => c.label).join(" · "),
  };
}

function apexStep({ decision }: DeriveStepsInput): FlowStep {
  if (!decision || decision.direction === "wait") {
    return {
      key: "apex",
      label: "ApeX",
      status: "gray",
      headline: "Not reached",
      detail: decision ? "No order is placed for a WAIT decision." : "No decision recorded.",
    };
  }
  const state = decision.executionState;
  const intent = decision.orderIntent;
  const apex = decision.apexResult;
  if (state === "not_reached" || state === "blocked") {
    return {
      key: "apex",
      label: "ApeX",
      status: "gray",
      headline: "Not reached",
      detail:
        state === "blocked"
          ? `Stopped before submission: ${decision.executionReasonCode ?? "safety check failed"}.`
          : "No order intent has been created yet.",
    };
  }
  if (state === "rejected") {
    return {
      key: "apex",
      label: "ApeX",
      status: "red",
      headline: "Rejected",
      detail: apex?.rejectReason ?? decision.executionReasonCode ?? "Venue rejected the order.",
    };
  }
  if (state === "ambiguous") {
    return {
      key: "apex",
      label: "ApeX",
      status: "amber",
      headline: "Ambiguous",
      detail: `${apex?.rejectReason ?? "Outcome unconfirmed"} — awaiting reconciliation. Not retried.`,
    };
  }
  if (state === "filled") {
    return {
      key: "apex",
      label: "ApeX",
      status: "green",
      headline: "Filled",
      detail: `Order ${apex?.exchangeOrderId ?? "—"} · ${intent?.size ?? "—"} @ ${intent?.side ?? "—"}`,
    };
  }
  return {
    key: "apex",
    label: "ApeX",
    status: state === "submitted" ? "green" : "amber",
    headline: executionProse(state),
    detail:
      state === "submitted"
        ? `Accepted · order ${apex?.exchangeOrderId ?? "pending"}`
        : `Intent ${intent?.idempotencyKey?.slice(0, 48) ?? ""}`,
  };
}

/** Full flow, derived only from persisted proof. */
export function deriveFlowSteps(input: DeriveStepsInput): FlowStep[] {
  return [marketStep(input), decisionStep(input), safetyStep(input), apexStep(input)];
}

/**
 * One-line answer to "what happened on the last candle?".
 * Mirrors the owner's examples:
 *   ETH-USDT / WAIT / No 1h liquidity sweep and retest / Execution not reached
 *   ETH-USDT / LONG / All four safety checks passed / Intent -> signed -> filled
 */
export function flowHeadline(decision: DecisionRecord | null): string {
  if (!decision) return "No decision recorded for this symbol yet.";
  if (decision.direction === "wait") {
    return `${reasonProse(decision.reasonCode, decision.reason)} — execution not reached.`;
  }
  if (decision.safety && !decision.safety.passed) {
    return `${decision.direction.toUpperCase()} confirmed — stopped at a safety check (${
      decision.safety.blockCode ?? "unknown"
    }).`;
  }
  return `${decision.direction.toUpperCase()} confirmed — ${executionProse(
    decision.executionState,
  ).toLowerCase()}.`;
}

/* ------------------------------------------------------------------ *
 * Chart overlay
 * ------------------------------------------------------------------ */

export interface DecisionChartOverlay {
  key: string;
  label: string;
  color: string;
  side: "long" | "short";
  entry: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  invalidation: number | null;
  tps: number[] | null;
}

/**
 * Chart levels for one decision, keyed by the SAME decision_id the panel
 * shows. Pure projection: every number here was persisted for this exact
 * candle, so the chart cannot draw a level that was never decided.
 *
 * Returns null for a WAIT — there is no entry to draw, and inventing one
 * would show a trade the strategy explicitly declined.
 */
export function decisionChartOverlay(
  decision: DecisionRecord | null,
  symbol: string,
): DecisionChartOverlay | null {
  if (!decision || decision.symbol !== symbol) return null;
  if (decision.direction !== "long" && decision.direction !== "short") return null;
  const zone = decision.entryZone;
  const entry = zone ? (zone.low + zone.high) / 2 : null;
  return {
    key: `decision:${decision.decisionId}`,
    label: `${decision.strategy} ${decision.direction}`,
    color: "var(--onixus-hot-blue)",
    side: decision.direction,
    entry,
    entryLow: zone?.low ?? null,
    entryHigh: zone?.high ?? null,
    stop: decision.invalidation,
    invalidation: decision.invalidation,
    tps: decision.takeProfits.length > 0 ? decision.takeProfits : null,
  };
}

export interface DecisionFlowDto {
  generatedAt: string;
  symbol: string;
  worker: FlowWorkerHealth;
  decision: DecisionRecord | null;
  opinions: AiOpinion[];
  seats: SeatView[];
  steps: FlowStep[];
  headline: string;
}

/* ------------------------------------------------------------------ *
 * AI Decision Room — display contract for a recent stored evaluation.
 * Every field here comes from a persisted row. There is no field that a
 * renderer may fill in with a guess.
 * ------------------------------------------------------------------ */
export interface DecisionRoomOrchestration {
  verdict: string;
  consensusDirection: string | null;
  consensusConfidence: number | null;
  availableRoles: string[];
  unavailableRoles: string[];
  riskDissent: boolean;
}

export interface DecisionRoomEntry {
  decisionId: string;
  traceId: string | null;
  symbol: string;
  timeframe: string;
  strategy: string;
  candleCloseAt: string;
  deterministicDirection: string;
  deterministicReason: string;
  opinions: AiOpinion[];
  orchestration: DecisionRoomOrchestration | null;
  risk: { passed: boolean; code: string; detail: string } | null;
  terminalOutcome: string | null;
  terminalReason: string | null;
  executionState: ExecutionState;
}
