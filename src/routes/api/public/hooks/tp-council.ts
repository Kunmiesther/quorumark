/**
 * DEFERRED TP COUNCIL CRON HOOK.
 *
 * Runs the take-profit council over every OPEN live position whose three
 * fully closed execution-timeframe candles have printed since the fill.
 * Idempotent per (position, review number) — safe to call every minute and
 * safe across restarts.
 *
 * Auth: `Authorization: Bearer <AI_ADVISORY_CRON_SECRET|CRON_SECRET>`
 * (timing-safe). GET is the Vercel Cron path.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

const handleTpCouncil = async ({ request }: { request: Request }) => {
  if (
    !isAuthorizedCronRequest(request, [
      process.env.AI_ADVISORY_CRON_SECRET,
      process.env.CRON_SECRET,
    ])
  ) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
  }

  const started = Date.now();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { runTpCouncilSweep } = await import("@/lib/live/tpCouncil.server");
  try {
    const out = await runTpCouncilSweep(supabaseAdmin, process.env);
    return new Response(JSON.stringify({ ok: true, ...out, duration_ms: Date.now() - started }), {
      headers: HEADERS,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        stage: "sweep",
        error: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      }),
      { status: 200, headers: HEADERS },
    );
  }
};

export const Route = createFileRoute("/api/public/hooks/tp-council")({
  server: {
    handlers: {
      GET: handleTpCouncil,
      POST: handleTpCouncil,
    },
  },
});
