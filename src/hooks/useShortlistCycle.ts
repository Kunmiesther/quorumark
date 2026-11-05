/**
 * useShortlistCycle — ONE shared subscription to the persisted committee
 * cycle for the active book. Both the desk status strip and the Scout queue
 * read through this hook so they can never disagree (same query key, same
 * cadence, single network read).
 *
 * Read-only. No engine, execution, or strategy behaviour lives here.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getShortlistCycle, type ShortlistCycleDto } from "@/lib/ai/shortlist.functions";
import { useAuth } from "@/hooks/useAuth";

export function useShortlistCycle(book: "paper" | "live" = "paper") {
  const fetchCycle = useServerFn(getShortlistCycle);
  const { user } = useAuth();
  return useQuery<ShortlistCycleDto>({
    queryKey: ["committee-shortlist", book, user?.id],
    enabled: Boolean(user),
    queryFn: () => fetchCycle({ data: { book } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
