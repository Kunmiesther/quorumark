// SIGNAL_EVALUATION events emitted by the observational worker.
// See supabase/functions/worker-ingest/index.ts — this is the only surface
// that reads them for the UI. Read-only; scoped to the signed-in user.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type SignalSide = "long" | "short";
export type SignalDirectionEval = {
  status?: string;
  reason_code?: string | null;
  entry?: number | null;
  entry_low?: number | null;
  entry_high?: number | null;
  stop_loss?: number | null;
  take_profit?: number[] | number | null;
  invalidation?: number | null;
  swing_count?: number | null;
  break_count?: number | null;
  retest_count?: number | null;
  entry_count?: number | null;
  short_summary?: string | null;
  long_summary?: string | null;
  [k: string]: unknown;
};

export type SignalEvent = {
  id: number;
  created_at: string;
  level: string;
  event: string;
  detail: {
    status?: string;
    reason_code?: string | null;
    symbol?: string;
    interval_min?: number;
    newest_completed_candle_ts_ms?: number;
    age_sec?: number;
    candle_count?: number;
    observation_id?: string;
    execution_performed?: boolean;
    short_summary?: string;
    long_summary?: string;
    long?: SignalDirectionEval;
    short?: SignalDirectionEval;
    [k: string]: unknown;
  };
};

export function useSignalEvents(limit = 50) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["signal-events", user?.id, limit],
    enabled: !!user,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<SignalEvent[]> => {
      const { data, error } = await supabase
        .from("bot_events")
        .select("id, created_at, level, event, detail")
        .eq("user_id", user!.id)
        .eq("event", "SIGNAL_EVALUATION")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as SignalEvent[];
    },
  });
}

export function useLatestSignal() {
  const { data, ...rest } = useSignalEvents(1);
  return { data: data?.[0], ...rest };
}
