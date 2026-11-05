/**
 * AI ADVISORY CRON HOOK — advisory only, zero trading authority.
 *
 * WHY THIS EXISTS: the three-model committee was only ever invoked by a UI
 * interaction (`evaluateDecisionCommittee`), so the "AI advisory" stage of the
 * required runtime flow never ran on its own. This endpoint runs it on a
 * schedule, AFTER the worker has already recorded each decision.
 *
 * STRUCTURAL NON-BLOCKING GUARANTEE: this runs in the web process. It has no
 * import edge and no network route to the worker, broker, signer or ApeX. A
 * missing, slow, failing or disagreeing model cannot freeze, delay, veto or
 * alter a deterministic decision — the decision was made and executed (or
 * not) in a different process before this is ever called. It writes exactly
 * advisory opinions plus post-hoc finalization/consolidation records. Every
 * opinion has `advisory = true`; none of these records submits an order.
 *
 * Auth: `Authorization: Bearer <AI_ADVISORY_CRON_SECRET|CRON_SECRET>`
 * (timing-safe). GET is the Vercel Cron path; POST remains available to the
 * internal operator scheduler.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

// Kept inside providers.server MAX_SNAPSHOT_AGE_MS (15 min) so the sweep only
// asks about snapshots the seats will actually evaluate.
const LOOKBACK_MINUTES = 12;
const MAX_DECISIONS_PER_RUN = 24;
const MAX_BODY_BYTES = 1024;

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
}

const handleAiAdvisory = async ({ request }: { request: Request }) => {
  if (
    !isAuthorizedCronRequest(request, [
      process.env.AI_ADVISORY_CRON_SECRET,
      process.env.CRON_SECRET,
    ])
  )
    return unauthorized();

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ ok: false }), { status: 413, headers: HEADERS });
  }

  // Optional, bounded backfill window. Default keeps the sweep inside
  // the model freshness window; a larger value lets an operator finalize
  // older decisions (terminal outcome only — the seats will correctly
  // record `stale_snapshot`).
  let lookbackMinutes = LOOKBACK_MINUTES;
  try {
    const body = (await request.json()) as { since_minutes?: unknown };
    const n = Number(body?.since_minutes);
    if (Number.isFinite(n) && n > 0) lookbackMinutes = Math.min(Math.floor(n), 120);
  } catch {
    // no body / not JSON — use the default window
  }

  const startedAt = Date.now();
  const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
  const { evaluateDecision } = await import("@/lib/ai/committee/decisionEvaluate.server");
  const { pendingSchema } = await import("@/lib/decision/pendingTables");
  const { finalizeDecision } = await import("@/lib/decision/pipelineFinalize.server");
  const { consolidateDecision } = await import("@/lib/ai/committee/consolidate.server");
  const ledger = await ledgerClient();

  const since = new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
  const { data: rows, error } = await pendingSchema(ledger)
    .from("strategy_decisions")
    .select("decision_id, user_id, symbol, candle_close_at")
    .gte("candle_close_at", since)
    .order("candle_close_at", { ascending: false })
    .limit(MAX_DECISIONS_PER_RUN);

  if (error) {
    return new Response(JSON.stringify({ ok: false, stage: "read" }), {
      status: 503,
      headers: HEADERS,
    });
  }

  let evaluated = 0;
  let unavailable = 0;
  let consolidated = 0;
  const failures = { review: 0, finalize: 0, consolidate: 0 };
  const finalized: Array<Record<string, unknown>> = [];
  for (const row of (rows ?? []) as Array<{ decision_id: string; user_id: string }>) {
    let opinionCount = 0;
    try {
      const opinions = await evaluateDecision(ledger, row.user_id, row.decision_id);
      opinionCount = opinions.length;
      if (opinions.some((o) => o.status === "evaluated")) evaluated += 1;
      else if (opinions.length > 0) unavailable += 1;
    } catch {
      // Advisory only: one bad decision row never aborts the sweep and
      // never affects trading.
      unavailable += 1;
      failures.review += 1;
    }
    // TERMINAL OUTCOME — runs whatever the models did. This is placed
    // deliberately OUTSIDE the try above so that a failed, missing or
    // disagreeing provider cannot stop an evaluation from reaching a
    // recorded terminal state.
    try {
      const result = await finalizeDecision(ledger, row.decision_id, opinionCount);
      if (result && !result.alreadyFinal) {
        finalized.push({
          decision_id: result.decisionId,
          symbol: result.symbol,
          trace_id: result.traceId,
          outcome: result.outcome,
          reason: result.reason,
          intent: result.intentStatus,
        });
      }
    } catch {
      // Never lose the sweep over one row.
      failures.finalize += 1;
    }
    // CONSOLIDATED ORCHESTRATION RECORD — one durable row per candidate
    // linking the three opinions, the terminal decision, the risk check
    // and the simulated intent by decision/trace id. Written last, and
    // in its own try, so it can never hold up a terminal outcome.
    try {
      const c = await consolidateDecision(ledger, row.decision_id);
      if (c?.created) consolidated += 1;
    } catch {
      // Advisory bookkeeping only.
      failures.consolidate += 1;
    }
  }

  return new Response(
    JSON.stringify({
      ok: Object.values(failures).every((count) => count === 0),
      advisory: true,
      scanned: (rows ?? []).length,
      evaluated,
      unavailable,
      consolidated,
      failures,
      finalized,
      duration_ms: Date.now() - startedAt,
    }),
    { status: Object.values(failures).some((count) => count > 0) ? 503 : 200, headers: HEADERS },
  );
};

export const Route = createFileRoute("/api/public/hooks/ai-advisory")({
  server: {
    handlers: {
      GET: handleAiAdvisory,
      POST: handleAiAdvisory,
    },
  },
});
