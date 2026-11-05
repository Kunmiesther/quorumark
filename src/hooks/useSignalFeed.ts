// Live SIGNAL_EVALUATION feed for Onyx's decision panel.
//
// Reads the same bot_events rows the worker writes (event='SIGNAL_EVALUATION'),
// scoped to the signed-in user via RLS. This is OBSERVATION ONLY —
// execution_performed is always false on these rows. Nothing here places
// or represents an order.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type RetestState =
  | "confirmed"
  | "pending"
  | "expired_window"
  | "expired_breach";

export type EntrySummary = {
  state?: string;
  direction?: "long" | "short" | string;
  break_index?: number;
  break_ts_ms?: number;
  retest_index?: number;
  retest_ts_ms?: number;
  zone_level?: number;
  zone_tolerance?: number;
  zone_assumption?: string;
};

export type DirectionEval = {
  candles?: number;
  breaks?: number;
  retests?: number;
  entries?: number;
  swings_raw?: number;
  swings_grouped?: number;
  retest_states?: Partial<Record<RetestState, number>>;
  entry_summaries?: EntrySummary[];
  entry_summaries_truncated?: boolean;
};

export type SignalEvaluationDetail = {
  status?: "evaluated" | "skipped" | "error" | string;
  symbol?: string;
  normalized_symbol?: string;
  interval_min?: number;
  interval_source?: string;
  age_sec?: number;
  tick_size?: number;
  candle_count?: number;
  newest_completed_candle_ts_ms?: number;
  evaluated_at?: string;
  execution_performed?: boolean;
  observation_id?: string;
  reason_code?: string;
  error_text?: string;
  directions?: {
    long?: DirectionEval;
    short?: DirectionEval;
  };
};

export type SignalEvaluation = {
  id: number;
  created_at: string;
  detail: SignalEvaluationDetail;
};

const STALE_MS = 6 * 60 * 1000; // 6 minutes

function parseDetail(raw: unknown): SignalEvaluationDetail {
  if (!raw || typeof raw !== "object") return {};
  // Defensive: cast, do not trust shape.
  return raw as SignalEvaluationDetail;
}

export function useSignalFeed(historyLimit = 20) {
  const { user } = useAuth();

  const q = useQuery({
    queryKey: ["signal-feed", user?.id, historyLimit],
    enabled: !!user,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<SignalEvaluation[]> => {
      const { data, error } = await supabase
        .from("bot_events")
        .select("id, created_at, detail")
        .eq("user_id", user!.id)
        .eq("event", "SIGNAL_EVALUATION")
        .order("created_at", { ascending: false })
        .limit(historyLimit);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id as number,
        created_at: row.created_at as string,
        detail: parseDetail(row.detail),
      }));
    },
  });

  const history = q.data ?? [];
  const latest = history[0];

  let isStale = false;
  if (latest) {
    const evaluatedAt = latest.detail.evaluated_at
      ? Date.parse(latest.detail.evaluated_at)
      : Date.parse(latest.created_at);
    if (Number.isFinite(evaluatedAt)) {
      isStale = Date.now() - evaluatedAt > STALE_MS;
    }
  }

  return {
    latest,
    history,
    isLoading: q.isLoading,
    isFetched: q.isFetched,
    isStale,
    hasNoData: q.isFetched && history.length === 0,
    error: q.error as Error | null,
  };
}
