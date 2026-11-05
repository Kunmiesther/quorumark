import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const headers = { "content-type": "application/json", "cache-control": "no-store" };

async function handleLivePositions({ request }: { request: Request }) {
  if (!isAuthorizedCronRequest(request, [process.env.CRON_SECRET, process.env.AI_ADVISORY_CRON_SECRET])) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers });
  }
  // Independent read-only cadence: position visibility must not depend on AI reviews.
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.functions.invoke("reconcile-live-positions", {
      body: {},
      ...(process.env.SUPABASE_SECRET_KEY ? { headers: { apikey: process.env.SUPABASE_SECRET_KEY } } : {}),
    });
    if (error || data?.ok !== true) {
      console.error("[live-positions] Exchange read failed", { status: error?.context?.status ?? null });
      return new Response(JSON.stringify({ ok: false, error: "POSITION_REFRESH_FAILED" }), { status: 502, headers });
    }
    const failures = (Array.isArray(data.results) ? data.results : []).filter(
      (row: { ok?: boolean; skipped?: string }) => row.ok !== true && !row.skipped,
    );
    if (failures.length) console.warn("[live-positions] Partial exchange read", { failed: failures.length });
    return new Response(JSON.stringify({ ok: failures.length === 0, count: data.count }), { headers });
  } catch {
    console.error("[live-positions] Position refresh unavailable");
    return new Response(JSON.stringify({ ok: false, error: "POSITION_REFRESH_UNAVAILABLE" }), { status: 502, headers });
  }
}

export const Route = createFileRoute("/api/public/hooks/live-positions")({
  server: { handlers: { GET: handleLivePositions } },
});
