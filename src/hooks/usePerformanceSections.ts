/**
 * usePerformanceSections — fetches raw closed trades + open counts for the
 * active book (paper or live) and folds them into `PerformanceSection[]`
 * via the pure `buildPerformanceSections()` helper. No fabrication:
 * an empty result set flows through as legitimate zero-state.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { loadPaperPositionPerformance } from "@/lib/trade/paperPositionPerformance";
import {
  buildPerformanceSections,
  type TradeRow,
  type OpenCounts,
} from "@/lib/trade/performanceSections";
import type { PerformanceSection } from "@/components/trade/PerformanceCard";

const EMPTY_OPEN: OpenCounts = {
  bySymbol: new Map(),
  byStrategy: new Map(),
  total: 0,
};

export function usePerformanceSections(book: "paper" | "live"): {
  sections: PerformanceSection[];
  isLoading: boolean;
} {
  const { user } = useAuth();
  const bookLabel = book === "paper" ? "Paper book" : "Live book";

  const paperQ = useQuery({
    queryKey: ["perf-sections-paper", user?.id],
    enabled: !!user && book === "paper",
    refetchInterval: 15_000,
    queryFn: async () => {
      const [closedPositions, positionsRes] = await Promise.all([
        loadPaperPositionPerformance(supabase, user!.id, 200),
        supabase
          .from("paper_positions")
          .select("id,strategy,symbol,status")
          .eq("user_id", user!.id)
          .eq("status", "open")
          .limit(2000),
      ]);
      if (positionsRes.error) throw positionsRes.error;
      const open: OpenCounts = {
        bySymbol: new Map(),
        byStrategy: new Map(),
        total: 0,
      };
      for (const p of positionsRes.data ?? []) {
        if (p.status === "open") {
          open.total += 1;
          open.bySymbol.set(p.symbol, (open.bySymbol.get(p.symbol) ?? 0) + 1);
          open.byStrategy.set(p.strategy, (open.byStrategy.get(p.strategy) ?? 0) + 1);
        }
      }
      const trades: TradeRow[] = closedPositions.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        pnl: t.pnl,
        strategy: t.strategy,
        closed_at: t.closedAt,
      }));
      return { trades, open };
    },
  });

  const liveQ = useQuery({
    queryKey: ["perf-sections-live", user?.id],
    enabled: !!user && book === "live",
    refetchInterval: 15_000,
    queryFn: async () => {
      const [tradesRes, positionsRes] = await Promise.all([
        supabase
          .from("trades")
          .select("id,pair,realized_pnl,closed_at,strategy_id")
          .eq("user_id", user!.id)
          .order("closed_at", { ascending: false })
          .limit(1000),
        supabase
          .from("positions")
          .select("id,pair,status")
          .eq("user_id", user!.id)
          .eq("status", "open")
          .limit(500),
      ]);
      if (tradesRes.error) throw tradesRes.error;
      if (positionsRes.error) throw positionsRes.error;
      const open: OpenCounts = {
        bySymbol: new Map(),
        byStrategy: new Map(),
        total: 0,
      };
      for (const p of positionsRes.data ?? []) {
        open.total += 1;
        open.bySymbol.set(p.pair, (open.bySymbol.get(p.pair) ?? 0) + 1);
      }
      const trades: TradeRow[] = (tradesRes.data ?? []).map((t) => ({
        id: t.id,
        symbol: t.pair,
        pnl: Number(t.realized_pnl ?? 0),
        strategy: null, // live strategy_id is a uuid; not surfaced yet
        closed_at: t.closed_at ?? null,
      }));
      return { trades, open };
    },
  });

  const active = book === "paper" ? paperQ : liveQ;

  const sections = useMemo<PerformanceSection[]>(() => {
    const trades = active.data?.trades ?? [];
    const open = active.data?.open ?? EMPTY_OPEN;
    return buildPerformanceSections({ trades, open, bookLabel });
  }, [active.data, bookLabel]);

  return { sections, isLoading: active.isLoading };
}
