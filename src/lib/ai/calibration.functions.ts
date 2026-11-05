// Calibration read path for the SHADOW committee.
//
// AUTHORITY: NONE. Read-only: joins the owner's advisory evaluations to their
// completed candidate outcomes and returns pure metrics. No write, no signer,
// no broker, no order path is reachable from this module.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildCalibrationReport,
  calibrationSampleSchema,
  type CalibrationReport,
  type CalibrationSample,
} from "@/lib/ai/calibration/metrics";

const MAX_ROWS = 500;

export const getCommitteeCalibration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    return { symbol: i.symbol == null ? null : String(i.symbol).slice(0, 32) };
  })
  .handler(async ({ data, context }): Promise<CalibrationReport> => {
    let evalQuery = context.supabase
      .from("ai_committee_evaluations")
      .select("candidate_id, verdict, score_band, shadow_score, prompt_version, scorer_version")
      .order("candle_close_at", { ascending: false })
      .limit(MAX_ROWS);
    if (data.symbol) evalQuery = evalQuery.eq("symbol", data.symbol);

    const [evals, outcomes] = await Promise.all([
      evalQuery,
      context.supabase
        .from("candidate_outcomes")
        .select("candidate_id, status, outcome, r_multiple, realized_pnl_usd")
        .eq("status", "closed")
        .order("closed_at", { ascending: false })
        .limit(MAX_ROWS),
    ]);
    if (evals.error || outcomes.error) throw new Error("Could not load calibration data");

    const byCandidate = new Map<string, Record<string, unknown>>();
    for (const row of outcomes.data ?? []) {
      const r = row as Record<string, unknown>;
      byCandidate.set(String(r.candidate_id), r);
    }

    const samples: CalibrationSample[] = [];
    for (const row of evals.data ?? []) {
      const e = row as Record<string, unknown>;
      const o = byCandidate.get(String(e.candidate_id));
      // No completed outcome means the candidate is not counted at all.
      if (!o) continue;
      const parsed = calibrationSampleSchema.safeParse({
        verdict: e.verdict,
        scoreBand: e.score_band ?? null,
        shadowScore: e.shadow_score == null ? null : Number(e.shadow_score),
        promptVersion: e.prompt_version ?? null,
        scorerVersion: e.scorer_version ?? null,
        status: o.status,
        outcome: o.outcome ?? null,
        rMultiple: o.r_multiple == null ? null : Number(o.r_multiple),
        realizedPnlUsd: o.realized_pnl_usd == null ? null : Number(o.realized_pnl_usd),
      });
      if (parsed.success) samples.push(parsed.data);
    }

    return buildCalibrationReport(samples);
  });
