// Shadow-mode AI committee server functions.
//
// AUTHORITY: NONE. These functions read a strategy candidate, ask three
// independent models for an opinion, persist a sanitized record, and return
// it for display. They cannot submit, resize, cancel, or close anything:
// no signer client, no broker client, and no exchange credential is
// reachable from this module or its imports. The only privileged capability
// used is a service-role write to the evaluations ledger, so the browser
// cannot fabricate committee records.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseEvaluationRow, type CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";

const EVALUATIONS_TABLE = "ai_committee_evaluations";
const EVALUATION_COLUMNS =
  "id, candidate_id, strategy, symbol, timeframe, candle_close_at, schema_version, " +
  "evidence_hash, verdict, consensus_direction, consensus_confidence, risk_flags, " +
  "available_roles, unavailable_roles, risk_dissent, outcomes, total_latency_ms, advisory, " +
  "prompt_version, scorer_version, shadow_score, score_band";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function numArray(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
}

/**
 * Evaluate one naturally generated strategy candidate. Read-only with
 * respect to trading; the only write is the sanitized evaluation record.
 */
export const evaluateCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const candidateId = String(i.candidateId ?? "").trim();
    const symbol = String(i.symbol ?? "").trim();
    if (!candidateId) throw new Error("candidateId is required");
    if (!symbol) throw new Error("symbol is required");
    const d = (i.deterministic ?? {}) as Record<string, unknown>;
    const zone = d.entryZone as Record<string, unknown> | null | undefined;
    return {
      candidateId: candidateId.slice(0, 128),
      strategy: String(i.strategy ?? "unknown").slice(0, 64),
      symbol: symbol.slice(0, 32),
      timeframe: String(i.timeframe ?? "15m").slice(0, 16),
      candleCloseMs: num(i.candleCloseMs) ?? 0,
      deterministic: {
        proposed_direction: (d.direction === "long" || d.direction === "short"
          ? d.direction
          : "no_trade") as "long" | "short" | "no_trade",
        entry: num(d.entry),
        entry_zone:
          zone && num(zone.low) != null && num(zone.high) != null
            ? { low: num(zone.low)!, high: num(zone.high)! }
            : null,
        invalidation: num(d.invalidation),
        tp_levels: numArray(d.tpLevels),
        regime: d.regime == null ? null : String(d.regime).slice(0, 32),
        trend_state: d.trendState == null ? null : String(d.trendState).slice(0, 32),
        trend_slope_pct: num(d.trendSlopePct),
        atr_pct: num(d.atrPct),
        recent_closes: numArray(d.recentCloses).slice(-60),
        recent_highs: numArray(d.recentHighs).slice(-60),
        recent_lows: numArray(d.recentLows).slice(-60),
        volume_profile: numArray(d.volumeProfile).slice(-60),
      },
    };
  })
  .handler(async ({ data, context }): Promise<CommitteeEvaluationDto | null> => {
    // Server-only modules are loaded inside the handler so nothing in the
    // provider layer can be pulled into a client bundle.
    const { evaluateSnapshot } = await import("@/lib/ai/committee/evaluate.server");
    const snapshot: MarketSnapshot = {
      candidate_id: data.candidateId,
      strategy: data.strategy,
      symbol: data.symbol,
      timeframe: data.timeframe,
      candle_close_ms: data.candleCloseMs,
      deterministic: data.deterministic,
    };
    return evaluateSnapshot(context.supabase, context.userId, snapshot);
  });

/** Most recent shadow evaluations for a symbol, for history views. */
export const listCommitteeEvaluations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    return {
      symbol: i.symbol == null ? null : String(i.symbol).slice(0, 32),
      limit: Math.min(20, Math.max(1, Number(i.limit) || 5)),
    };
  })
  .handler(async ({ data, context }): Promise<CommitteeEvaluationDto[]> => {
    let q = context.supabase
      .from(EVALUATIONS_TABLE)
      .select(EVALUATION_COLUMNS)
      .order("candle_close_at", { ascending: false })
      .limit(data.limit);
    if (data.symbol) q = q.eq("symbol", data.symbol);
    const { data: rows, error } = await q;
    if (error) throw new Error("Could not load committee evaluations");
    return (rows ?? [])
      .map(parseEvaluationRow)
      .filter((r): r is CommitteeEvaluationDto => r !== null);
  });
