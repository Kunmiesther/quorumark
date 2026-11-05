import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { ArrowUpRight, ArrowDownRight, Activity, CircleDot } from "lucide-react";
import { useEffect, useState } from "react";

type ActivityRow = {
  id: string;
  kind: "entry" | "exit" | "signal";
  pair: string;
  side: "long" | "short";
  price: number;
  pnl?: number | null;
  note?: string | null;
  at: number;
};

function relTime(ts: number, now: number): string {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function TradeActivityFeed() {
  const { user } = useAuth();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const { data: trades } = useQuery({
    queryKey: ["activity-trades", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("id, pair, side, entry_price, exit_price, realized_pnl, opened_at, closed_at")
        .eq("user_id", user!.id)
        .order("opened_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows: ActivityRow[] = (trades ?? []).flatMap((t): ActivityRow[] => {
    const out: ActivityRow[] = [];
    const side = (t.side === "short" ? "short" : "long") as "long" | "short";
    if (t.closed_at && t.exit_price != null) {
      out.push({
        id: `${t.id}-x`,
        kind: "exit",
        pair: t.pair,
        side,
        price: Number(t.exit_price),
        pnl: t.realized_pnl != null ? Number(t.realized_pnl) : null,
        at: new Date(t.closed_at).getTime(),
      });
    }
    if (t.opened_at && t.entry_price != null) {
      out.push({
        id: `${t.id}-e`,
        kind: "entry",
        pair: t.pair,
        side,
        price: Number(t.entry_price),
        at: new Date(t.opened_at).getTime(),
      });
    }
    return out;
  }).sort((a, b) => b.at - a.at).slice(0, 8);

  const hasRows = rows.length > 0;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[18px] font-semibold text-white">Activity</h2>
          {hasRows && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--positive)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--positive)]" />
            </span>
          )}
        </div>
        {hasRows && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
            Live
          </span>
        )}
      </div>

      {hasRows ? (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const isShort = r.side === "short";
            const dirIcon = isShort
              ? <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2.4} />
              : <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />;
            const tint =
              r.kind === "signal"
                ? "bg-[#FFB020]/15 text-[#FFB020]"
                : isShort
                  ? "bg-[color:var(--negative)]/15 text-[color:var(--negative)]"
                  : "bg-[color:var(--positive)]/15 text-[color:var(--positive)]";
            const verb =
              r.kind === "signal" ? "Signal" : r.kind === "entry" ? "Opened" : "Closed";
            const pnlNode =
              r.kind === "exit" && r.pnl != null ? (
                <span className={`tabular-nums text-[11.5px] font-semibold ${r.pnl >= 0 ? "text-[color:var(--positive)]" : "text-[color:var(--negative)]"}`}>
                  {r.pnl >= 0 ? "+" : "−"}${Math.abs(r.pnl).toFixed(2)}
                </span>
              ) : null;

            return (
              <li key={r.id} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tint}`}>
                  {r.kind === "signal" ? <CircleDot className="h-3.5 w-3.5" /> : dirIcon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold text-white">{verb} {r.pair}</span>
                    <span className={`rounded-md px-1 py-0.5 text-[9px] font-bold tracking-wider ${
                      isShort
                        ? "bg-[color:var(--negative)]/15 text-[color:var(--negative)]"
                        : "bg-[color:var(--positive)]/15 text-[color:var(--positive)]"
                    }`}>
                      {r.side.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10.5px] text-white/50">
                    @ <span className="tabular-nums">${r.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                    {r.note ? <> · {r.note}</> : null}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {pnlNode}
                  <span className="tabular-nums text-[10px] text-white/50">{relTime(r.at, now)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.04] text-white/50">
            <Activity className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-white">No activity yet</p>
          <p className="max-w-[260px] text-[11px] text-white/50">
            When the bot opens a position, closes a trade, or detects a signal, it'll show up here.
          </p>
        </div>
      )}
    </section>
  );
}
