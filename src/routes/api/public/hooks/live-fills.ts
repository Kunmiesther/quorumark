/**
 * Cron-only venue fill reconciliation plus five-minute SynFutures readiness observation.
 * Neither path signs trades, funds wallets, activates accounts, or writes open positions.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

const handleLiveFills = async ({ request }: { request: Request }) => {
  if (!isAuthorizedCronRequest(request, [process.env.CRON_SECRET])) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const fillRead = supabaseAdmin.functions.invoke("ingest-live-fills", {
      body: {},
      // Keep the existing server bearer for gateway compatibility, while
      // authenticating against the project's current secret API key in-code.
      // Never use a VITE/public environment variable for this credential.
      ...(process.env.SUPABASE_SECRET_KEY
        ? { headers: { apikey: process.env.SUPABASE_SECRET_KEY } }
        : {}),
    });
    const synRead = new Date().getUTCMinutes() % 5 === 0
      ? import("@/lib/exchanges/synfutures/readinessSweep.server").then(({ runSynFuturesReadinessSweep }) =>
          runSynFuturesReadinessSweep(supabaseAdmin))
      : Promise.resolve(null);
    const [fillResult, synResult] = await Promise.allSettled([fillRead, synRead]);
    const synfutures = synResult.status === "fulfilled" ? synResult.value : { scanned: 0, observed: 0, blocked: 0, failed: 1 };
    const { data, error } = fillResult.status === "fulfilled" ? fillResult.value : { data: null, error: true };
    if (error || !data?.ok) {
      return new Response(JSON.stringify({ ok: false, stage: "fill_sync" }), {
        status: 503,
        headers: HEADERS,
      });
    }
    const results = Array.isArray(data.results) ? data.results : [];
    const succeeded = results.filter((item: { ok?: boolean }) => item?.ok === true).length;
    const failed = results.length - succeeded;
    const ok = failed === 0 && (synfutures?.failed ?? 0) === 0;
    return new Response(
      JSON.stringify({
        ok,
        connections: results.length,
        succeeded,
        failed,
        synfutures,
      }),
      { status: ok ? 200 : 503, headers: HEADERS },
    );
  } catch {
    return new Response(JSON.stringify({ ok: false, stage: "fill_sync" }), {
      status: 503,
      headers: HEADERS,
    });
  }
};

export const Route = createFileRoute("/api/public/hooks/live-fills")({
  server: { handlers: { GET: handleLiveFills, POST: handleLiveFills } },
});
