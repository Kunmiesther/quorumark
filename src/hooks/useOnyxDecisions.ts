/**
 * useOnyxDecisions — runs the Onyx brain server function against the
 * current Scout scan. Advisory only; the server function never executes.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { runOnyxBrain, type OnyxBrainResult } from "@/lib/onyx/onyx.functions";
import { useScout } from "@/hooks/useScout";

export function useOnyxDecisions() {
  const scout = useScout();
  const brainFn = useServerFn(runOnyxBrain);

  const query = useQuery<OnyxBrainResult>({
    queryKey: ["onyx", "decisions", scout.dataUpdatedAt],
    enabled: !!scout.data && scout.data.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => brainFn({ data: { reports: scout.data ?? [] } }),
  });

  const refresh = useMutation({
    mutationFn: () => brainFn({ data: { reports: scout.data ?? [] } }),
    onSuccess: (result) => {
      query.refetch();
      return result;
    },
  });

  return {
    scoutLoading: scout.isLoading,
    scoutError: scout.error instanceof Error ? scout.error.message : null,
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching || refresh.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: refresh.mutate,
  };
}
