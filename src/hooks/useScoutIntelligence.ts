/**
 * useScoutIntelligence — fetches the latest Scout MTF fleet report.
 *
 * The server function is idempotent per-minute (unique bucket) so multiple
 * concurrent UI consumers coalesce naturally. When Scout is off, the query
 * short-circuits without running a scan.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { runScoutScan } from "@/lib/scout/scan.functions";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { useAuth } from "@/hooks/useAuth";
import type { ScoutFleetReport } from "@/lib/scout/types";

const REFRESH_MS = 60_000;

export function useScoutIntelligence() {
  const scan = useServerFn(runScoutScan);
  const { active, loading: prefLoading } = useScoutActivation();
  const { isReady, user } = useAuth();
  const enabled = isReady && !!user && active;

  return useQuery<ScoutFleetReport>({
    queryKey: ["scout", "intelligence", user?.id ?? "anon"],
    enabled,
    refetchInterval: enabled ? REFRESH_MS : false,
    refetchOnWindowFocus: enabled,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => scan(),
    placeholderData: (prev) => prev,
    meta: { scoutOff: !active, prefLoading },
  });
}
