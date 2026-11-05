/**
 * FORMATION BADGE — surfaces the P2 adaptive-formation state on strategy /
 * paper UI. Reads THE LATEST scout_signals row per symbol for the current
 * user and computes what formation the engine WOULD build if a new entry
 * fired right now for the given leverage.
 *
 * This is a display-only component. It never issues orders and never gates
 * the engine — that gating lives in the engine's `sizeLadder` call site.
 * It uses the exact same `planFormation` function the engine uses, so the
 * badge and the engine can never drift.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { planFormation, type FormationMode } from "@/lib/paper/adaptiveFormation";
import type { MarketRegime } from "@/lib/scout/regime";
import { cn } from "@/lib/utils";

interface FormationBadgeProps {
  symbol: string;
  leverage: number;
  className?: string;
}

const MODE_TONE: Record<FormationMode, string> = {
  precision: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  staged: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  adaptive: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  wait: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

const REGIME_LABEL: Record<MarketRegime, string> = {
  strong_uptrend: "STRONG ▲",
  strong_downtrend: "STRONG ▼",
  developing_trend: "DEVELOPING",
  ranging: "RANGING",
  volatile: "VOLATILE",
  reversal_forming: "REVERSAL",
  opposing_to_open_position: "OPPOSING",
  unknown: "UNKNOWN",
};

export function FormationBadge({ symbol, leverage, className }: FormationBadgeProps) {
  const { data } = useQuery({
    queryKey: ["scout_regime", symbol],
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("scout_signals")
        .select("market_regime,created_at")
        .eq("symbol", symbol)
        .not("market_regime", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      return (rows?.[0]?.market_regime as MarketRegime | null) ?? "unknown";
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const regime: MarketRegime = data ?? "unknown";
  const plan = planFormation({ regime, leverage, symbol });
  const rungLabel = plan.mode === "wait" ? "0 rungs · no entry" : `${plan.rungs}× rungs`;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider",
        MODE_TONE[plan.mode],
        className,
      )}
      title={`Regime: ${REGIME_LABEL[regime]} · Formation: ${plan.mode} · ${rungLabel}`}
    >
      <span className="opacity-70">{REGIME_LABEL[regime]}</span>
      <span className="opacity-40">·</span>
      <span className="font-semibold">{plan.mode}</span>
      <span className="opacity-40">·</span>
      <span>{rungLabel}</span>
    </div>
  );
}
