// Intelligence feed for the committee surface.
//
// AUTHORITY: NONE. Read-only. This function exists because the committee
// ledger is keyed on the DECISION id produced by the autonomous sweep
// (`dec_v1_*`), while the older desk panels only ever looked up evaluations
// through `strategy_candidates` (`cand_v1_*`) joined on evidence hash. That
// join can never match a sweep-produced row, which is why fresh evaluations
// rendered as "no opinions". This path reads the ledger directly.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseEvaluationRow, type CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import {
  buildIntelligenceMetrics,
  type IntelligenceMetrics,
} from "@/lib/ai/intelligence/metrics";

const EVALUATION_COLUMNS =
  "id, candidate_id, strategy, symbol, timeframe, candle_close_at, schema_version, " +
  "evidence_hash, verdict, consensus_direction, consensus_confidence, risk_flags, " +
  "available_roles, unavailable_roles, risk_dissent, outcomes, total_latency_ms, advisory, " +
  "prompt_version, scorer_version, shadow_score, score_band";

const WINDOW_MS = 7 * 86_400_000;
const MAX_ROWS = 400;

export interface IntelligenceFeed {
  serverTimeMs: number;
  symbol: string | null;
  /** Newest persisted evaluation for the requested symbol. */
  latest: CommitteeEvaluationDto | null;
  /** Newest evaluations across symbols, for the live activity rail. */
  recent: CommitteeEvaluationDto[];
  metrics: IntelligenceMetrics;
}

export const getIntelligenceFeed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    return {
      symbol: i.symbol == null ? null : String(i.symbol).slice(0, 32),
      recentLimit: Math.min(30, Math.max(1, Number(i.recentLimit) || 12)),
    };
  })
  .handler(async ({ data, context }): Promise<IntelligenceFeed> => {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_committee_evaluations")
      .select(EVALUATION_COLUMNS)
      .gte("candle_close_at", since)
      .order("candle_close_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw new Error("Could not load committee evaluations");

    const all = (rows ?? [])
      .map(parseEvaluationRow)
      .filter((r): r is CommitteeEvaluationDto => r !== null);

    // Outcome attribution is by candidate id only. No fuzzy matching, so an
    // evaluation without a closed outcome is reported as awaiting, never
    // silently paired with an unrelated trade.
    const ids = Array.from(new Set(all.map((e) => e.candidateId))).slice(0, MAX_ROWS);
    const matched = new Set<string>();
    if (ids.length) {
      const { data: outcomes } = await context.supabase
        .from("candidate_outcomes")
        .select("candidate_id, status")
        .eq("status", "closed")
        .in("candidate_id", ids);
      for (const row of outcomes ?? []) {
        const id = (row as { candidate_id?: unknown }).candidate_id;
        if (typeof id === "string") matched.add(id);
      }
    }

    const forSymbol = data.symbol ? all.filter((e) => e.symbol === data.symbol) : all;

    return {
      serverTimeMs: Date.now(),
      symbol: data.symbol,
      latest: forSymbol[0] ?? null,
      recent: all.slice(0, data.recentLimit),
      metrics: buildIntelligenceMetrics(all, Date.now(), matched),
    };
  });
