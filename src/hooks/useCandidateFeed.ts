// Discovery feed of recent candidates. Read-only; one query, owner-scoped.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listCandidates } from "@/lib/candidate/lifecycle.functions";
import type { CandidateLifecycleDto } from "@/lib/candidate/lifecycle";

export function useCandidateFeed(limit = 12) {
  const fetchFeed = useServerFn(listCandidates);
  return useQuery<CandidateLifecycleDto[]>({
    queryKey: ["candidate-feed", limit],
    queryFn: () => fetchFeed({ data: { limit } }),
    refetchInterval: 60_000,
    retry: false,
  });
}
