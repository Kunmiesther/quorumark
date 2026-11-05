/**
 * Paper-tick cron endpoint. SIMULATION ONLY.
 *
 * Contract:
 *   - GET (Vercel Cron) or POST (operator), bounded body.
 *   - Auth: `Authorization: Bearer <PAPER_TICK_CRON_SECRET|CRON_SECRET>`
 *     (timing-safe).
 *   - Bounded aggregate response — no per-user detail, no error text, no IDs.
 *   - Every retained tick entry point uses `public.claim_paper_tick` for a
 *     durable per-(user, minute) lease so duplicates from cron / tabs /
 *     replicas execute `runPaperTick` at most once.
 *
 * SAFETY: This endpoint never talks to signer, execution-broker, or any
 * order table. It only writes to paper_wallets / paper_positions /
 * paper_trades / bot_events. `is_live` stays false.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

// Only run for users with recent paper activity to avoid ticking forever on
// abandoned accounts.
const ACTIVITY_WINDOW_DAYS = 7;
const MAX_USERS_PER_TICK = 50;
const MAX_BODY_BYTES = 1024;

const SECURITY_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
} as const;

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false }), {
    status: 401,
    headers: SECURITY_HEADERS,
  });
}

const handlePaperTick = async ({ request }: { request: Request }) => {
  // Fail-closed auth. The secret is server-only; anon / publishable
  // keys are NOT accepted here.
  // Vercel Cron always authenticates with CRON_SECRET. Keep the dedicated
  // paper secret valid for manual/internal invocations, but do not let it
  // shadow Vercel's platform credential when both are configured.
  if (
    !isAuthorizedCronRequest(request, [process.env.PAPER_TICK_CRON_SECRET, process.env.CRON_SECRET])
  ) {
    return unauthorized();
  }

  // Bounded body — reject anything oversized.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 413,
      headers: SECURITY_HEADERS,
    });
  }

  const startedAt = Date.now();

  // GLOBAL PAPER KILL SWITCH — exit before any scan or DB work.
  const { isPaperEngineEnabled } = await import("@/lib/paper/killSwitch");
  if (!isPaperEngineEnabled()) {
    return new Response(
      JSON.stringify({
        ok: true,
        disabled: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        durationMs: Date.now() - startedAt,
      }),
      { headers: SECURITY_HEADERS },
    );
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { runPaperTick } = await import("@/lib/paper/engine");
  const { runAgenticSweep } = await import("@/lib/paper/agenticSweep.server");

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let managedPositions = 0;
  let managementEvents = 0;
  let tradesReviewed = 0;
  let sweepErrors = 0;

  try {
    const windowIso = new Date(
      Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: symUsers, error: symErr } = await supabaseAdmin
      .from("paper_test_symbols")
      .select("user_id")
      .eq("enabled", true);
    if (symErr) throw new Error("symbols-query");

    const candidateIds = Array.from(new Set((symUsers ?? []).map((r) => r.user_id as string)));
    if (candidateIds.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          processed: 0,
          succeeded: 0,
          failed: 0,
          durationMs: Date.now() - startedAt,
        }),
        { headers: SECURITY_HEADERS },
      );
    }

    const { data: activeWallets, error: wErr } = await supabaseAdmin
      .from("paper_wallets")
      .select("user_id,last_tick_at")
      .in("user_id", candidateIds);
    if (wErr) throw new Error("wallets-query");

    const activeSet = new Set<string>();
    for (const w of activeWallets ?? []) {
      const uid = w.user_id as string;
      const last = w.last_tick_at as string | null;
      if (last == null || last >= windowIso) activeSet.add(uid);
    }
    const userIds = Array.from(activeSet).slice(0, MAX_USERS_PER_TICK);

    for (const userId of userIds) {
      processed += 1;
      try {
        // Durable per-minute lease. service_role can claim any user.
        const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("claim_paper_tick", {
          _user_id: userId,
        });
        if (claimErr) {
          failed += 1;
          continue;
        }
        if (claimed !== true) {
          // Another worker already handled this (user, minute) — no-op.
          continue;
        }
        // runPaperTick gates entries per plan while continuing open-position management.
        await runPaperTick(supabaseAdmin, userId);
        succeeded += 1;

        // Agentic layer runs after the deterministic tick has already
        // committed, and never fails the tick.
        const sweep = await runAgenticSweep(supabaseAdmin, userId);
        managedPositions += sweep.management.positions;
        managementEvents += sweep.management.events;
        tradesReviewed += sweep.review.reviewed;
        sweepErrors += sweep.management.errors + sweep.review.errors;
      } catch {
        // Sanitized: never surface per-user IDs or error text.
        failed += 1;
      }
    }
  } catch {
    // Sanitized bounded response — the operator sees categories, not stack traces.
    return new Response(
      JSON.stringify({
        ok: false,
        processed,
        succeeded,
        failed,
        durationMs: Date.now() - startedAt,
      }),
      { status: 500, headers: SECURITY_HEADERS },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed,
      succeeded,
      failed,
      managedPositions,
      managementEvents,
      tradesReviewed,
      sweepErrors,
      durationMs: Date.now() - startedAt,
    }),
    { headers: SECURITY_HEADERS },
  );
};

export const Route = createFileRoute("/api/public/hooks/paper-tick")({
  server: {
    handlers: {
      GET: handlePaperTick,
      POST: handlePaperTick,
    },
  },
});
