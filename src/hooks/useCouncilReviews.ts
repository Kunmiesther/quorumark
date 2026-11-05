import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";
import { supabase } from "@/integrations/supabase/client";

export interface CouncilReviewStatus {
  position_id: string;
  status: string;
  rationale: string | null;
  degraded: boolean;
  completed_at: string | null;
  created_at: string;
  council_opinions: unknown;
}

/** Position reviews are a separate ledger from entry candidate scans. */
export function useCouncilReviews(book: "paper" | "live") {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["council-review-status", user?.id, book],
    enabled: Boolean(user) && book === "live",
    refetchInterval: 20_000,
    queryFn: async (): Promise<CouncilReviewStatus[]> => {
      const { data, error } = await supabase
        .from("live_tp_council_reviews")
        .select("position_id,status,rationale,degraded,completed_at,created_at,council_opinions")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      const seen = new Set<string>();
      return ((data ?? []) as CouncilReviewStatus[]).filter((row) => {
        if (seen.has(row.position_id)) return false;
        seen.add(row.position_id);
        return true;
      });
    },
  });
}
