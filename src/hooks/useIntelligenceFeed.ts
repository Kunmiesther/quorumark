// Single polled subscription to the committee intelligence ledger.
//
// Read-only. 20s polling keeps the desk within one 5m candle of the ledger
// without a realtime channel; `staleTime: 0` guarantees no cached empty state
// survives a refetch.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getIntelligenceFeed, type IntelligenceFeed } from "@/lib/ai/intelligence.functions";

export const EVALUATION_CADENCE_MS = 5 * 60_000;

export function useIntelligenceFeed(symbol?: string | null) {
  const fn = useServerFn(getIntelligenceFeed);
  const q = useQuery<IntelligenceFeed>({
    queryKey: ["intelligence-feed", symbol ?? null],
    queryFn: () => fn({ data: { symbol: symbol ?? null } }),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });

  return {
    feed: q.data ?? null,
    latest: q.data?.latest ?? null,
    recent: q.data?.recent ?? [],
    metrics: q.data?.metrics ?? null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error instanceof Error ? q.error.message : null,
  };
}

/** ms until the next 5m candle close after the given evaluation. */
export function nextEvaluationInMs(candleCloseAt: string | null, nowMs: number): number | null {
  if (!candleCloseAt) return null;
  const t = Date.parse(candleCloseAt);
  if (!Number.isFinite(t)) return null;
  const next = t + EVALUATION_CADENCE_MS;
  return Math.max(0, next - nowMs);
}
