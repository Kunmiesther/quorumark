// Bot health surface: worker heartbeat, active strategy, kill switches,
// and derived "TurtleBot state" for header pills.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  deriveWorkerHealth,
  PRODUCTION_LIVE_SELECTOR,
  type WorkerHealth,
} from "@/lib/health/workerHealth";
import { fetchProductionWorkerHeartbeats } from "@/lib/health/workerHealthQuery";

export type BotState = "offline" | "observing" | "paper" | "halted" | "live" | "unknown";

export function useBotHealth() {
  const { user } = useAuth();

  const strategyQ = useQuery({
    queryKey: ["user-strategy", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("enabled, mode, market_type, cross_margin, strategies(name, slug)")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const heartbeatQ = useQuery({
    queryKey: ["worker-heartbeats", PRODUCTION_LIVE_SELECTOR.environment],
    refetchInterval: 15_000,
    queryFn: fetchProductionWorkerHeartbeats,
  });

  const killQ = useQuery({
    queryKey: ["kill-switches-any", user?.id],
    enabled: !!user,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kill_switches")
        .select("scope, active")
        .eq("active", true);
      if (error) return [];
      return (data ?? []) as { scope: string; active: boolean }[];
    },
  });

  const worker: WorkerHealth = deriveWorkerHealth(heartbeatQ.data ?? [], Date.now());
  // Fail closed: only a fresh, healthy, credentialed worker counts as live-ready.
  const heartbeatFresh = worker.ready;
  const hbAgeSec = worker.ageMs === null ? Infinity : Math.round(worker.ageMs / 1000);
  const anyKill = (killQ.data ?? []).length > 0;

  let state: BotState = "unknown";
  if (anyKill) state = "halted";
  else if (!worker.ready) state = "offline";
  else if (strategyQ.data?.enabled) {
    const mode = (strategyQ.data.mode ?? worker.mode ?? "").toLowerCase();
    if (mode === "live") state = "live";
    else if (mode === "paper") state = "paper";
    else state = "observing";
  } else {
    state = "observing";
  }

  return {
    state,
    strategy: strategyQ.data,
    worker,
    heartbeatFresh,
    heartbeatAgeSec: hbAgeSec,
    killSwitches: killQ.data ?? [],
    isLoading: strategyQ.isLoading || heartbeatQ.isLoading,
  };
}

export function botStateLabel(s: BotState): {
  label: string;
  tone: "success" | "info" | "warning" | "danger" | "muted";
} {
  switch (s) {
    case "observing":
      return { label: "Observing", tone: "info" };
    case "paper":
      return { label: "Paper Trading", tone: "success" };
    case "halted":
      return { label: "Halted", tone: "danger" };
    case "live":
      return { label: "Live", tone: "warning" };
    case "offline":
      return { label: "Offline", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}
