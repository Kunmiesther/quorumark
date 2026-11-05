/**
 * useStrategyTradingStats — read-only aggregation of paper-engine trade
 * results for a single engine `strategy` value (e.g. "hunter", "sniper",
 * "accumulator", "dca"). Display-only: no side effects, no writes.
 *
 * Pass `engineStrategy = null` for cards that are NOT wired to the paper
 * engine yet — the hook stays disabled and callers render an honest "—".
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export interface StrategyTradingStats {
  trades: number;
  wins: number;
  winRate: number; // 0..1
  pnl: number;
  open: number;
}

export function useStrategyTradingStats(engineStrategy: string | null) {
  const { user } = useAuth();
  return useQuery<StrategyTradingStats>({
    queryKey: ["paper-strategy-stats", user?.id, engineStrategy],
    enabled: !!user?.id && !!engineStrategy,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const uid = user!.id;
      const strat = engineStrategy!;
      const { data: positions, error: pErr } = await supabase
        .from("paper_positions")
        .select("id,status")
        .eq("user_id", uid)
        .eq("strategy", strat);
      if (pErr) throw pErr;
      const ids = (positions ?? []).map((p) => p.id);
      const open = (positions ?? []).filter((p) => p.status === "open").length;
      if (ids.length === 0) {
        return { trades: 0, wins: 0, winRate: 0, pnl: 0, open };
      }
      const { data: trades, error: tErr } = await supabase
        .from("paper_trades")
        .select("pnl_net,exit_reason")
        .in("position_id", ids);
      if (tErr) throw tErr;
      const total = trades?.length ?? 0;
      const wins = (trades ?? []).filter((t) => t.exit_reason === "tp_touch").length;
      const pnl = (trades ?? []).reduce((a, t) => a + Number(t.pnl_net ?? 0), 0);
      return { trades: total, wins, winRate: total ? wins / total : 0, pnl, open };
    },
  });
}
