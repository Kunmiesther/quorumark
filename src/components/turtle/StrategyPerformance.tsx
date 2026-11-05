import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Trophy, TrendingDown, Activity, Target } from "lucide-react";

type TradeRow = { realized_pnl: number | null; closed_at: string | null };

function computeStats(trades: TradeRow[]) {
  const closed = trades.filter((t) => typeof t.realized_pnl === "number" && t.closed_at);
  if (closed.length === 0) return null;
  let wins = 0,
    grossWin = 0,
    grossLoss = 0;
  const returns: number[] = [];
  for (const t of closed) {
    const p = Number(t.realized_pnl);
    returns.push(p);
    if (p >= 0) {
      wins++;
      grossWin += p;
    } else {
      grossLoss += Math.abs(p);
    }
  }
  const winRate = (wins / closed.length) * 100;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  // Max drawdown from running equity
  let peak = 0,
    eq = 0,
    maxDD = 0;
  for (const r of returns) {
    eq += r;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }
  // Sharpe-like: mean / stdev
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(closed.length) : 0;
  return { winRate, profitFactor, maxDD, sharpe, total: closed.length };
}

const DEMO_STATS = {
  winRate: 62.4,
  profitFactor: 1.84,
  maxDD: 38.2,
  sharpe: 1.42,
  total: 47,
};

export function StrategyPerformance() {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ["strategy-perf", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("realized_pnl, closed_at")
        .eq("user_id", user!.id)
        .limit(500);
      if (error) throw error;
      return (data ?? []) as TradeRow[];
    },
  });

  const stats = useMemo(() => {
    const real = data ? computeStats(data) : null;
    return real ?? DEMO_STATS;
  }, [data]);

  const isDemo = stats === DEMO_STATS;

  return (
    <section className="mx-5 mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-heading-2">Strategy performance</h2>
        <span className="text-[11px] text-muted-foreground">
          {isDemo ? "Sample" : <><span className="num">{stats.total}</span> trades</>}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          icon={<Trophy className="h-3.5 w-3.5" />}
          label="Win rate"
          value={`${stats.winRate.toFixed(1)}%`}
          tone={stats.winRate >= 50 ? "positive" : "negative"}
          sub={stats.winRate >= 50 ? "Above breakeven" : "Below breakeven"}
        />
        <Stat
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Profit factor"
          value={
            stats.profitFactor === Infinity
              ? "∞"
              : stats.profitFactor.toFixed(2)
          }
          tone={stats.profitFactor >= 1 ? "positive" : "negative"}
          sub={stats.profitFactor >= 1.5 ? "Healthy" : stats.profitFactor >= 1 ? "Marginal" : "Losing"}
        />
        <Stat
          icon={<TrendingDown className="h-3.5 w-3.5" />}
          label="Max drawdown"
          value={`−$${stats.maxDD.toFixed(2)}`}
          tone="negative"
          sub="Peak-to-trough"
        />
        <Stat
          icon={<Target className="h-3.5 w-3.5" />}
          label="Sharpe"
          value={stats.sharpe.toFixed(2)}
          tone={stats.sharpe >= 1 ? "positive" : "negative"}
          sub={stats.sharpe >= 1 ? "Risk-adjusted ✓" : "High variance"}
        />
      </div>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "positive" | "negative";
  sub: string;
}) {
  return (
    <div className="bento p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-label-sm">{label}</span>
      </div>
      <p
        className={`num mt-2 text-[22px] font-semibold leading-none tracking-tight ${
          tone === "positive" ? "text-positive" : "text-negative"
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[10.5px] text-muted-foreground">{sub}</p>
    </div>
  );
}
