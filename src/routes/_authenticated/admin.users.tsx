import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAllUserPaperStats, type AdminUserPaperStats } from "@/lib/admin/paper-stats.functions";
import { AlertCircle, Users, TrendingUp, TrendingDown, Wallet, Activity } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/users")({
  component: AdminUsersRoute,
  head: () => ({
    meta: [
      { title: "Admin — User Paper Stats" },
      { name: "description", content: "Admin-only cross-user paper trading statistics." },
      { property: "og:title", content: "Admin — User Paper Stats" },
      { property: "og:description", content: "Cross-user paper trading stats." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function AdminUsersRoute() {
  const fetchStats = useServerFn(listAllUserPaperStats);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "user-paper-stats"],
    queryFn: () => fetchStats(),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading user stats…</div>;
  }

  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const forbidden = /Forbidden|Unauthorized/i.test(msg);
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-xl border border-red-500/40 bg-red-500/5 p-6">
        <div className="mb-2 flex items-center gap-2 text-red-400">
          <AlertCircle className="h-4 w-4" />
          <h1 className="text-base font-semibold">
            {forbidden ? "Admin access required" : "Failed to load stats"}
          </h1>
        </div>
        <p className="text-xs text-muted-foreground">{msg}</p>
      </div>
    );
  }

  const rows = data ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      wallets: acc.wallets + r.wallets,
      balance: acc.balance + r.wallet_balance_total,
      open: acc.open + r.open_positions,
      trades: acc.trades + r.closed_trades,
      pnl: acc.pnl + r.pnl_net_total,
    }),
    { wallets: 0, balance: 0, open: 0, trades: 0, pnl: 0 },
  );

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-[#22D3EE]">
          <Users className="h-4 w-4" />
          <span className="text-[11px] uppercase tracking-widest">Admin · Paper</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">User paper trading stats</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Aggregate paper-engine metrics across all user accounts. Read-only.
        </p>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi icon={<Users className="h-3.5 w-3.5" />} label="Users" value={rows.length.toString()} />
        <Kpi icon={<Wallet className="h-3.5 w-3.5" />} label="Wallets" value={totals.wallets.toString()} />
        <Kpi icon={<Wallet className="h-3.5 w-3.5" />} label="Balance" value={fmtUsd(totals.balance)} />
        <Kpi icon={<Activity className="h-3.5 w-3.5" />} label="Open pos" value={totals.open.toString()} />
        <Kpi
          icon={totals.pnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          label="Net PnL"
          value={fmtUsd(totals.pnl)}
          tone={totals.pnl >= 0 ? "pos" : "neg"}
        />
      </section>

      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5">User</th>
              <th className="px-3 py-2.5">Mode</th>
              <th className="px-3 py-2.5">Bot</th>
              <th className="px-3 py-2.5 text-right">Wallets</th>
              <th className="px-3 py-2.5 text-right">Balance</th>
              <th className="px-3 py-2.5 text-right">Open</th>
              <th className="px-3 py-2.5 text-right">Trades</th>
              <th className="px-3 py-2.5 text-right">Win %</th>
              <th className="px-3 py-2.5 text-right">Net PnL</th>
              <th className="px-3 py-2.5">Last trade</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <UserRow key={r.user_id} row={r} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRow({ row }: { row: AdminUserPaperStats }) {
  const pnlTone = row.pnl_net_total >= 0 ? "text-emerald-400" : "text-red-400";
  return (
    <tr className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.03]">
      <td className="px-4 py-2.5">
        <div className="font-medium">{row.display_name ?? "—"}</div>
        <div className="num text-[10px] text-muted-foreground">{row.user_id.slice(0, 8)}…{row.user_id.slice(-4)}</div>
      </td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.account_mode ?? "—"}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.bot_status ?? "—"}</td>
      <td className="num px-3 py-2.5 text-right">{row.wallets}</td>
      <td className="num px-3 py-2.5 text-right">{fmtUsd(row.wallet_balance_total)}</td>
      <td className="num px-3 py-2.5 text-right">{row.open_positions}</td>
      <td className="num px-3 py-2.5 text-right">{row.closed_trades}</td>
      <td className="num px-3 py-2.5 text-right">{row.closed_trades > 0 ? `${row.win_rate.toFixed(1)}%` : "—"}</td>
      <td className={`num px-3 py-2.5 text-right font-semibold ${pnlTone}`}>{fmtUsd(row.pnl_net_total)}</td>
      <td className="num px-3 py-2.5 text-[10px] text-muted-foreground">
        {row.last_trade_at ? new Date(row.last_trade_at).toLocaleString() : "—"}
      </td>
    </tr>
  );
}

function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "pos" | "neg" }) {
  const t = tone === "pos" ? "text-emerald-400" : tone === "neg" ? "text-red-400" : "";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className={`num mt-1.5 text-lg font-semibold ${t}`}>{value}</div>
    </div>
  );
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${n < 0 ? "−" : ""}$${s}`;
}
