import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  MAX_CONNECTIONS,
  RISK_CAPITAL_MAX_PER_CONNECTION,
  aggregateExposure,
  leveragedNotional,
  type ConnectionExposure,
} from "@/lib/risk-capital";
import { STRATEGY_REQUIREMENTS } from "@/lib/strategy-config";

/**
 * Capital Command bay — reads my_risk_capital_summary() and active strategy
 * leverage from real backend rows. Displays per-connection allocation vs the
 * $500 cap and derives aggregate notional exposure. No invented capital.
 */
export function CapitalCommandBay() {
  const { user } = useAuth();

  const { data: summary } = useQuery({
    queryKey: ["risk-capital-summary", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_risk_capital_summary");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: connections } = useQuery({
    queryKey: ["capital-command-connections", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: active } = useQuery({
    queryKey: ["capital-command-strategy", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("strategies(slug)")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true })
          .limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { rows, totalMargin, totalNotional, verifiedCount, leverage } = useMemo(() => {
    const slug = (active?.strategies as { slug?: string } | null)?.slug;
    const leverage = (slug && STRATEGY_REQUIREMENTS[slug]?.leverage) || 1;
    const list: ConnectionExposure[] =
      (summary ?? []).map((s) => {
        const margin = Number(s.allocated) || 0;
        return {
          connection_id: s.connection_id,
          marginAllocated: margin,
          leverage,
          notionalExposure: leveragedNotional(margin, leverage),
        };
      });
    const agg = aggregateExposure(list);
    const v = (connections ?? []).filter(
      (c) => c.status === "verified" || c.status === "connected",
    ).length;
    return { rows: list, ...agg, verifiedCount: v, leverage };
  }, [summary, connections, active]);

  const connCount = connections?.length ?? 0;

  return (
    <section className="mx-5 mt-4">
      <div className="command-surface p-5">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-[color:var(--text-secondary)]">
            Capital Command
          </h2>
          <span className="num text-[11px] text-[color:var(--text-secondary)]">
            {connCount}/{MAX_CONNECTIONS} bays
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Risk Capital"
            value={`$${totalMargin.toLocaleString()}`}
            sub={`of $${(RISK_CAPITAL_MAX_PER_CONNECTION * MAX_CONNECTIONS).toLocaleString()} max`}
            accent="var(--intel-cyan)"
          />
          <Stat
            label="Notional Exposure"
            value={`$${totalNotional.toLocaleString()}`}
            sub={leverage > 1 ? `${leverage}× leverage` : "no leverage set"}
            accent="var(--brand-violet)"
          />
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-display text-[9.5px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
              Per-Connection Allocation
            </span>
            <span className="num text-[10px] text-[color:var(--text-secondary)]">
              {verifiedCount} verified
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/8 bg-white/[0.02] px-3 py-4 text-center">
              <p className="text-[11px] text-[color:var(--text-secondary)]">
                No allocations yet. Connect an exchange to arm a bay.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((r, i) => {
                const pct = Math.min(
                  100,
                  Math.round((r.marginAllocated / RISK_CAPITAL_MAX_PER_CONNECTION) * 100),
                );
                return (
                  <li key={r.connection_id} className="space-y-1">
                    <div className="flex items-baseline justify-between">
                      <span className="font-display text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-secondary)]">
                        Bay {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="num text-[11px] font-semibold text-[color:var(--text-primary)]">
                        ${r.marginAllocated.toLocaleString()}
                        <span className="text-[color:var(--text-secondary)]">
                          {" "}
                          / ${RISK_CAPITAL_MAX_PER_CONNECTION}
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          background: "var(--intel-cyan)",
                          boxShadow: "0 0 8px color-mix(in oklab, var(--intel-cyan) 60%, transparent)",
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div
      className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accent} 12%, transparent)` }}
    >
      <p className="font-display text-[9.5px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
        {label}
      </p>
      <p
        className="num mt-1.5 font-display text-[20px] font-semibold leading-none"
        style={{ color: accent }}
      >
        {value}
      </p>
      <p className="num mt-1 text-[10px] text-[color:var(--text-secondary)]">{sub}</p>
    </div>
  );
}
