/**
 * LIVE ADVISORY CRON HOOK — owner-only, advisory only, zero authority.
 *
 * Runs the three-seat committee over every OPEN live position belonging to an
 * owner (admin) account, once per 5m candle. Writes only
 * `live_position_advisories` + `live_position_advisory_opinions`.
 *
 * STRUCTURAL NON-BLOCKING GUARANTEE: this runs in the web process, has no
 * import edge to the signer, broker or worker, and cannot place, cancel,
 * resize or close an order. Existing venue orders (including the owner's ETH
 * sell limit) are read as context only and are never touched.
 *
 * Auth: `Authorization: Bearer <AI_ADVISORY_CRON_SECRET|CRON_SECRET>`
 * (timing-safe). GET is the Vercel Cron path.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

const handleLiveAdvisory = async ({ request }: { request: Request }) => {
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
  const { runLiveAdvisorySweep } = await import("@/lib/live/liveAdvisory.server");

  try {
    const out = await runLiveAdvisorySweep(supabaseAdmin, process.env);
    return new Response(
      JSON.stringify({ ok: true, advisory: true, ...out, duration_ms: Date.now() - started }),
      { headers: HEADERS },
    );
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

export const Route = createFileRoute("/api/public/hooks/live-advisory")({
  server: {
    handlers: {
      GET: handleLiveAdvisory,
      POST: handleLiveAdvisory,
    },
  },
});
