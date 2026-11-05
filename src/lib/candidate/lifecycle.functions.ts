// Candidate lifecycle read/trigger layer.
//
// AUTHORITY: NONE. Reads are owner-scoped through RLS; the only write reachable
// from here is the advisory committee ledger. No order intent, signer, broker,
// or exchange credential is imported by this module or its transitive imports.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import { parseEvaluationRow } from "@/lib/ai/committee/dto";
import type { CandidateLifecycleDto, CandidateRecord } from "@/lib/candidate/lifecycle";
import {
  deriveLifecycleStates,
  evidenceNumber,
  evidenceNumbers,
  evidenceString,
  parseCandidateRow,
} from "@/lib/candidate/lifecycle";

const CANDIDATE_TABLE = "strategy_candidates";
const CANDIDATE_COLUMNS =
  "candidate_id, connection_id, strategy, symbol, timeframe, direction, candle_close_at, " +
  "market_data_at, freshness_ms, entry_zone, invalidation, tp_ladder, evidence, " +
  "evidence_hash, schema_version, technical_decision, technical_reason, idempotency_key, " +
  "ai_shadow_state, created_at";

const EVALUATION_COLUMNS =
  "id, candidate_id, strategy, symbol, timeframe, candle_close_at, schema_version, " +
  "evidence_hash, verdict, consensus_direction, consensus_confidence, risk_flags, " +
  "available_roles, unavailable_roles, risk_dissent, outcomes, total_latency_ms, advisory, " +
  "prompt_version, scorer_version, shadow_score, score_band";

/**
 * One candidate's lifecycle, addressed by candidate id (authoritative) or, only
 * when no id is supplied, by the latest completed candidate for a symbol.
 *
 * When `candidateId` is present there is deliberately NO latest-by-symbol
 * fallback: an unknown id resolves to null rather than to a different trade.
 *
 * Correlation is by candidate id (committee) and by the pre-existing
 * idempotency key (order intent) — no new coupling was introduced into the
 * execution path to make this join possible.
 */
export const getCandidateLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const candidateId = String(i.candidateId ?? "").trim();
    const symbol = String(i.symbol ?? "").trim();
    if (!candidateId && !symbol) throw new Error("candidateId or symbol is required");
    return {
      candidateId: candidateId ? candidateId.slice(0, 128) : null,
      symbol: symbol ? symbol.slice(0, 32).toUpperCase() : null,
    };
  })
  .handler(async ({ data, context }): Promise<CandidateLifecycleDto | null> => {
    const base = context.supabase.from(CANDIDATE_TABLE).select(CANDIDATE_COLUMNS);
    const { data: rows } = data.candidateId
      ? await base.eq("candidate_id", data.candidateId).limit(1)
      : await base
          .eq("symbol", data.symbol as string)
          .order("candle_close_at", { ascending: false })
          .limit(1);

    const candidate = parseCandidateRow(rows?.[0]);
    if (!candidate) return null;

    const [evalRes, intentRes] = await Promise.all([
      context.supabase
        .from("ai_committee_evaluations")
        .select(EVALUATION_COLUMNS)
        .eq("candidate_id", candidate.candidateId)
        .eq("evidence_hash", candidate.evidenceHash)
        .maybeSingle(),
      candidate.idempotencyKey
        ? context.supabase
            .from("order_intents")
            // The broker writes the worker's idempotency key (truncated to 64
            // chars) as client_order_id — the correlation handle that already
            // existed, so no execution-path schema change was needed.
            .select("id, state, symbol, side, created_at")
            .eq("client_order_id", candidate.idempotencyKey.slice(0, 64))
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const intentRow = (intentRes.data ?? null) as { state?: unknown } | null;
    const orderState =
      intentRow && typeof intentRow.state === "string" ? intentRow.state : null;
    const evaluation: CommitteeEvaluationDto | null = parseEvaluationRow(evalRes.data);

    return {
      candidate,
      evaluation,
      orderState,
      states: deriveLifecycleStates(candidate, evaluation, orderState),
    };
  });

/**
 * Recent candidates for the discovery feed, each already joined to its own
 * persisted evaluation and order state. One round trip per table — the UI does
 * no aggregation and never falls back to latest-by-symbol.
 */
export const listCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const symbol = String(i.symbol ?? "").trim();
    const limit = Number(i.limit ?? 12);
    return {
      symbol: symbol ? symbol.slice(0, 32).toUpperCase() : null,
      limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 12,
    };
  })
  .handler(async ({ data, context }): Promise<CandidateLifecycleDto[]> => {
    let query = context.supabase
      .from(CANDIDATE_TABLE)
      .select(CANDIDATE_COLUMNS)
      .order("candle_close_at", { ascending: false })
      .limit(data.limit);
    if (data.symbol) query = query.eq("symbol", data.symbol);

    const { data: rows } = await query;
    const candidates = (rows ?? [])
      .map(parseCandidateRow)
      .filter((c): c is CandidateRecord => c !== null);
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.candidateId);
    const keys = candidates
      .map((c) => c.idempotencyKey?.slice(0, 64))
      .filter((k): k is string => typeof k === "string" && k.length > 0);

    const [evalRes, intentRes] = await Promise.all([
      context.supabase
        .from("ai_committee_evaluations")
        .select(EVALUATION_COLUMNS)
        .in("candidate_id", ids),
      keys.length
        ? context.supabase
            .from("order_intents")
            .select("client_order_id, state")
            .in("client_order_id", keys)
        : Promise.resolve({ data: [] }),
    ]);

    const evaluations = new Map<string, CommitteeEvaluationDto>();
    for (const raw of evalRes.data ?? []) {
      const parsed = parseEvaluationRow(raw);
      if (parsed) evaluations.set(`${parsed.candidateId}:${parsed.evidenceHash ?? ""}`, parsed);
    }
    const intents = new Map<string, string>();
    for (const raw of (intentRes.data ?? []) as { client_order_id?: unknown; state?: unknown }[]) {
      if (typeof raw.client_order_id === "string" && typeof raw.state === "string") {
        intents.set(raw.client_order_id, raw.state);
      }
    }

    return candidates.map((candidate) => {
      const evaluation =
        evaluations.get(`${candidate.candidateId}:${candidate.evidenceHash}`) ?? null;
      const orderState = candidate.idempotencyKey
        ? (intents.get(candidate.idempotencyKey.slice(0, 64)) ?? null)
        : null;
      return {
        candidate,
        evaluation,
        orderState,
        states: deriveLifecycleStates(candidate, evaluation, orderState),
      };
    });
  });


/**
 * Ask the shadow committee about one candidate. Safe to call repeatedly: the
 * evaluation core is idempotent on (candidate id, evidence hash), so duplicate
 * worker cycles or extra browser tabs never re-spend model budget.
 */
export const requestShadowEvaluation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const candidateId = String(i.candidateId ?? "").trim();
    if (!candidateId) throw new Error("candidateId is required");
    return { candidateId: candidateId.slice(0, 128) };
  })
  .handler(async ({ data, context }): Promise<CommitteeEvaluationDto | null> => {
    const { data: row } = await context.supabase
      .from(CANDIDATE_TABLE)
      .select(CANDIDATE_COLUMNS)
      .eq("candidate_id", data.candidateId)
      .maybeSingle();

    const candidate: CandidateRecord | null = parseCandidateRow(row);
    if (!candidate) return null;

    const { evaluateSnapshot } = await import("@/lib/ai/committee/evaluate.server");
    return evaluateSnapshot(context.supabase, context.userId, {
      candidate_id: candidate.candidateId,
      strategy: candidate.strategy,
      symbol: candidate.symbol,
      timeframe: candidate.timeframe,
      candle_close_ms: Date.parse(candidate.candleCloseAt),
      deterministic: {
        proposed_direction: candidate.direction,
        entry: candidate.entryZone
          ? (candidate.entryZone.low + candidate.entryZone.high) / 2
          : null,
        entry_zone: candidate.entryZone,
        invalidation: candidate.invalidation,
        tp_levels: [],
        regime: evidenceString(candidate, "regime"),
        trend_state: evidenceString(candidate, "trend_state"),
        trend_slope_pct: evidenceNumber(candidate, "trend_slope_pct"),
        atr_pct: evidenceNumber(candidate, "atr_pct"),
        recent_closes: evidenceNumbers(candidate, "recent_closes"),
        recent_highs: evidenceNumbers(candidate, "recent_highs"),
        recent_lows: evidenceNumbers(candidate, "recent_lows"),
        volume_profile: evidenceNumbers(candidate, "volume_profile"),
      },
    });
  });
