/**
 * Ops control-plane server functions.
 *
 * Read-only aggregation over existing telemetry surfaces (worker_heartbeats,
 * scout_scans, onyx_decisions, ops_events, ops_health_snapshots, paper_*).
 * Fails closed: any missing signal returns STALE / DEGRADED, never HEALTHY.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateComponent, rollupFleet, type ComponentHealth } from "./watchdog";
import { CAPABILITY_MATRIX } from "./capabilityMatrix";
import { SLO } from "./slo";
import {
  deriveWorkerHealth,
  PRODUCTION_LIVE_SELECTOR,
  WORKER_HEARTBEAT_COLUMNS,
  type WorkerHealth,
} from "@/lib/health/workerHealth";

interface OpsHealthResult {
  fleet_state: "HEALTHY" | "DEGRADED" | "STALE" | "HALTED";
  server_ts: number;
  components: ComponentHealth[];
  recent_decisions: Array<{
    id: string;
    symbol: string;
    decision: string;
    reject_reason: string | null;
    decision_latency_ms: number | null;
    decision_at: string;
  }>;
  recent_events: Array<{
    id: string;
    correlation_id: string;
    stage: string;
    component: string;
    severity: string;
    message: string;
    server_ts: string;
  }>;
  capability_matrix: typeof CAPABILITY_MATRIX;
  slo_targets: typeof SLO;
  /** Mainnet remains disabled. */
  mainnet_enabled: boolean;
  /** Authoritative worker runtime health (production/live worker_heartbeats). */
  worker_health: Omit<WorkerHealth, "healthPayload">;
}

export const getOpsHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OpsHealthResult> => {
    const { supabase, userId } = context;
    const now = Date.now();

    // Freshest worker heartbeat.
    const { data: hb } = await supabase
      .from("worker_heartbeats")
      .select(WORKER_HEARTBEAT_COLUMNS)
      .eq("environment", PRODUCTION_LIVE_SELECTOR.environment)
      .order("last_seen_at", { ascending: false })
      .limit(50);

    // Freshest scout scan.
    const { data: scanRows } = await supabase
      .from("scout_scans")
      .select("id, finished_at, started_at, health")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(5);

    // Recent Onyx decisions with latency (typed via generic).
    const { data: decisions } = await supabase
      .from("onyx_decisions" as never)
      .select("id, symbol, decision, reject_reason, decision_latency_ms, decision_at")
      .eq("user_id", userId)
      .order("decision_at", { ascending: false })
      .limit(20) as unknown as { data: Array<{ id: string; symbol: string; decision: string; reject_reason: string | null; decision_latency_ms: number | null; decision_at: string }> | null };

    // Recent ops events (correlation log).
    const { data: events } = await supabase
      .from("ops_events" as never)
      .select("id, correlation_id, stage, component, severity, message, server_ts")
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order("server_ts", { ascending: false })
      .limit(50) as unknown as { data: Array<{ id: string; correlation_id: string; stage: string; component: string; severity: string; message: string; server_ts: string }> | null };

    // Authoritative worker health (production/live). Legacy public.bot_heartbeat
    // is never consulted for readiness.
    const workerHealth = deriveWorkerHealth(hb ?? [], now);
    const { healthPayload: _healthPayload, ...workerHealthSummary } = workerHealth;
    const workerLast =
      workerHealth.ready && workerHealth.lastSeenAt
        ? new Date(workerHealth.lastSeenAt).getTime()
        : null;
    const okScan = scanRows?.find((s) => s.finished_at != null);
    const scoutLast = okScan?.finished_at
      ? new Date(okScan.finished_at as string).getTime()
      : null;
    const onyxLast = decisions?.[0]?.decision_at
      ? new Date(decisions[0].decision_at).getTime()
      : null;

    const decisionLatencies = (decisions ?? [])
      .map((d) => d.decision_latency_ms)
      .filter((v): v is number => typeof v === "number");

    const components: ComponentHealth[] = [
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
      evaluateComponent({
        component: "onyx_decider",
        last_success_ms: onyxLast,
        now_ms: now,
        freshness_budget_ms: 600_000,
        latency_samples_ms: decisionLatencies,
        p95_budget_ms: SLO.onyx_decision_ms.p95,
      }),
    ];

    return {
      fleet_state: rollupFleet(components),
      server_ts: now,
      components,
      recent_decisions: (decisions ?? []) as OpsHealthResult["recent_decisions"],
      recent_events: (events ?? []) as OpsHealthResult["recent_events"],
      capability_matrix: CAPABILITY_MATRIX,
      slo_targets: SLO,
      mainnet_enabled: false,
      worker_health: workerHealthSummary,
    };
  });
