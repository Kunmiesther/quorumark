// SERVER-ONLY position-management agent for PAPER positions.
//
// Contract (owner directive, agentic OS):
//   • The agent stays involved AFTER entry. Open paper positions are
//     re-evaluated on candle close, material volume/liquidity change, DCA rung
//     fill, structure break, TP approach, hedge opportunity, model stance
//     change and degraded execution conditions.
//   • EVERY re-evaluation attempts all three model seats on one immutable
//     evidence snapshot, is synthesized by ONYX, then passes through exactly
//     ONE consolidated risk check — the same shape as the entry pipeline.
//   • The resulting event is appended to the ORIGINAL position timeline via
//     `parent_trace_id` (the entry orchestration trace), so a position's whole
//     life is one auditable chain.
//   • Allowed paper actions: HOLD, BANK_PROFIT, FILL_APPROVED_RUNG,
//     MOVE_TO_APPROVED_BREAKEVEN, HEDGE, EXIT.
//
// AUTHORITY: paper only. Nothing here can reach the signer, the broker, or a
// live venue. Ladder economics (BTC/ETH rung geometry, stop placement, TP
// tiers) are owned by the deterministic engine and are NOT rewritten here —
// the agent may only recommend actions the engine already supports.
//
// APPLY GATE: recommendations are recorded as advisory events unless
// PAPER_AGENTIC_MANAGEMENT_APPLY is explicitly enabled. Recording is always
// on; mutation of live paper state stays behind the flag so strategy
// economics cannot drift silently.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { canonicalJson, type MarketSnapshot, type ProviderOutcome } from "@/lib/ai/committee/schema";
import { aggregateCommittee } from "@/lib/ai/committee/aggregate";
import type { Participation } from "./aiOrchestration.server";

export const POSITION_EVENTS_TABLE = "paper_position_events";
export const POSITION_EVENT_OPINIONS_TABLE = "paper_position_event_opinions";

/** Hard cap on managed positions per sweep — cost + latency guard. */
export const MAX_MANAGED_POSITIONS_PER_SWEEP = 8;

/** Fraction of the entry→TP distance at which "TP approach" fires. */
export const TP_APPROACH_FRACTION = 0.75;
/** Relative volume change that counts as a material shift. */
export const VOLUME_SHIFT_RATIO = 1.75;

export type ManagementTrigger =
  | "legacy_bootstrap"
  | "candle_close"
  | "volume_shift"
  | "liquidity_shift"
  | "rung_fill"
  | "structure_break"
  | "tp_approach"
  | "hedge_opportunity"
  | "model_stance_change"
  | "degraded_execution";

export type ManagementAction =
  | "HOLD"
  | "BANK_PROFIT"
  | "FILL_APPROVED_RUNG"
  | "MOVE_TO_APPROVED_BREAKEVEN"
  | "HEDGE"
  | "EXIT";

export interface ManagedPosition {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  sizeQty: number;
  margin: number;
  leverage: number;
  stopLevel: number | null;
  tpLevel: number | null;
  structureBroken: boolean;
  filledRungCount: number;
  configuredRungCount: number;
  traceId: string | null;
  lastSeenCandleTsMs: number | null;
}

export interface ManagementMarket {
  /** Newest completed candle close. */
  price: number;
  candleTsMs: number;
  /** Newest completed candle volume. */
  volume: number;
  /** Mean volume over the recent window, for the volume-shift trigger. */
  avgVolume: number;
  recentCloses: number[];
  timeframeCloses: {
    close5mMs: number;
    close15mMs: number | null;
    close1hMs: number | null;
    close4hMs: number | null;
    dailyMs: number | null;
    weeklyMs: number | null;
    monthlyMs: number | null;
  };
  environmentFrames: Record<string, unknown> | null;
}

export interface ManagementEventResult {
  eventId: string | null;
  positionId: string;
  trigger: ManagementTrigger;
  action: ManagementAction;
  rationale: string;
  participation: Participation;
  degraded: boolean;
  riskPassed: boolean;
  riskCode: string;
  applied: boolean;
  applyBlockedReason: string | null;
  skipped: string | null;
}

/** Apply gate — recording is unconditional, mutation is not. */
export function managementApplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.PAPER_AGENTIC_MANAGEMENT_APPLY ?? "").toLowerCase() === "true";
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function unrealizedPct(p: ManagedPosition, price: number): number {
  if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) return 0;
  const sign = p.direction === "long" ? 1 : -1;
  return ((price - p.entryPrice) / p.entryPrice) * 100 * sign;
}

/**
 * Deterministic trigger detection. Pure: the same position + market always
 * yields the same trigger set, which is what makes the events idempotent.
 */
export function detectTriggers(p: ManagedPosition, m: ManagementMarket): ManagementTrigger[] {
  const out: ManagementTrigger[] = [];

  if (p.lastSeenCandleTsMs == null || m.candleTsMs > p.lastSeenCandleTsMs) {
    out.push("candle_close");
  }
  if (p.structureBroken) out.push("structure_break");
  if (p.filledRungCount > 1 && p.filledRungCount <= p.configuredRungCount) {
    out.push("rung_fill");
  }
  if (m.avgVolume > 0 && m.volume / m.avgVolume >= VOLUME_SHIFT_RATIO) {
    out.push("volume_shift");
  }
  if (p.tpLevel != null && Number.isFinite(p.tpLevel)) {
    const span = Math.abs(p.tpLevel - p.entryPrice);
    const travelled = p.direction === "long" ? m.price - p.entryPrice : p.entryPrice - m.price;
    if (span > 0 && travelled / span >= TP_APPROACH_FRACTION) out.push("tp_approach");
  }
  // Adverse excursion beyond the stop distance without a stop hit yet →
  // hedge consideration, never an automatic hedge.
  if (p.stopLevel != null && Number.isFinite(p.stopLevel)) {
    const risk = Math.abs(p.entryPrice - p.stopLevel);
    const adverse = p.direction === "long" ? p.entryPrice - m.price : m.price - p.entryPrice;
    if (risk > 0 && adverse / risk >= 0.6) out.push("hedge_opportunity");
  }
  return out;
}

/** The immutable evidence snapshot for one re-evaluation. */
export function buildManagementEvidence(
  p: ManagedPosition,
  m: ManagementMarket,
  trigger: ManagementTrigger,
): Record<string, unknown> {
  return {
    schema: "paper_position_management.v1",
    trigger,
    position_id: p.id,
    symbol: p.symbol,
    direction: p.direction,
    entry: p.entryPrice,
    stop: p.stopLevel,
    tp: p.tpLevel,
    size_qty: p.sizeQty,
    margin: p.margin,
    leverage: p.leverage,
    filled_rungs: p.filledRungCount,
    configured_rungs: p.configuredRungCount,
    structure_broken: p.structureBroken,
    price: m.price,
    candle_ts_ms: m.candleTsMs,
    volume: m.volume,
    avg_volume: m.avgVolume,
    unrealized_pct: Number(unrealizedPct(p, m.price).toFixed(4)),
    entry_attribution: p.traceId == null ? "legacy_unattributed" : "attributed",
    timeframes: m.timeframeCloses,
    environment_frames: m.environmentFrames,
  };
}

function buildSnapshot(
  p: ManagedPosition,
  m: ManagementMarket,
  trigger: ManagementTrigger,
  eventTraceId: string,
): MarketSnapshot {
  return {
    candidate_id: eventTraceId,
    strategy: `manage:${trigger}`,
    symbol: p.symbol,
    timeframe: "15m",
    candle_close_ms: m.candleTsMs,
    deterministic: {
      proposed_direction: p.direction,
      entry: p.entryPrice,
      entry_zone: null,
      invalidation: p.stopLevel,
      tp_levels: p.tpLevel == null ? [] : [p.tpLevel],
      regime: null,
      trend_state: null,
      trend_slope_pct: null,
      atr_pct: null,
      recent_closes: m.recentCloses.slice(-24),
      recent_highs: [],
      recent_lows: [],
      volume_profile: [],
    },
    higher_timeframes: {
      setup_15m_close_ms: m.timeframeCloses.close15mMs,
      regime_1h_close_ms: m.timeframeCloses.close1hMs,
      regime_4h_close_ms: m.timeframeCloses.close4hMs,
      bos_1h: null,
      bos_4h: null,
      environment_daily_available: m.environmentFrames != null,
      environment_frames: m.environmentFrames,
      environment_unavailable_reason: m.environmentFrames == null ? "environment_frames_unavailable" : null,
    },
  };
}

function participationOf(answered: number): Participation {
  if (answered >= 3) return "full_3_of_3";
  if (answered === 2) return "degraded_2_of_3";
  if (answered === 1) return "degraded_1_of_3";
  return "ai_unavailable";
}

export interface OnyxManagementSynthesis {
  action: ManagementAction;
  rationale: string;
  confidence: number | null;
}

/**
 * ONYX synthesis for an open position. Deterministic state is the ground
 * truth; the models are an advisory panel that can escalate protection but
 * cannot invent a market fact or exceed the allowed action set.
 */
export function synthesizeManagement(
  p: ManagedPosition,
  m: ManagementMarket,
  trigger: ManagementTrigger,
  outcomes: ProviderOutcome[],
): OnyxManagementSynthesis {
  const committee = aggregateCommittee(outcomes);
  const answered = outcomes.filter((o) => o.available).length;
  const pnlPct = unrealizedPct(p, m.price);
  const parts: string[] = [
    `${trigger} on ${p.symbol} ${p.direction} (unrealized ${pnlPct.toFixed(2)}%)`,
    `models ${answered}/3 (${committee.verdict})`,
  ];

  if (answered === 0) {
    parts.push("AI-UNAVAILABLE degraded mode: holding on deterministic state only");
    return { action: "HOLD", rationale: parts.join("; "), confidence: null };
  }

  const consensus = committee.consensusDirection;
  const opposed = consensus != null && consensus !== "no_trade" && consensus !== p.direction;

  // Structure break against an in-profit position → protect, don't gamble.
  if (trigger === "structure_break" && pnlPct > 0) {
    parts.push("structure broken while in profit: banking is the protective action");
    return { action: "BANK_PROFIT", rationale: parts.join("; "), confidence: committee.consensusConfidence };
  }
  if (trigger === "structure_break" && opposed) {
    parts.push("structure broken and available models favour the opposite side");
    return { action: "EXIT", rationale: parts.join("; "), confidence: committee.consensusConfidence };
  }
  if (trigger === "tp_approach" && pnlPct > 0) {
    parts.push("price is within the TP approach band");
    return {
      action: opposed ? "BANK_PROFIT" : "MOVE_TO_APPROVED_BREAKEVEN",
      rationale: parts.join("; "),
      confidence: committee.consensusConfidence,
    };
  }
  if (trigger === "hedge_opportunity" && opposed) {
    parts.push("adverse excursion with models favouring the opposite side");
    return { action: "HEDGE", rationale: parts.join("; "), confidence: committee.consensusConfidence };
  }
  if (trigger === "rung_fill" && !opposed && p.filledRungCount < p.configuredRungCount) {
    parts.push("ladder still has approved rungs and models are not opposed");
    return { action: "FILL_APPROVED_RUNG", rationale: parts.join("; "), confidence: committee.consensusConfidence };
  }
  if (opposed) {
    parts.push(`available models favour ${consensus}; stance change recorded`);
    return {
      action: pnlPct > 0 ? "BANK_PROFIT" : "HOLD",
      rationale: parts.join("; "),
      confidence: committee.consensusConfidence,
    };
  }

  if (committee.riskFlags.length) parts.push(`risk flags: ${committee.riskFlags.slice(0, 6).join(", ")}`);
  parts.push("no protective condition met; deterministic plan stands");
  return { action: "HOLD", rationale: parts.join("; "), confidence: committee.consensusConfidence };
}

export interface ManagementRiskResult {
  passed: boolean;
  code: string;
  checks: { key: string; passed: boolean; code: string; detail: string }[];
}

/**
 * The ONE consolidated risk checkpoint for a management action, run after
 * ONYX. HOLD is always permitted; anything that would change state must clear
 * halts and be internally consistent.
 */
export async function runManagementRiskCheck(
  reader: SupabaseClient,
  userId: string,
  p: ManagedPosition,
  action: ManagementAction,
): Promise<ManagementRiskResult> {
  const checks: ManagementRiskResult["checks"] = [];
  const add = (key: string, passed: boolean, code: string, detail: string) =>
    checks.push({ key, passed, code, detail });

  const { data: halts } = await reader
    .from("kill_switches")
    .select("scope, active, reason")
    .eq("user_id", userId)
    .eq("active", true);
  const halted = (halts ?? []).length > 0;
  add("not_halted", !halted || action === "HOLD", halted && action !== "HOLD" ? "EMERGENCY_HALT_ACTIVE" : "OK",
    halted ? "kill switch active" : "no active kill switch");

  const stillOpen = await reader
    .from("paper_positions")
    .select("id, status")
    .eq("id", p.id)
    .eq("user_id", userId)
    .eq("status", "open")
    .maybeSingle();
  const open = Boolean(stillOpen.data);
  add("position_open", open, open ? "OK" : "POSITION_NOT_OPEN",
    open ? "position still open" : "position closed before the action could be evaluated");

  const ladderOk = action !== "FILL_APPROVED_RUNG" || p.filledRungCount < p.configuredRungCount;
  add("rung_within_approved_ladder", ladderOk, ladderOk ? "OK" : "LADDER_EXHAUSTED",
    `filled=${p.filledRungCount} configured=${p.configuredRungCount}`);

  const sized = Number.isFinite(p.sizeQty) && p.sizeQty > 0;
  add("size_sane", sized, sized ? "OK" : "SIZE_INVALID", `size_qty=${p.sizeQty}`);

  const failed = checks.find((k) => !k.passed);
  return { passed: !failed, code: failed ? failed.code : "OK", checks };
}

/**
 * Run ONE re-evaluation for one position + trigger, persisting the full
 * linked chain: evidence → three attempted opinions → ONYX → risk → action.
 * Idempotent per (user, position, trigger, evidence hash).
 */
export async function reevaluatePosition(
  reader: SupabaseClient,
  userId: string,
  position: ManagedPosition,
  market: ManagementMarket,
  trigger: ManagementTrigger,
): Promise<ManagementEventResult> {
  const base = {
    eventId: null as string | null,
    positionId: position.id,
    trigger,
    action: "HOLD" as ManagementAction,
    rationale: "",
    participation: "ai_unavailable" as Participation,
    degraded: true,
    riskPassed: false,
    riskCode: "NOT_EVALUATED",
    applied: false,
    applyBlockedReason: null as string | null,
    skipped: null as string | null,
  };

  try {
    const existingRoot = position.traceId == null
      ? await reader
          .from(POSITION_EVENTS_TABLE)
          .select("management_root_trace_id")
          .eq("user_id", userId)
          .eq("paper_position_id", position.id)
          .eq("event_kind", "legacy_bootstrap")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
      : null;
    const rootTraceId = position.traceId ??
      ((existingRoot?.data as { management_root_trace_id?: string | null } | null)?.management_root_trace_id ?? null);
    const isLegacyBootstrap = position.traceId == null && rootTraceId == null;
    const effectiveTrigger: ManagementTrigger = isLegacyBootstrap ? "legacy_bootstrap" : trigger;
    const evidence = buildManagementEvidence(position, market, effectiveTrigger);
    const evidenceHash = await sha256Hex(canonicalJson(evidence));

    const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
    const ledger = await ledgerClient();

    const existing = await ledger
      .from(POSITION_EVENTS_TABLE)
      .select("id, onyx_action, onyx_rationale, participation, degraded, risk_passed, risk_code, action_applied")
      .eq("user_id", userId)
      .eq("paper_position_id", position.id)
      .eq("trigger", effectiveTrigger)
      .eq("evidence_hash", evidenceHash)
      .maybeSingle();
    if (existing.data) {
      const r = existing.data as Record<string, unknown>;
      return {
        ...base,
        eventId: String(r.id),
        action: String(r.onyx_action) as ManagementAction,
        rationale: String(r.onyx_rationale ?? ""),
        participation: String(r.participation) as Participation,
        degraded: Boolean(r.degraded),
        riskPassed: Boolean(r.risk_passed),
        riskCode: String(r.risk_code ?? "OK"),
        applied: Boolean(r.action_applied),
        skipped: "already_evaluated",
      };
    }

    const { count } = await ledger
      .from(POSITION_EVENTS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("paper_position_id", position.id);

    const inserted = await ledger
      .from(POSITION_EVENTS_TABLE)
      .insert({
        user_id: userId,
        parent_trace_id: rootTraceId,
        paper_position_id: position.id,
        symbol: position.symbol,
        direction: position.direction,
        sequence: (count ?? 0) + 1,
        trigger: effectiveTrigger,
        evidence,
        evidence_hash: evidenceHash,
        providers_attempted: 3,
        trace_id: randomUUID(),
        event_kind: isLegacyBootstrap ? "legacy_bootstrap" : "management",
        entry_attribution: position.traceId == null ? "legacy_unattributed" : "attributed",
      })
      .select("id, trace_id")
      .single();
    if (inserted.error || !inserted.data) {
      return { ...base, skipped: `event_insert:${inserted.error?.code ?? "unknown"}` };
    }
    const row = inserted.data as { id: string; trace_id: string };

    // 1. Fan out to all three seats on the same immutable snapshot.
    const { runFirstRound, PROMPT_VERSION } = await import("@/lib/ai/committee/providers.server");
    const { createAiUsageCollector } = await import("@/lib/ai/usage.server");
    const usage = createAiUsageCollector(userId, "paper_position_council");
    const outcomes = await runFirstRound(buildSnapshot(position, market, effectiveTrigger, row.trace_id), {
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

    // 2. Record every seat, answered or not.
    await ledger.from(POSITION_EVENT_OPINIONS_TABLE).upsert(
      outcomes.map((o) => ({
        event_id: row.id,
        user_id: userId,
        role: o.role,
        provider: o.provider,
        model: o.model,
        status: o.available ? "evaluated" : "unavailable",
        direction: o.available ? (o.response.direction === "no_trade" ? "wait" : o.response.direction) : null,
        confidence: o.available ? o.response.confidence : null,
        summary: o.available ? o.response.summary.slice(0, 600) : null,
        risk_flags: o.available ? o.response.risk_flags.slice(0, 12) : [],
        latency_ms: Math.trunc(o.latencyMs),
        prompt_version: PROMPT_VERSION,
        unavailable_reason: o.available ? null : o.reason,
        advisory: true,
      })),
      { onConflict: "event_id,role", ignoreDuplicates: true },
    );

    const answered = outcomes.filter((o) => o.available).length;
    const participation = participationOf(answered);
    const degraded = answered < 3;
    const degradedReason = degraded
      ? outcomes.filter((o) => !o.available).map((o) => `${o.role}:${o.reason}`).join(", ")
      : null;

    // 3. ONYX synthesis.
    const onyx = synthesizeManagement(position, market, effectiveTrigger, outcomes);

    // 4. Exactly one consolidated risk check, after ONYX.
    const risk = await runManagementRiskCheck(reader, userId, position, onyx.action);

    // 5. Apply gate. Recording always happens; mutation stays flagged off.
    const applyEnabled = managementApplyEnabled();
    const wouldMutate = onyx.action !== "HOLD";
    const applied = false; // no state mutation is performed by this agent yet
    const applyBlockedReason = !wouldMutate
      ? null
      : !risk.passed
        ? `risk_${risk.code}`
        : applyEnabled
          ? "apply_path_not_implemented"
          : "PAPER_AGENTIC_MANAGEMENT_APPLY_disabled";

    await ledger
      .from(POSITION_EVENTS_TABLE)
      .update({
        providers_answered: answered,
        participation,
        degraded,
        degraded_reason: degradedReason,
        onyx_action: onyx.action,
        onyx_rationale: onyx.rationale.slice(0, 2000),
        onyx_confidence: onyx.confidence,
        risk_checked: true,
        risk_passed: risk.passed,
        risk_code: risk.code,
        risk_detail: { checks: risk.checks },
        action_applied: applied,
        apply_blocked_reason: applyBlockedReason,
        management_root_trace_id: rootTraceId ?? row.trace_id,
      })
      .eq("id", row.id);

    return {
      eventId: row.id,
      positionId: position.id,
      trigger: effectiveTrigger,
      action: onyx.action,
      rationale: onyx.rationale,
      participation,
      degraded,
      riskPassed: risk.passed,
      riskCode: risk.code,
      applied,
      applyBlockedReason,
      skipped: null,
    };
  } catch (err) {
    return { ...base, skipped: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

export interface ManagementSweepSummary {
  discovered: number;
  positions: number;
  events: number;
  degradedEvents: number;
  actions: Record<string, number>;
  errors: number;
  skipped: Record<string, number>;
}

/**
 * Newest candle each position has ALREADY been managed on, taken from the
 * manager's own event ledger (evidence.candle_ts_ms). Missing entry = never
 * managed, so the next candle_close is a real trigger.
 */
export async function loadManagedCandleWatermarks(
  reader: SupabaseClient,
  userId: string,
  positionIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (positionIds.length === 0) return out;
  const { data } = await reader
    .from(POSITION_EVENTS_TABLE)
    .select("paper_position_id, evidence")
    .eq("user_id", userId)
    .in("paper_position_id", positionIds);
  for (const raw of data ?? []) {
    const r = raw as unknown as Record<string, unknown>;
    const pid = String(r.paper_position_id);
    const ts = Number((r.evidence as Record<string, unknown> | null)?.candle_ts_ms ?? NaN);
    if (!Number.isFinite(ts)) continue;
    const prev = out.get(pid);
    if (prev == null || ts > prev) out.set(pid, ts);
  }
  return out;
}

/**
 * Sweep every open paper position for one user and re-evaluate the highest
 * priority trigger on each. Bounded by MAX_MANAGED_POSITIONS_PER_SWEEP.
 */
export async function sweepPositionManagement(
  reader: SupabaseClient,
  userId: string,
  marketBySymbol: Map<string, ManagementMarket>,
): Promise<ManagementSweepSummary> {
  const summary: ManagementSweepSummary = {
    discovered: 0, positions: 0, events: 0, degradedEvents: 0, actions: {}, errors: 0, skipped: {},
  };

  const { data: rows } = await reader
    .from("paper_positions")
    .select(
      "id, symbol, direction, entry_price, size_qty, margin, leverage, stop_level, tp_level, " +
        "structure_broken, filled_rung_count, configured_rung_count, orchestration_trace_id, last_seen_candle_ts_ms",
    )
    .eq("user_id", userId)
    .eq("status", "open")
    .order("entry_ts", { ascending: true })
    .limit(MAX_MANAGED_POSITIONS_PER_SWEEP);

  // The deterministic tick advances paper_positions.last_seen_candle_ts_ms
  // BEFORE this sweep runs, so that column can never express "the manager has
  // not looked at this candle yet". The manager's own watermark is the candle
  // of its most recent recorded event for the position.
  const positionIds = (rows ?? []).map((r) => String((r as unknown as Record<string, unknown>).id));
  summary.discovered = positionIds.length;
  const managedWatermark = await loadManagedCandleWatermarks(reader, userId, positionIds);

  for (const raw of rows ?? []) {
    const r = raw as unknown as Record<string, unknown>;
    const id = String(r.id);
    const position: ManagedPosition = {
      id,
      symbol: String(r.symbol),
      direction: r.direction as "long" | "short",
      entryPrice: Number(r.entry_price ?? 0),
      sizeQty: Number(r.size_qty ?? 0),
      margin: Number(r.margin ?? 0),
      leverage: Number(r.leverage ?? 0),
      stopLevel: r.stop_level == null ? null : Number(r.stop_level),
      tpLevel: r.tp_level == null ? null : Number(r.tp_level),
      structureBroken: Boolean(r.structure_broken),
      filledRungCount: Number(r.filled_rung_count ?? 0),
      configuredRungCount: Number(r.configured_rung_count ?? 0),
      traceId: (r.orchestration_trace_id as string | null) ?? null,
      lastSeenCandleTsMs: managedWatermark.get(id) ?? null,
    };
    const market = marketBySymbol.get(position.symbol);
    if (!market) {
      summary.skipped.market_unavailable = (summary.skipped.market_unavailable ?? 0) + 1;
      continue;
    }
    summary.positions += 1;

    const triggers = detectTriggers(position, market);
    if (triggers.length === 0) {
      summary.skipped.no_trigger = (summary.skipped.no_trigger ?? 0) + 1;
      continue;
    }
    // Highest-priority trigger only — one evaluation per position per sweep.
    const priority: ManagementTrigger[] = [
      "structure_break", "tp_approach", "hedge_opportunity", "rung_fill",
      "volume_shift", "liquidity_shift", "model_stance_change", "degraded_execution", "candle_close",
    ];
    const chosen = priority.find((t) => triggers.includes(t)) ?? triggers[0];

    const result = await reevaluatePosition(reader, userId, position, market, chosen);
    if (result.skipped && !result.eventId) {
      summary.errors += 1;
      const category = result.skipped.split(":", 1)[0] || "evaluation_error";
      summary.skipped[category] = (summary.skipped[category] ?? 0) + 1;
      continue;
    }
    if (result.skipped === "already_evaluated") {
      summary.skipped.already_evaluated = (summary.skipped.already_evaluated ?? 0) + 1;
      continue;
    }
    summary.events += 1;
    if (result.degraded) summary.degradedEvents += 1;
    summary.actions[result.action] = (summary.actions[result.action] ?? 0) + 1;
  }

  return summary;
}
