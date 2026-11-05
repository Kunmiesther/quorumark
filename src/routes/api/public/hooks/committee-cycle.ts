/**
 * COMMITTEE CYCLE CRON HOOK — Scout-wide shortlist, one pass per completed
 * 15m decision candle. Five-minute activity is position supervision only.
 *
 * Runs `runCommitteeCycle` for every user with an enabled paper universe.
 * Writes only `committee_cycles` + `committee_shortlist` (plus the existing
 * advisory `ai_committee_evaluations` ledger). ZERO EXECUTION AUTHORITY: no
 * signer, broker or credential import edge exists from this route.
 *
 * Auth: `Authorization: Bearer <PAPER_TICK_CRON_SECRET|CRON_SECRET>`
 * (timing-safe). Vercel Cron invokes routes with GET, while the operator
 * replay surface uses POST; both methods execute the same bounded handler.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

const handleCommitteeCycle = async ({ request }: { request: Request }) => {
  if (
    !isAuthorizedCronRequest(request, [process.env.PAPER_TICK_CRON_SECRET, process.env.CRON_SECRET])
  ) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
  }

  const started = Date.now();
  let body: { user_id?: string; dry_run?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { runCommitteeCycle } = await import("@/lib/ai/committee/cycle.server");

  let userIds: string[];
  if (body.user_id) {
    userIds = [body.user_id];
  } else {
    const { data } = await supabaseAdmin
      .from("paper_test_symbols")
      .select("user_id")
      .eq("enabled", true);
    userIds = Array.from(new Set((data ?? []).map((r) => r.user_id as string)));
  }

  const results: unknown[] = [];
  for (const userId of userIds) {
    try {
      results.push({
        userId,
        ...(await runCommitteeCycle(supabaseAdmin, userId, {
          book: "paper",
          dryRun: body.dry_run === true,
        })),
      });
    } catch (e) {
      results.push({
        userId,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      advisory: true,
      processed: userIds.length,
      duration_ms: Date.now() - started,
      results,
    }),
    { headers: HEADERS },
  );
};

export const Route = createFileRoute("/api/public/hooks/committee-cycle")({
  server: {
    handlers: {
      GET: handleCommitteeCycle,
      POST: handleCommitteeCycle,
    },
  },
});
