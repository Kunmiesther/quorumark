// Generic bot_events feed for the Activity view. Read-only, per-user.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type BotEvent = {
  id: number;
  created_at: string;
  level: string;
  event: string;
  detail: Record<string, unknown> | null;
};

export function useBotEvents(limit = 100) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["bot-events", user?.id, limit],
    enabled: !!user,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<BotEvent[]> => {
      const { data, error } = await supabase
        .from("bot_events")
        .select("id, created_at, level, event, detail")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as BotEvent[];
    },
  });
}
