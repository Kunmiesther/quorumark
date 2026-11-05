/**
 * useTurtleStates — single source of truth for the 6 turtles + Onyx.
 *
 * Derives status from actual engine telemetry:
 *   • in-position → open row(s) in paper_positions for that strategy
 *   • locked-out  → guardian-BOS close on (symbol, direction) within
 *                   REENTRY_LOCKOUT_CANDLES × 5m (same rule as engine)
 *   • armed       → this strategy occupies the armed_leg slot for at least
 *                   one symbol in the latest PAPER_TICK_REASONS row
 *   • watching    → strategy is idle but not benched
 *   • benched     → no armed_leg matched anywhere in the last tick
 *
 * Advisory only — never triggers execution.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  buildLockoutSet,
  REENTRY_LOCKOUT_MS,
  type LockoutTradeRow,
} from "@/lib/paper/reentryLockout";

export type TurtleKey =
  | "vanguard"
  | "accumulator"
  | "sniper"
  | "hunter"
  | "arbiter"
  | "scout"
  | "onyx";

export type TurtleStatus =
  | "armed"
  | "watching"
  | "in-position"
  | "locked-out"
  | "benched";

export interface OpenSignal {
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number | null;
  tp: number | null;
  promoted: boolean;
  runnerBreakevenStop: number | null;
}

export interface TurtleState {
  key: TurtleKey;
  label: string;
  role: string;
  status: TurtleStatus;
  openPositions: number;
  openSignals: OpenSignal[];
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  /** Symbols where this leg is currently under re-entry lockout. */
  lockedSymbols: string[];
  /** Symbols where this leg is currently the armed_leg per last tick. */
  armedSymbols: string[];
}

const ROSTER: Array<{ key: TurtleKey; label: string; role: string; strategy: string | null }> = [
  { key: "vanguard",    label: "Vanguard",    role: "Break-and-retest frontline",     strategy: "vanguard" },
  { key: "accumulator", label: "Accumulator", role: "5-rung compounding ladder",     strategy: "accumulator" },
  { key: "sniper",      label: "Sniper",      role: "Zone-reversal precision",        strategy: "sniper" },
  { key: "hunter",      label: "Hunter",      role: "Fair-value-gap tracker",         strategy: "hunter" },
  { key: "arbiter",     label: "Arbiter",     role: "Market-neutral funding arb",     strategy: "arbiter" },
  // Scout and Onyx intentionally excluded — they own dedicated sections
  // (Scout scan panel, Onyx decision commander). The hub only lists the
  // six execution turtles to avoid duplicating those surfaces.
];

type PerSymbolReasons = {
  symbol: string;
  regime?: string | null;
  armed_leg?: string | null;
};

export function useTurtleStates() {
  const { user } = useAuth();
  return useQuery<TurtleState[]>({
    queryKey: ["turtle-states", user?.id],
    enabled: !!user?.id,
    refetchInterval: 20_000,
    staleTime: 10_000,
    queryFn: async () => {
      const uid = user!.id;

      // ── positions + trades ─────────────────────────────────────────────
      const { data: positions } = await supabase
        .from("paper_positions")
        .select(
          "id,strategy,status,symbol,direction,entry_price,stop_level,tp_level,promoted,runner_breakeven_stop",
        )
        .eq("user_id", uid);
      const posList = positions ?? [];
      const openList = posList.filter((p) => p.status === "open");
      const allIds = posList.map((p) => p.id);
      const { data: trades } = allIds.length
        ? await supabase
            .from("paper_trades")
            .select("position_id,pnl_net,exit_reason,symbol,direction,closed_at")
            .in("position_id", allIds)
        : { data: [] };
      const tradeList = trades ?? [];

      // ── latest tick reasons (armed_leg per symbol) ────────────────────
      const { data: tickRow } = await supabase
        .from("bot_events")
        .select("detail,created_at")
        .eq("user_id", uid)
        .eq("event", "PAPER_TICK_REASONS")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const perSymbol: PerSymbolReasons[] =
        (tickRow?.detail as { per_symbol?: PerSymbolReasons[] } | null)?.per_symbol ?? [];
      const armedByStrategy = new Map<string, Set<string>>();
      for (const s of perSymbol) {
        if (!s.armed_leg) continue;
        const set = armedByStrategy.get(s.armed_leg) ?? new Set<string>();
        set.add(s.symbol);
        armedByStrategy.set(s.armed_leg, set);
      }

      // ── lockout set (same rule as engine) ─────────────────────────────
      const nowMs = Date.now();
      const cutoffIso = new Date(nowMs - REENTRY_LOCKOUT_MS).toISOString();
      const guardianTrades: LockoutTradeRow[] = tradeList
        .filter(
          (t) =>
            typeof t.exit_reason === "string" &&
            (t.closed_at ? t.closed_at >= cutoffIso : false),
        )
        .map((t) => ({
          symbol: String(t.symbol),
          direction: String(t.direction),
          exit_reason: String(t.exit_reason),
          closed_at_ms: t.closed_at ? Date.parse(t.closed_at) : 0,
        }));
      const lockoutSet = buildLockoutSet(guardianTrades, nowMs);

      // Which (symbol, direction) pairs are open for each strategy — so a
      // strategy that IS in-position doesn't also read as "locked-out".
      const openBySymDir = new Map<string, Set<string>>(); // strategy → "sym:dir"
      const openByStrategy = new Map<string, number>();
      for (const p of openList) {
        openByStrategy.set(p.strategy, (openByStrategy.get(p.strategy) ?? 0) + 1);
        const set = openBySymDir.get(p.strategy) ?? new Set<string>();
        set.add(`${p.symbol}:${p.direction}`);
        openBySymDir.set(p.strategy, set);
      }

      // ── per-strategy open-signal detail ───────────────────────────────
      const openByStrategyRows = new Map<string, OpenSignal[]>();
      for (const p of openList) {
        const list = openByStrategyRows.get(p.strategy) ?? [];
        list.push({
          symbol: p.symbol,
          side: (p.direction === "short" ? "short" : "long") as "long" | "short",
          entry: Number(p.entry_price ?? 0),
          stop: p.stop_level != null ? Number(p.stop_level) : null,
          tp: p.tp_level != null ? Number(p.tp_level) : null,
          promoted: !!p.promoted,
          runnerBreakevenStop:
            p.runner_breakeven_stop != null ? Number(p.runner_breakeven_stop) : null,
        });
        openByStrategyRows.set(p.strategy, list);
      }

      const tradesByPos = new Map<string, string>();
      posList.forEach((p) => tradesByPos.set(p.id, p.strategy));

      // Aggregate: does the latest tick have ANY armed_leg? If not, we
      // consider all leg-strategies "watching" (engine wasn't running).
      const engineHasArmed = armedByStrategy.size > 0;

      return ROSTER.map((r) => {
        // Scout & Onyx — meta-agents; watching whenever there is telemetry.
        if (!r.strategy) {
          const status: TurtleStatus =
            openList.length > 0 ? "watching" : engineHasArmed ? "watching" : "watching";
          return {
            key: r.key,
            label: r.label,
            role: r.role,
            status,
            openPositions: 0,
            openSignals: [],
            trades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            realizedPnl: 0,
            lockedSymbols: [],
            armedSymbols: [],
          };
        }

        const legTrades = tradeList.filter(
          (t) => tradesByPos.get(t.position_id as string) === r.strategy,
        );
        const wins = legTrades.filter((t) => t.exit_reason === "tp_touch").length;
        const losses = legTrades.filter((t) => Number(t.pnl_net ?? 0) < 0).length;
        const total = legTrades.length;
        const pnl = legTrades.reduce((a, t) => a + Number(t.pnl_net ?? 0), 0);
        const openCount = openByStrategy.get(r.strategy) ?? 0;
        const armedSymbols = Array.from(armedByStrategy.get(r.strategy) ?? []);
        const openKeys = openBySymDir.get(r.strategy) ?? new Set<string>();
        // Lockouts that involve this leg = any locked (sym,dir) NOT already open here.
        const lockedSymbols = Array.from(lockoutSet)
          .filter((k) => !openKeys.has(k))
          .map((k) => k.split(":")[0]);

        let status: TurtleStatus;
        if (openCount > 0) status = "in-position";
        else if (lockedSymbols.length > 0) status = "locked-out";
        else if (armedSymbols.length > 0) status = "armed";
        else if (engineHasArmed) status = "benched";
        else status = "watching";

        return {
          key: r.key,
          label: r.label,
          role: r.role,
          status,
          openPositions: openCount,
          openSignals: openByStrategyRows.get(r.strategy) ?? [],
          trades: total,
          wins,
          losses,
          winRate: total ? wins / total : 0,
          realizedPnl: pnl,
          lockedSymbols,
          armedSymbols,
        };
      });
    },
  });
}
