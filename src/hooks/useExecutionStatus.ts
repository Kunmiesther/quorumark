/**
 * useExecutionStatus — shared derivation of the ONE execution status used
 * by ExecutionStatusChip and any other surface that needs to name the
 * real live/paper routing state (e.g. the Confirmed Structure footer).
 *
 * Backend-driven only — no local toggles. Same query shape as
 * ExecutionStatusChip so both surfaces cannot disagree.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { deriveWorkerHealth } from "@/lib/health/workerHealth";
import { fetchProductionWorkerHeartbeats } from "@/lib/health/workerHealthQuery";
import { describeExecutionStatus, type ExecutionStatusResult } from "@/lib/execution-status";
import { executionReadyConnections, hasRunningLiveStrategy, liveAutomationReason } from "@/lib/automation/liveVenueReadiness";
import {
  getExecutionRuntimeHealth,
  type ExecutionRuntimeHealth,
} from "@/lib/health/executionRuntime.functions";

const MAINNET_VENUES = new Set(["apex_omni", "aster"]);
const MAINNET_ENVIRONMENTS = new Set(["production", "mainnet", "live"]);

export type UnifiedExecutionStatus = ExecutionStatusResult & {
  isLoading: boolean;
  isError: boolean;
  accountReady: boolean;
  connectedVenues: string[];
  manualTradingReady: boolean;
  /** Infrastructure and account are ready to arm the first live strategy row. */
  canArmLiveAutomation: boolean;
  /** Infrastructure is ready and at least one live strategy row is armed. */
  automationTradingReady: boolean;
  runtime: ExecutionRuntimeHealth | null;
  runtimeReason: string;
};

export function useExecutionStatus(): UnifiedExecutionStatus {
  const { user } = useAuth();
  const userId = user?.id;

  const accountQ = useQuery({
    queryKey: ["execution-status", userId],
    enabled: Boolean(userId),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async () => {
      if (!userId) {
        return {
          hasVerifiedConnection: false,
          hasMainnetConnection: false,
          hasSigningCredential: false,
          enabled: false,
          mode: null as string | null,
          readyConnections: [],
          connectedVenues: [],
          strategies: [],
        };
      }
      const [connRes, stratRes, credRes, heartbeatRes] = await Promise.all([
        supabase
          .from("exchange_connections")
          .select("id, exchange, environment, status, permission_trade, permissions_verified, is_live")
          .eq("user_id", userId),
        supabase
          .from("user_strategy")
          .select("connection_id, enabled, mode")
          .eq("user_id", userId)
          .eq("mode", "live")
          .order("symbol", { ascending: true }),
        supabase
          .from("apex_execution_credentials")
          .select("exchange_connection_id, environment, active, revoked_at")
          .eq("user_id", userId)
          .eq("environment", "mainnet")
          .eq("active", true)
          .is("revoked_at", null),
        fetchProductionWorkerHeartbeats(),
      ]);
      const readError = connRes.error ?? stratRes.error ?? credRes.error;
      if (readError) throw new Error(readError.message);
      // Authoritative runtime health: production/live worker only. The legacy
      // public.bot_heartbeat row plays no part in execution readiness.
      const worker = deriveWorkerHealth(heartbeatRes, Date.now());
      const conns = connRes.data ?? [];
      const mainnetCandidates = conns.filter(
        (c) =>
          typeof c.exchange === "string" &&
          MAINNET_VENUES.has(c.exchange) &&
          typeof c.environment === "string" &&
          MAINNET_ENVIRONMENTS.has(c.environment) &&
          c.permission_trade === true,
      );
      const verifiedMainnetCandidates = mainnetCandidates.filter(
        (c) => c.status === "verified" && c.permissions_verified === true,
      );
      const mainnetConnectionIds = new Set(verifiedMainnetCandidates.map((c) => c.id));
      const hasVerifiedConnection = conns.some((c) => c.status === "verified");
      const hasMainnetConnection = mainnetConnectionIds.size > 0;
      const permissionsVerified =
        mainnetCandidates.length === 0
          ? undefined
          : mainnetCandidates.some(
              (c) => c.status === "verified" && c.permissions_verified === true,
            );
      const readyConnections = executionReadyConnections(conns, credRes.data ?? []);
      const hasSigningCredential = readyConnections.length > 0;
      return {
        hasVerifiedConnection,
        hasMainnetConnection,
        hasSigningCredential,
        permissionsVerified,
        enabled: hasRunningLiveStrategy(readyConnections, stratRes.data ?? []),
        mode: stratRes.data?.length ? "live" : null,
        readyConnections,
        connectedVenues: verifiedMainnetCandidates.map(connection => connection.exchange),
        strategies: stratRes.data ?? [],
        workerMode: worker.mode,
        workerStatus: worker.reportedStatus,
        workerFresh: worker.ready,
      };
    },
  });

  const runtimeQ = useQuery({
    queryKey: ["execution-runtime-health"],
    enabled: Boolean(userId),
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: 1,
    queryFn: () => getExecutionRuntimeHealth(),
  });

  const data = accountQ.data;

  const meta = describeExecutionStatus({
    hasVerifiedConnection: data?.hasVerifiedConnection ?? false,
    hasMainnetConnection: data?.hasMainnetConnection ?? false,
    hasSigningCredential: data?.hasSigningCredential ?? false,
    permissionsVerified: data?.permissionsVerified,
    enabled: data?.enabled ?? false,
    mode: data?.mode ?? null,
    workerMode: data?.workerMode ?? null,
    workerStatus: data?.workerStatus ?? null,
    workerFresh: data?.workerFresh ?? false,
  });

  const runtime = runtimeQ.data ?? null;
  const accountReady = meta.status === "mainnet_active" || meta.status === "live_routing_off";
  const runtimeReadable = !runtimeQ.isError;
  const venues = runtime?.automationVenues ?? {};
  const canArmLiveAutomation = runtimeReadable && accountReady &&
    (data?.readyConnections ?? []).some(connection => venues[connection.exchange] === true);
  const automationTradingReady = runtimeReadable && accountReady &&
    hasRunningLiveStrategy(data?.readyConnections ?? [], data?.strategies ?? [], venues);
  const accountRuntimeReason = runtimeQ.isLoading || !runtime
    ? "Checking the live broker and private signer for your exchange routes."
    : liveAutomationReason(data?.readyConnections ?? [], data?.strategies ?? [], venues);

  if (accountQ.isError) {
    return {
      status: "needs_attention",
      label: "Status unavailable",
      description: "The account readiness record could not be read. No readiness is assumed.",
      tone: "warning",
      isLoading: runtimeQ.isLoading,
      isError: true,
      accountReady: false,
      connectedVenues: [],
      manualTradingReady: false,
      canArmLiveAutomation: false,
      automationTradingReady: false,
      runtime,
      runtimeReason: runtime?.reason ?? "Account readiness query failed.",
    };
  }

  return {
    ...meta,
    description: meta.status === "live_routing_off" ? accountRuntimeReason : meta.description,
    isLoading: accountQ.isLoading || runtimeQ.isLoading,
    isError: runtimeQ.isError,
    accountReady,
    connectedVenues: data?.connectedVenues ?? [],
    manualTradingReady: runtimeReadable && accountReady && runtime?.manualTradingReady === true &&
      (data?.readyConnections ?? []).some(connection => connection.exchange === "apex_omni" && connection.is_live === true),
    canArmLiveAutomation,
    automationTradingReady,
    runtime,
    runtimeReason: runtimeQ.isError
      ? "The live broker readiness probe failed. No runtime readiness is assumed."
      : accountReady
        ? accountRuntimeReason
        : (runtime?.reason ?? "Checking the live broker and private signer."),
  };
}
