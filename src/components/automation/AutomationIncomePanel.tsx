import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleDollarSign, ReceiptText } from "lucide-react";
import { getLifeMapSnapshot } from "@/lib/bills/bills.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

type PaperIncomeRow = { pnl_net: number; fees: number; closed_at: string };
type LiveIncomeRow = { realized_pnl: number; fees_usd: number; closed_at: string };

export function AutomationIncomePanel({ book }: { book: "live" | "paper" }) {
  const { user } = useAuth();
  const readLifeMap = useServerFn(getLifeMapSnapshot);
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const incomeQ = useQuery({
    queryKey: ["automation-income", book, user?.id, start.toISOString()],
    enabled: Boolean(user),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (book === "live") {
        const [result, lifeMap] = await Promise.all([
          supabase
            .from("trades")
            .select("realized_pnl,fees_usd,closed_at")
            .eq("user_id", user!.id)
            .eq("book", "live")
            .eq("evidence_verified", true)
            .gte("closed_at", start.toISOString()),
          readLifeMap(),
        ]);
        if (result.error) throw result.error;
        const rows = (result.data ?? []) as LiveIncomeRow[];
        return {
          net: rows.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0),
          fees: rows.reduce((sum, row) => sum + Number(row.fees_usd || 0), 0),
          closes: rows.length,
          covered: lifeMap.total_covered_usd,
          target: lifeMap.total_amount_usd,
        };
      }
      const [result, lifeMap] = await Promise.all([
        supabase
          .from("paper_trades")
          .select("pnl_net,fees,closed_at")
          .eq("user_id", user!.id)
          .gte("closed_at", start.toISOString()),
        readLifeMap(),
      ]);
      if (result.error) throw result.error;
      const rows = (result.data ?? []) as PaperIncomeRow[];
      return {
        net: rows.reduce((sum, row) => sum + Number(row.pnl_net || 0), 0),
        fees: rows.reduce((sum, row) => sum + Number(row.fees || 0), 0),
        closes: rows.length,
        covered: lifeMap.total_paper_covered_usd,
        target: lifeMap.total_amount_usd,
      };
    },
  });

  const data = incomeQ.data;
  const covered = data?.covered ?? 0;
  const target = data?.target ?? 0;

  return (
    <section
      className="tb-neu-panel mt-5 rounded-[28px] p-4 lg:p-5"
      aria-labelledby="automation-income-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300/75">
            Verified outcomes
          </p>
          <h2 id="automation-income-heading" className="mt-1 font-display text-lg">
            {book === "live"
              ? "Live income & Life Map tracking"
              : "Simulation results & Life Map tracking"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-white/45">
            {book === "live"
              ? "Exchange-confirmed closed trades only. Open-position P&L is not income."
              : "Simulated closed trades only. These results are not withdrawable income."}
          </p>
        </div>
        <Link
          to="/life-map"
          className="inline-flex items-center gap-1 text-xs text-violet-200 hover:text-white"
        >
          Open Life Map <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </header>

      {incomeQ.isLoading ? (
        <p className="mt-4 text-xs text-white/40">Reconciling fills and allocations…</p>
      ) : incomeQ.isError ? (
        <p className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/[0.06] p-3 text-xs text-rose-200">
          Income evidence could not be read. No amount is being estimated.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Metric
              label={book === "live" ? "Realized this month" : "Simulated net this month"}
              value={money(data?.net ?? 0)}
              detail={book === "live" ? "Exchange-confirmed net" : "Simulation net"}
              icon={<CircleDollarSign className="h-4 w-4" />}
            />
            <Metric
              label={book === "live" ? "Venue closes" : "Simulated closes"}
              value={String(data?.closes ?? 0)}
              detail={book === "live" ? "Completed venue positions" : "Completed simulations"}
            />
            <Metric
              label="Fees recorded"
              value={money(data?.fees ?? 0)}
              detail="Included in the displayed net result"
            />
          </div>
          <div className="tb-neu-inset mt-3 rounded-2xl p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="inline-flex items-center gap-2 font-semibold text-white/75">
                <ReceiptText className="h-4 w-4 text-emerald-300" />{" "}
                {book === "live"
                  ? "Income allocated to bill targets"
                  : "Simulated bill-target coverage"}
              </span>
              <span className="font-mono text-white">
                {money(covered)} / {money(target)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/35">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400"
                style={{ width: `${target > 0 ? Math.min(100, (covered / target) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-2 text-[10px] leading-4 text-white/35">
              {book === "live"
                ? "Tracked allocations are ledger entries, not a transfer, reservation, or bill payment. A bill is shown as paid only after a separate payment record and proof exist."
                : "Simulation coverage is planning evidence, not funds or a bill payment."}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon?: ReactNode;
}) {
  return (
    <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
      <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35">
        {icon}
        {label}
      </p>
      <p className="mt-2 truncate font-mono text-lg text-white">{value}</p>
      <p className="mt-1 text-[10px] leading-4 text-white/35">{detail}</p>
    </div>
  );
}
