import { useQuery } from "@tanstack/react-query";
import {
  deriveWorkerHealth,
  PRODUCTION_LIVE_SELECTOR,
  type AuthoritativeSelector,
  type WorkerHealth,
} from "@/lib/health/workerHealth";
import { fetchProductionWorkerHeartbeats } from "@/lib/health/workerHealthQuery";

/**
 * Authoritative worker health for UI surfaces.
 * Reads only `public.worker_heartbeats` — never the legacy `bot_heartbeat` row.
 */
export function useWorkerHealth(selector: AuthoritativeSelector = PRODUCTION_LIVE_SELECTOR): {
  health: WorkerHealth;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ["worker-heartbeats", selector.environment, selector.mode],
    refetchInterval: 15_000,
    queryFn: fetchProductionWorkerHeartbeats,
  });

  return {
    health: deriveWorkerHealth(data ?? [], Date.now(), selector),
    isLoading,
  };
}
