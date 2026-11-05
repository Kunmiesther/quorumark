// SERVER-ONLY mandatory AI orchestration for PAPER trades.
//
// Contract (owner directive):
//   • 2-of-3 aligned opportunities bypass AI and route mechanically to the
//     Long or Short wallet.
//   • Only failed-alignment opportunities are fanned out to all three Council
//     seats — never sampled.
//   • Every seat's outcome is recorded: status, direction, confidence,
//     rationale, risk flags, latency, model, prompt version, failure reason.
//   • ONYX synthesizes the available opinions PLUS the deterministic evidence
//     into ONE decision + rationale.
//   • Exactly ONE consolidated risk check runs after ONYX.
//   • Only then may a paper order intent / position be created, and only with
//     the orchestration trace attached (enforced in the database).
//   • A new entry requires a provider-independent Council quorum, the risk
//     officer, a matching majority, and minimum confidence. Outages fail
//     closed for new exposure; they never freeze open-position management.
//   • WAIT decisions are recorded too, so model involvement stays visible.
//
// AUTHORITY: Council selects from the failed-alignment queue and Onyx makes
// the final Strategy-wallet DCA selection. Models cannot bypass the four-
// wallet router, an occupied-symbol lock, or mechanical position management.
// Nothing here can reach the
// signer, the broker, or a live venue.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateCommittee } from "@/lib/ai/committee/aggregate";
import { canonicalJson, type CommitteeDirection, type MarketSnapshot, type ProviderOutcome } from "@/lib/ai/committee/schema";
import type { FirstRoundOptions, RoleSpec } from "@/lib/ai/committee/providers.server";
import type { EnvironmentContext } from "@/lib/paper/environmentFrames";
import { ENTRY_FRESHNESS_CANDLES } from "@/lib/paper/eligibility";
import { EXECUTION_INTERVAL_MIN, TARGET_LEVERAGE } from "@/lib/paper/constants";

export const ORCHESTRATIONS_TABLE = "paper_ai_orchestrations";
export const PAPER_OPINIONS_TABLE = "paper_ai_opinions";

export type Participation =
  | "full_3_of_3"
  | "degraded_2_of_3"
  | "degraded_1_of_3"
  | "ai_unavailable";

export type TerminalOutcome =
  | "TRADE_CANDIDATE"
  | "NO_TRADE_STRATEGY"
  | "NO_TRADE_RISK"
  /** Deterministic market snapshot was invalid — no model was ever contacted. */
  | "NO_TRADE_DATA"
  | "PIPELINE_ERROR";

/**
 * Stable machine codes for an unusable deterministic market snapshot.
 * Any of these MUST fail closed before provider fan-out or execution.
 */
export type SnapshotInvalidCode =
  | "SNAPSHOT_STALE"
  | "SNAPSHOT_FUTURE"
  | "SNAPSHOT_MISALIGNED"
  | "SNAPSHOT_INCOMPLETE"
  | "SNAPSHOT_TF_MISALIGNED";

export const ENTRY_TF_MS = EXECUTION_INTERVAL_MIN * 60_000;
/**
 * A closed 15m candle is only tradable evidence for this long.
 *
 * This MUST stay consistent with the deterministic eligibility contract, which
 * accepts a retest up to `ENTRY_FRESHNESS_CANDLES` bars behind the newest
 * CLOSED candle. Worst case age at evaluation time is therefore:
 *   ENTRY_FRESHNESS_CANDLES bars  (distance behind the newest closed bar)
 * + 1 bar                        (the newest closed bar's own age, up to 15m)
 * + tick latency budget.
 * A flat 15m window was shorter than that worst case, so a candidate the
 * deterministic layer legitimately re-proposed (e.g. 18:45 evaluated at 19:02)
 * was permanently rejected as SNAPSHOT_STALE — the AI committee never ran,
 * no orchestration trace was written, and every open attempt then failed the
 * `paper_orchestration_missing` invariant. Fail-closed is preserved; the
 * window is now derived from the same contract instead of contradicting it.
 */
export const SNAPSHOT_LATENCY_BUDGET_MS = 60_000;
export const MAX_SNAPSHOT_AGE_MS =
  (ENTRY_FRESHNESS_CANDLES + 1) * ENTRY_TF_MS + SNAPSHOT_LATENCY_BUDGET_MS;
/** Clock-skew tolerance before a candle close counts as "in the future". */
export const FUTURE_TOLERANCE_MS = 5_000;
/** Entry approval needs a real Council majority, not one model's opinion. */
export const MIN_COUNCIL_CONFIDENCE = 0.6;

export interface SnapshotValidity {
  valid: boolean;
  code: SnapshotInvalidCode | null;
  detail: Record<string, unknown>;
}

const HTF_FRAMES: Array<{ key: "lastClosed15mMs" | "lastClosed1hMs" | "lastClosed4hMs" | "lastClosed1dMs"; ms: number; label: string }> = [
  { key: "lastClosed15mMs", ms: 15 * 60_000, label: "15m" },
  { key: "lastClosed1hMs", ms: 60 * 60_000, label: "1h" },
  { key: "lastClosed4hMs", ms: 4 * 60 * 60_000, label: "4h" },
  { key: "lastClosed1dMs", ms: 24 * 60 * 60_000, label: "1d" },
];

/**
 * Validate the immutable deterministic market snapshot BEFORE anything else.
 *
 * Owner directive: stale, incomplete, gap-invalid, future or cross-timeframe
 * misaligned market data must fail closed with a stable code. Degraded
 * "AI-unavailable" continuation is permitted ONLY when this returns valid and
 * it is provider availability alone that failed.
 */
export function validateMarketSnapshot(
  c: PaperCandidateInput,
  nowMs: number = Date.now(),
): SnapshotValidity {
  const ts = c.entryCandleTs;
  const base = { entry_candle_ts_ms: ts, now_ms: nowMs, entry_tf: "15m" };

  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(c.fillPx) || c.fillPx <= 0) {
    return {
      valid: false,
      code: "SNAPSHOT_INCOMPLETE",
      detail: { ...base, reason: "entry candle timestamp or price missing/non-finite", entry: c.fillPx },
    };
  }

  if (ts % ENTRY_TF_MS !== 0) {
    return {
      valid: false,
      code: "SNAPSHOT_MISALIGNED",
      detail: { ...base, reason: "entry candle close is not aligned to a 15m boundary", remainder_ms: ts % ENTRY_TF_MS },
    };
  }

  if (ts > nowMs + FUTURE_TOLERANCE_MS) {
    return {
      valid: false,
      code: "SNAPSHOT_FUTURE",
      detail: { ...base, reason: "entry candle has not closed yet", ahead_ms: ts - nowMs },
    };
  }

  const ageMs = nowMs - ts;
  if (ageMs > MAX_SNAPSHOT_AGE_MS) {
    return {
      valid: false,
      code: "SNAPSHOT_STALE",
      detail: { ...base, reason: "entry candle is older than the tradable freshness window", age_ms: ageMs, max_age_ms: MAX_SNAPSHOT_AGE_MS },
    };
  }

  // Higher-timeframe context must be closed bars that align to their own
  // frame and never post-date the entry candle they are supposed to frame.
  for (const frame of HTF_FRAMES) {
    const v = c.htf?.[frame.key] ?? null;
    if (v == null) continue;
    if (!Number.isFinite(v) || v % frame.ms !== 0) {
      return {
        valid: false,
        code: "SNAPSHOT_TF_MISALIGNED",
        detail: { ...base, reason: `${frame.label} context close is not aligned to its own frame`, frame: frame.label, close_ms: v },
      };
    }
    if (v > ts) {
      return {
        valid: false,
        code: "SNAPSHOT_TF_MISALIGNED",
        detail: { ...base, reason: `${frame.label} context close post-dates the entry candle`, frame: frame.label, close_ms: v },
      };
    }
    if (v > nowMs) {
      return {
        valid: false,
        code: "SNAPSHOT_TF_MISALIGNED",
        detail: { ...base, reason: `${frame.label} context bar has not closed yet`, frame: frame.label, close_ms: v },
      };
    }
  }

  return { valid: true, code: null, detail: { ...base, age_ms: ageMs } };
}


export interface PaperCandidateInput {
  key: string;
  symbol: string;
  direction: "long" | "short";
  leg: string;
  entryCandleTs: number;
  fillPx: number;
  stopLevel: number | null;
  tpLevel: number | null;
  zoneLower: number | null;
  zoneUpper: number | null;
  margin: number;
  notional: number;
  leverage: number;
  regime: string | null;
  trendState: string | null;
  trendSlopePct: number | null;
  movementScore: number | null;
  /**
   * Compact completed-candle evidence already fetched by the paper engine.
   * Kept intentionally bounded: enough context for structure/volume review,
   * without a second market-data call or an oversized model prompt.
   */
  marketEvidence?: {
    atrPct: number | null;
    recentCloses: number[];
    recentHighs: number[];
    recentLows: number[];
    recentVolumes: number[];
  } | null;
  /**
   * Higher-timeframe context, folded from the same 5m feed this tick fetched.
   * Advisory evidence only — it carries no gating authority and does not
   * change any deterministic decision. Absent frames are reported as null
   * rather than omitted, so the models can see what was NOT available.
   */
  htf?: {
    bos1h: string | null;
    bos4h: string | null;
    bos1d?: string | null;
    lastClosed4hMs: number | null;
    lastClosed1hMs: number | null;
    lastClosed1dMs?: number | null;
    lastClosed15mMs: number | null;
  } | null;
  /**
   * Environment frames (1d/1w/1M) fetched natively from the venue, so the
   * prompt carries real daily/weekly/monthly context instead of an
   * "unavailable" placeholder. Advisory only — never gates a candidate.
   */
  env?: EnvironmentContext | null;
  /** Deterministic engine intent for this candidate on this tick. */
  deterministicApproved: boolean;
  /** Owner-approved four-wallet route. Only failed-alignment opportunities
   *  may enter Council→Onyx selection. */
  selectionPath?: "core_2_of_3" | "council_then_onyx";
}


export interface PaperOrchestrationResult {
  traceId: string | null;
  /** True only when ONYX said enter AND the consolidated risk check passed. */
  allowed: boolean;
  participation: Participation;
  degraded: boolean;
  degradedReason: string | null;
  onyxDecision: "enter" | "wait" | "reject";
  onyxRationale: string;
  terminalOutcome: TerminalOutcome;
  riskCode: string | null;
  /** Short machine-readable reason when `allowed` is false. */
  blockedReason: string | null;
}

function toDbDirection(d: CommitteeDirection): "long" | "short" | "wait" {
  return d === "no_trade" ? "wait" : d;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Immutable evidence snapshot — the same object is hashed, stored, and sent. */
export function buildPaperEvidence(c: PaperCandidateInput): Record<string, unknown> {
  return {
    schema: "paper_candidate.v2",
    symbol: c.symbol,
    direction: c.direction,
    strategy: c.leg,
    candle_ts_ms: c.entryCandleTs,
    entry: c.fillPx,
    stop: c.stopLevel,
    tp: c.tpLevel,
    zone_lower: c.zoneLower,
    zone_upper: c.zoneUpper,
    margin: c.margin,
    notional: c.notional,
    leverage: c.leverage,
    regime: c.regime,
    trend_state: c.trendState,
    trend_slope_pct: c.trendSlopePct,
    movement_score: c.movementScore,
    selection_path: c.selectionPath ?? null,
    market_evidence: c.marketEvidence ?? null,
    // Timeframe hierarchy, stated explicitly so an absent frame reads as
    // "not available" rather than "not considered". Only frames derivable
    // from the ~16h 5m feed window exist; D/W/M are reported unavailable
    // instead of being silently dropped or approximated.
    timeframes: {
      entry_tf: "15m",
      entry_tf_close_ms: c.entryCandleTs,
      setup_tf: "1h/4h",
      setup_tf_close_ms: c.htf?.lastClosed1hMs ?? null,
      regime_tf: "15m + 1d/1w/1M environment",
      regime_tf_1h_close_ms: c.htf?.lastClosed1hMs ?? null,
      regime_tf_4h_close_ms: c.htf?.lastClosed4hMs ?? null,
      bos_1h: c.htf?.bos1h ?? null,
      bos_4h: c.htf?.bos4h ?? null,
      bos_1d: c.htf?.bos1d ?? null,
      regime_tf_1d_close_ms: c.htf?.lastClosed1dMs ?? null,
      environment_tf: "1d/1w/1M",
      environment_tf_available: c.env?.available ?? false,
      environment_tf_unavailable_reason: c.env?.available
        ? null
        : (c.env?.unavailable_reason ?? "environment_frames_not_fetched"),
      environment_tf_frames: c.env?.frames ?? null,
      environment_tf_fetched_at_ms: c.env?.fetched_at_ms ?? null,
    },

  };
}

function buildSnapshot(c: PaperCandidateInput, traceId: string): MarketSnapshot {
  return {
    candidate_id: traceId,
    strategy: c.leg,
    symbol: c.symbol,
    timeframe: "15m",
    candle_close_ms: c.entryCandleTs,
    deterministic: {
      proposed_direction: c.direction,
      entry: Number.isFinite(c.fillPx) ? c.fillPx : null,
      entry_zone:
        typeof c.zoneLower === "number" && typeof c.zoneUpper === "number"
          ? { low: Math.min(c.zoneLower, c.zoneUpper), high: Math.max(c.zoneLower, c.zoneUpper) }
          : null,
      invalidation: typeof c.stopLevel === "number" ? c.stopLevel : null,
      tp_levels: typeof c.tpLevel === "number" ? [c.tpLevel] : [],
      regime: c.regime,
      trend_state: c.trendState,
      trend_slope_pct: c.trendSlopePct,
      atr_pct: c.marketEvidence?.atrPct ?? null,
      recent_closes: c.marketEvidence?.recentCloses ?? [],
      recent_highs: c.marketEvidence?.recentHighs ?? [],
      recent_lows: c.marketEvidence?.recentLows ?? [],
      volume_profile: c.marketEvidence?.recentVolumes ?? [],
    },
    higher_timeframes: {
      setup_15m_close_ms: c.htf?.lastClosed15mMs ?? null,
      regime_1h_close_ms: c.htf?.lastClosed1hMs ?? null,
      regime_4h_close_ms: c.htf?.lastClosed4hMs ?? null,
      bos_1h: c.htf?.bos1h ?? null,
      bos_4h: c.htf?.bos4h ?? null,
      bos_1d: c.htf?.bos1d ?? null,
      regime_1d_close_ms: c.htf?.lastClosed1dMs ?? null,
      environment_daily_available: c.env?.available ?? false,
      environment_frames: c.env?.available ? (c.env.frames as Record<string, unknown>) : null,
      environment_unavailable_reason: c.env?.available
        ? null
        : (c.env?.unavailable_reason ?? "environment_frames_not_fetched"),
    },
  };
}

function participationOf(answered: number): Participation {
  if (answered >= 3) return "full_3_of_3";
  if (answered === 2) return "degraded_2_of_3";
  if (answered === 1) return "degraded_1_of_3";
  return "ai_unavailable";
}

const CUSTOM_COUNCIL_ROLES = ["lead", "risk", "structure"] as const;
const CUSTOM_COUNCIL_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/**
 * Resolve an explicitly enabled user Council through a service-only Vault RPC.
 * Disabled/absent settings use the platform Council. Invalid enabled settings
 * fail closed instead of silently swapping in models the user did not choose.
 */
async function loadUserCouncil(
  ledger: SupabaseClient,
  userId: string,
): Promise<FirstRoundOptions | null> {
  const setting = await ledger
    .from("user_ai_council")
    .select("enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (setting.error) throw new Error(`council_settings:${setting.error.code ?? "read_failed"}`);
  if (!setting.data?.enabled) return null;

  const runtime = await ledger.rpc("get_user_ai_council_runtime", { p_user_id: userId });
  if (runtime.error) throw new Error(`council_runtime:${runtime.error.code ?? "read_failed"}`);
  const value = runtime.data as { enabled?: boolean; seats?: unknown[] } | null;
  if (!value?.enabled || !Array.isArray(value.seats) || value.seats.length !== 3) {
    throw new Error("custom_council_requires_three_seats");
  }

  const specs: RoleSpec[] = [];
  const credentials: FirstRoundOptions["credentials"] = {};
  const seen = new Set<string>();
  for (let index = 0; index < value.seats.length; index += 1) {
    const seat = value.seats[index] as Record<string, unknown>;
    const provider = String(seat.provider ?? "");
    const model = String(seat.model ?? "").trim();
    const apiKey = String(seat.api_key ?? "").trim();
    if (!CUSTOM_COUNCIL_PROVIDERS.has(provider) || seen.has(provider) || !model || apiKey.length < 8) {
      throw new Error(`custom_council_invalid_seat_${index + 1}`);
    }
    seen.add(provider);
    credentials[provider as "openai" | "anthropic" | "google"] = apiKey;
    specs.push({
      role: CUSTOM_COUNCIL_ROLES[index],
      provider: provider as "openai" | "anthropic" | "google",
      model,
      title: `${CUSTOM_COUNCIL_ROLES[index]} user Council seat`,
    });
  }
  return { specs, credentials, allowGatewayFallback: false };
}

interface OnyxSynthesis {
  decision: "enter" | "wait" | "reject";
  rationale: string;
  confidence: number | null;
  verdict: string;
}

/**
 * ONYX synthesis for Council-reviewed Strategy-wallet DCA candidates.
 * Models never determine size; they select only from detector opportunities
 * that failed the mechanical 2-of-3 alignment route.
 */
export function synthesizeOnyx(
  c: PaperCandidateInput,
  outcomes: ProviderOutcome[],
): OnyxSynthesis {
  const committee = aggregateCommittee(outcomes);
  const answered = outcomes.filter((o) => o.available).length;
  const parts: string[] = [
    `deterministic ${c.leg} ${c.direction} ${c.symbol} @ ${c.fillPx}`,
    `models ${answered}/3 (${committee.verdict})`,
  ];

  if (!c.deterministicApproved || c.selectionPath === "core_2_of_3") {
    parts.push("deterministic engine did not approve this candidate this tick");
    return {
      decision: "wait",
      rationale: parts.join("; "),
      confidence: committee.consensusConfidence,
      verdict: committee.verdict,
    };
  }

  if (answered < 2) {
    const staleSnapshot = outcomes.some((o) => !o.available && o.reason === "stale_snapshot");
    parts.push(staleSnapshot
      ? "market snapshot was stale — Council quorum not met; failing closed"
      : "Council quorum not met — at least two independent answers are required; failing closed");
    return {
      decision: "wait",
      rationale: parts.join("; "),
      confidence: null,
      verdict: committee.verdict,
    };
  }

  const availableProviders = outcomes
    .filter((o) => o.available)
    .map((o) => o.provider);
  if (new Set(availableProviders).size !== availableProviders.length) {
    parts.push("Council answers are not provider-independent; duplicate-provider majority blocked");
    return {
      decision: "wait",
      rationale: parts.join("; "),
      confidence: committee.consensusConfidence,
      verdict: committee.verdict,
    };
  }

  const consensus = committee.consensusDirection;
  if (!committee.availableRoles.includes("risk")) {
    parts.push("risk officer unavailable — no new exposure may be opened");
    return { decision: "wait", rationale: parts.join("; "), confidence: committee.consensusConfidence, verdict: committee.verdict };
  }
  if (consensus === "no_trade") {
    parts.push("available models recommend standing down");
    return { decision: "reject", rationale: parts.join("; "), confidence: committee.consensusConfidence, verdict: committee.verdict };
  }
  if (consensus && consensus !== c.direction) {
    parts.push(`available models favour ${consensus}, opposing the deterministic direction`);
    return { decision: "reject", rationale: parts.join("; "), confidence: committee.consensusConfidence, verdict: committee.verdict };
  }
  if (committee.riskDissent) {
    parts.push("risk officer dissents from the trade thesis; entry blocked");
    return { decision: "reject", rationale: parts.join("; "), confidence: committee.consensusConfidence, verdict: committee.verdict };
  }
  if (!consensus) {
    parts.push("Council has no majority direction; entry blocked");
    return { decision: "wait", rationale: parts.join("; "), confidence: null, verdict: committee.verdict };
  }
  if ((committee.consensusConfidence ?? 0) < MIN_COUNCIL_CONFIDENCE) {
    parts.push(`Council confidence is below ${MIN_COUNCIL_CONFIDENCE.toFixed(2)}; entry blocked`);
    return { decision: "wait", rationale: parts.join("; "), confidence: committee.consensusConfidence, verdict: committee.verdict };
  }
  if (committee.riskFlags.length) {
    parts.push(`risk flags: ${committee.riskFlags.slice(0, 6).join(", ")}`);
  }
  parts.push(`Council majority concurs on ${consensus}`);
  return {
    decision: "enter",
    rationale: parts.join("; "),
    confidence: committee.consensusConfidence,
    verdict: committee.verdict,
  };
}

export interface PaperRiskResult {
  passed: boolean;
  code: string;
  checks: { key: string; passed: boolean; code: string; detail: string }[];
}

type PaperRiskCheck = PaperRiskResult["checks"][number];

/** Pure, unit-testable geometry/sizing checks used by the consolidated gate. */
export function paperCandidateRiskChecks(c: PaperCandidateInput): PaperRiskCheck[] {
  const checks: PaperRiskCheck[] = [];
  const add = (key: string, passed: boolean, code: string, detail: string) =>
    checks.push({ key, passed, code, detail });

  const sane =
    Number.isFinite(c.fillPx) && c.fillPx > 0 &&
    Number.isFinite(c.margin) && c.margin > 0 &&
    Number.isFinite(c.leverage) && c.leverage > 0;
  add("sizing_sane", sane, sane ? "OK" : "SIZING_INVALID",
    `entry=${c.fillPx} margin=${c.margin} leverage=${c.leverage}`);

  const leverageAllowed = Number.isFinite(c.leverage) && c.leverage >= 1 && c.leverage <= TARGET_LEVERAGE;
  add("leverage_within_cap", leverageAllowed, leverageAllowed ? "OK" : "LEVERAGE_OUT_OF_RANGE",
    `leverage=${c.leverage} allowed=1..${TARGET_LEVERAGE}`);

  const stopValid = typeof c.stopLevel === "number" && Number.isFinite(c.stopLevel) && c.stopLevel > 0 &&
    (c.direction === "long" ? c.stopLevel < c.fillPx : c.stopLevel > c.fillPx);
  add("protective_stop_geometry", stopValid, stopValid ? "OK" : "STOP_GEOMETRY_INVALID",
    `direction=${c.direction} entry=${c.fillPx} stop=${c.stopLevel}`);

  const tpValid = typeof c.tpLevel === "number" && Number.isFinite(c.tpLevel) && c.tpLevel > 0 &&
    (c.direction === "long" ? c.tpLevel > c.fillPx : c.tpLevel < c.fillPx);
  add("take_profit_geometry", tpValid, tpValid ? "OK" : "TP_GEOMETRY_INVALID",
    `direction=${c.direction} entry=${c.fillPx} tp=${c.tpLevel}`);

  const expectedNotional = c.margin * c.leverage;
  const notionalDrift = expectedNotional > 0
    ? Math.abs(c.notional - expectedNotional) / expectedNotional
    : Number.POSITIVE_INFINITY;
  const notionalConsistent = Number.isFinite(c.notional) && c.notional > 0 && notionalDrift <= 0.03;
  add("notional_matches_margin", notionalConsistent, notionalConsistent ? "OK" : "NOTIONAL_MISMATCH",
    `notional=${c.notional} expected=${expectedNotional} drift=${Number.isFinite(notionalDrift) ? notionalDrift.toFixed(4) : "inf"}`);

  return checks;
}

/**
 * The ONE consolidated risk check, run after ONYX and before any intent.
 * Paper-scoped: no venue, no credentials.
 */
export async function runPaperRiskCheck(
  reader: SupabaseClient,
  userId: string,
  c: PaperCandidateInput,
): Promise<PaperRiskResult> {
  const checks: PaperRiskResult["checks"] = [];
  const add = (key: string, passed: boolean, code: string, detail: string) =>
    checks.push({ key, passed, code, detail });

  const { data: halts } = await reader
    .from("kill_switches")
    .select("scope, active, reason")
    .eq("user_id", userId)
    .eq("active", true);
  const halted = (halts ?? []).length > 0;
  add("not_halted", !halted, halted ? "EMERGENCY_HALT_ACTIVE" : "OK",
    halted ? (halts ?? []).map((h) => `${h.scope}:${h.reason ?? ""}`).join(", ") : "no active kill switch");

  const { data: dupes } = await reader
    .from("paper_positions")
    .select("id")
    .eq("user_id", userId)
    .eq("symbol", c.symbol)
    .eq("status", "open")
    .limit(1);
  const duplicate = (dupes ?? []).length > 0;
  add("no_duplicate_exposure", !duplicate, duplicate ? "DUPLICATE_EXPOSURE" : "OK",
    duplicate ? `open paper position already exists on ${c.symbol}` : "symbol has no open campaign");

  checks.push(...paperCandidateRiskChecks(c));

  const failed = checks.find((k) => !k.passed);
  return { passed: !failed, code: failed ? failed.code : "OK", checks };
}

/**
 * Fan out, synthesize, risk-check and persist ONE orchestration trace for one
 * paper candidate. Idempotent per (user, candidate key, evidence hash).
 */
export async function orchestratePaperCandidate(
  reader: SupabaseClient,
  userId: string,
  candidate: PaperCandidateInput,
  onyxDecisionId?: string | null,
): Promise<PaperOrchestrationResult> {
  const evidence = buildPaperEvidence(candidate);
  const evidenceHash = await sha256Hex(canonicalJson(evidence));

  const fail = (reason: string, outcome: TerminalOutcome = "PIPELINE_ERROR"): PaperOrchestrationResult => ({
    traceId: null,
    allowed: false,
    participation: "ai_unavailable",
    degraded: true,
    degradedReason: reason,
    onyxDecision: "wait",
    onyxRationale: `orchestration failed: ${reason}`,
    terminalOutcome: outcome,
    riskCode: null,
    blockedReason: reason,
  });

  try {
    const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
    const ledger = await ledgerClient();

    // Re-use the trace for the same candidate + identical evidence.
    const existing = await ledger
      .from(ORCHESTRATIONS_TABLE)
      .select("trace_id, gate_allowed, participation, degraded, degraded_reason, onyx_decision, onyx_rationale, terminal_outcome, risk_code, paper_position_id")
      .eq("user_id", userId)
      .eq("candidate_key", candidate.key)
      .eq("evidence_hash", evidenceHash)
      .maybeSingle();
    if (existing.data) {
      const r = existing.data as Record<string, unknown>;
      const consumed = r.paper_position_id != null;
      return {
        traceId: String(r.trace_id),
        allowed: Boolean(r.gate_allowed) && !consumed,
        participation: String(r.participation) as Participation,
        degraded: Boolean(r.degraded),
        degradedReason: (r.degraded_reason as string | null) ?? null,
        onyxDecision: String(r.onyx_decision) as "enter" | "wait" | "reject",
        onyxRationale: String(r.onyx_rationale ?? ""),
        terminalOutcome: String(r.terminal_outcome) as TerminalOutcome,
        riskCode: (r.risk_code as string | null) ?? null,
        blockedReason: consumed ? "trace_already_consumed" : (r.gate_allowed ? null : "onyx_or_risk_block"),
      };
    }

    const { runFirstRound, PROMPT_VERSION, DEFAULT_TIMEOUT_MS } = await import("@/lib/ai/committee/providers.server");
    const { createAiUsageCollector } = await import("@/lib/ai/usage.server");
    const userCouncil = await loadUserCouncil(ledger, userId);

    // ---- SNAPSHOT VALIDITY GATE (fail closed, before ANY provider call) ----
    // An unusable deterministic snapshot is a DATA fault, not an AI-availability
    // fault. It can never reach the models, ONYX, the risk check or execution.
    const validity = validateMarketSnapshot(candidate);
    if (!validity.valid) {
      const code = validity.code as string;
      const rationale =
        `blocked before provider fan-out: deterministic market snapshot invalid (${code}); ` +
        `no model was contacted and no risk check was run`;
      const denial = await ledger
        .from(ORCHESTRATIONS_TABLE)
        .insert({
          user_id: userId,
          candidate_key: candidate.key,
          symbol: candidate.symbol,
          direction: candidate.direction,
          strategy: candidate.leg,
          candle_ts_ms: candidate.entryCandleTs,
          evidence,
          evidence_hash: evidenceHash,
          prompt_version: PROMPT_VERSION,
          record_kind: "runtime",
          snapshot_valid: false,
          snapshot_invalid_code: code,
          snapshot_detail: validity.detail,
          providers_attempted: 0,
          providers_answered: 0,
          participation: "ai_unavailable",
          degraded: true,
          degraded_reason: `snapshot_invalid:${code}`,
          onyx_decision: "wait",
          onyx_rationale: rationale,
          risk_checked: false,
          risk_passed: false,
          risk_code: code,
          terminal_outcome: "NO_TRADE_DATA",
          gate_allowed: false,
          onyx_decision_id: onyxDecisionId ?? null,
        })
        .select("trace_id")
        .single();

      return {
        traceId: denial.data ? String((denial.data as { trace_id: string }).trace_id) : null,
        allowed: false,
        participation: "ai_unavailable",
        degraded: true,
        degradedReason: `snapshot_invalid:${code}`,
        onyxDecision: "wait",
        onyxRationale: rationale,
        terminalOutcome: "NO_TRADE_DATA",
        riskCode: code,
        blockedReason: code,
      };
    }


    const insert = await ledger
      .from(ORCHESTRATIONS_TABLE)
      .insert({
        user_id: userId,
        candidate_key: candidate.key,
        symbol: candidate.symbol,
        direction: candidate.direction,
        strategy: candidate.leg,
        candle_ts_ms: candidate.entryCandleTs,
        evidence,
        evidence_hash: evidenceHash,
        prompt_version: PROMPT_VERSION,
        record_kind: "runtime",
        snapshot_valid: true,
        snapshot_detail: validity.detail,
        providers_attempted: 3,
        onyx_decision_id: onyxDecisionId ?? null,
      })
      .select("trace_id")
      .single();
    if (insert.error || !insert.data) return fail(`ledger_insert:${insert.error?.code ?? "unknown"}`);
    const traceId = String((insert.data as { trace_id: string }).trace_id);

    // 1. Fan out to all three seats on the SAME immutable snapshot.
    const snapshot = buildSnapshot(candidate, traceId);
    const usage = createAiUsageCollector(userId, "paper_entry_council");
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
    }, DEFAULT_TIMEOUT_MS, { ...(userCouncil ?? {}), onAttempt: usage.onAttempt });
    await usage.flush();

    // 2. Record every seat, answered or not.
    await ledger.from(PAPER_OPINIONS_TABLE).upsert(
      outcomes.map((o) => ({
        trace_id: traceId,
        user_id: userId,
        role: o.role,
        provider: o.provider,
        model: o.model,
        status: o.available ? "evaluated" : "unavailable",
        direction: o.available ? toDbDirection(o.response.direction) : null,
        confidence: o.available ? o.response.confidence : null,
        summary: o.available ? o.response.summary.slice(0, 600) : null,
        risk_flags: o.available ? o.response.risk_flags.slice(0, 12) : [],
        latency_ms: Math.trunc(o.latencyMs),
        prompt_version: PROMPT_VERSION,
        unavailable_reason: o.available ? null : o.reason,
        advisory: true,
      })),
      { onConflict: "trace_id,role", ignoreDuplicates: true },
    );

    const answered = outcomes.filter((o) => o.available).length;
    const participation = participationOf(answered);
    const degraded = answered < 3;
    const degradedReason = degraded
      ? outcomes.filter((o) => !o.available).map((o) => `${o.role}:${o.reason}`).join(", ")
      : null;

    // 3. ONYX synthesis.
    const onyx = synthesizeOnyx(candidate, outcomes);

    // 4. Exactly one consolidated risk check, after ONYX.
    let risk: PaperRiskResult = { passed: false, code: "NOT_EVALUATED", checks: [] };
    if (onyx.decision === "enter") {
      risk = await runPaperRiskCheck(reader, userId, candidate);
    }

    const terminal: TerminalOutcome =
      onyx.decision !== "enter" ? "NO_TRADE_STRATEGY"
        : risk.passed ? "TRADE_CANDIDATE"
          : "NO_TRADE_RISK";
    const allowed = terminal === "TRADE_CANDIDATE";

    const finalized = await ledger
      .from(ORCHESTRATIONS_TABLE)
      .update({
        providers_answered: answered,
        participation,
        degraded,
        degraded_reason: degradedReason,
        committee_verdict: onyx.verdict,
        onyx_decision: onyx.decision,
        onyx_rationale: onyx.rationale.slice(0, 2000),
        onyx_confidence: onyx.confidence,
        onyx_decision_id: onyxDecisionId ?? null,
        risk_checked: onyx.decision === "enter",
        risk_passed: risk.passed,
        risk_code: risk.code,
        risk_detail: { checks: risk.checks },
        terminal_outcome: terminal,
        gate_allowed: allowed,
        updated_at: new Date().toISOString(),
      })
      .eq("trace_id", traceId);

    // The durable ledger is the execution authority. Never return an in-memory
    // approval if its final state was rejected by a database invariant: the
    // position trigger will (correctly) refuse that trace, creating a dead
    // letter on every retry.
    if (finalized.error) {
      return fail(`ledger_finalize:${finalized.error.code ?? "unknown"}`);
    }

    return {
      traceId,
      allowed,
      participation,
      degraded,
      degradedReason,
      onyxDecision: onyx.decision,
      onyxRationale: onyx.rationale,
      terminalOutcome: terminal,
      riskCode: risk.code,
      blockedReason: allowed ? null : (onyx.decision !== "enter" ? `onyx_${onyx.decision}` : `risk_${risk.code}`),
    };
  } catch (err) {
    return fail(String((err as Error)?.message ?? err).slice(0, 200));
  }
}
