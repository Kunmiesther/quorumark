import { supabase } from "@/integrations/supabase/client";
import type { WorkerHeartbeatRow } from "@/lib/health/workerHealth";

/**
 * Read the narrow authenticated health summary rather than the protected
 * worker table. The synthetic id is local-only and is never shown to users.
 */
export async function fetchProductionWorkerHeartbeats(): Promise<WorkerHeartbeatRow[]> {
  const result = await supabase.rpc("get_production_worker_health");

  if (result.error) throw new Error(result.error.message);

  return (result.data ?? []).map((row) => ({
    worker_id: "production-live",
    environment: row.environment,
    mode: row.mode,
    status: row.status,
    last_seen_at: row.last_seen_at,
    health: { credentials_ok: row.credentials_ok },
    version: null,
  }));
}
