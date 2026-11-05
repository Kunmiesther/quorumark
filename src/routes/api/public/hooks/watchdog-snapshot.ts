/**
 * Watchdog snapshot cron endpoint. READ-ONLY telemetry writer.
 *
 * Contract:
 *   - GET (Vercel Cron) or POST (operator), bounded body.
 *   - Auth: `Authorization: Bearer <PAPER_TICK_CRON_SECRET|CRON_SECRET>`
 *     (timing-safe).
 *     We intentionally reuse the existing cron secret rather than provisioning
 *     a second one — the endpoint's blast radius is limited to inserting
 *     health snapshot rows (no order, wallet, or position mutation).
 *
 * SAFETY: This endpoint never talks to signer, execution-broker, paper
 * engine, wallets, or orders. It only writes to ops_health_snapshots via
 * `record_ops_snapshot` (SECURITY DEFINER, auth.uid()-scoped).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  PRODUCTION_LIVE_SELECTOR,
  selectAuthoritativeHeartbeat,
  WORKER_HEARTBEAT_COLUMNS,
} from "@/lib/health/workerHealth";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const MAX_BODY_BYTES = 512;

const SECURITY_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
} as const;

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false }), { status: 401, headers: SECURITY_HEADERS });
}

const handleWatchdogSnapshot = async ({ request }: { request: Request }) => {
  if (
    !isAuthorizedCronRequest(request, [process.env.PAPER_TICK_CRON_SECRET, process.env.CRON_SECRET])
  ) {
    return unauthorized();
  }

  // Bounded body — we only accept `{}` today, but keep the shape parseable
  // so callers can add fields later without breaking the endpoint.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    return new Response(JSON.stringify({ ok: false }), { status: 413, headers: SECURITY_HEADERS });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();

  const [{ data: hb }, { data: scans }] = await Promise.all([
    supabaseAdmin
      .from("worker_heartbeats")
      .select(WORKER_HEARTBEAT_COLUMNS)
      .eq("environment", PRODUCTION_LIVE_SELECTOR.environment)
      .order("last_seen_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("scout_scans")
      .select("finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1),
  ]);

  // Deterministic authoritative selection (production/live worker).
  const authoritative = selectAuthoritativeHeartbeat(hb ?? []);
  const workerLast = authoritative ? new Date(authoritative.last_seen_at).getTime() : null;
  const scoutLast = scans?.[0]?.finished_at
    ? new Date(scans[0].finished_at as string).getTime()
    : null;

  const { evaluateComponent, rollupFleet } = await import("@/lib/ops/watchdog");
  const components = [
    evaluateComponent({
      component: "paper_worker",
      last_success_ms: workerLast,
      now_ms: now,
      freshness_budget_ms: 120_000,
    }),
    evaluateComponent({
      component: "scout_scanner",
      last_success_ms: scoutLast,
      now_ms: now,
      freshness_budget_ms: 300_000,
    }),
  ];

  // Persist snapshots (fleet-wide; user_id=null since these are aggregate).
  for (const c of components) {
    await supabaseAdmin.from("ops_health_snapshots").insert({
      user_id: null,
      component: c.component,
      state: c.state,
      reasons: c.reasons,
      last_success_at: c.last_success_at ? new Date(c.last_success_at).toISOString() : null,
      freshness_ms: c.freshness_ms,
      backlog_count: c.backlog,
      p50_latency_ms: c.p50_latency_ms,
      p95_latency_ms: c.p95_latency_ms,
    });
  }

  return new Response(
    JSON.stringify({ ok: true, fleet: rollupFleet(components), components: components.length }),
    { status: 200, headers: SECURITY_HEADERS },
  );
};

export const Route = createFileRoute("/api/public/hooks/watchdog-snapshot")({
  server: {
    handlers: {
      GET: handleWatchdogSnapshot,
      POST: handleWatchdogSnapshot,
    },
  },
});
