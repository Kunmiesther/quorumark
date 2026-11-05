/**
 * LiveAdvisoryPanel — owner-scoped view of the 3-seat live advisory ledger.
 * Advisory only: this panel renders recorded opinions and can never place,
 * cancel, resize or close an order.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listLiveAdvisories } from "@/lib/live/liveAdvisory.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const ACTION_TONE: Record<string, string> = {
  exit: "border-red-500/40 text-red-300",
  bank_profit: "border-emerald-500/40 text-emerald-300",
  reduce: "border-amber-500/40 text-amber-300",
  hedge: "border-sky-500/40 text-sky-300",
  hold: "border-slate-500/40 text-slate-300",
  no_change: "border-slate-600/40 text-slate-400",
};

export function LiveAdvisoryPanel() {
  const fn = useServerFn(listLiveAdvisories);
  const { data, isLoading } = useQuery({
    queryKey: ["live-advisories"],
    queryFn: () => fn({}),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <Card className="p-4 bg-black/40 border-fuchsia-500/20">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-xs uppercase tracking-wider text-fuchsia-300/80">
          Live position advisory · 3 seats
        </div>
        <Badge variant="outline" className="border-fuchsia-500/40 text-fuchsia-300">
          ADVISORY ONLY
        </Badge>
      </div>

      {isLoading && <div className="text-xs text-slate-500 font-mono">loading…</div>}

      {!isLoading && (!data || data.length === 0) && (
        <div className="text-xs text-slate-500 font-mono">
          No live advisory recorded yet. The sweep runs every 5 minutes while an owner live
          position is open.
        </div>
      )}

      <div className="space-y-3">
        {(data ?? []).map((a) => (
          <div key={a.id} className="rounded-md border border-white/5 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-mono text-sm text-white">{a.symbol}</span>
              <span className="font-mono text-[11px] uppercase text-slate-400">{a.direction}</span>
              <Badge
                variant="outline"
                className={ACTION_TONE[a.consensus_action] ?? ACTION_TONE.no_change}
              >
                {a.consensus_action.replace("_", " ").toUpperCase()}
              </Badge>
              {a.consensus_confidence != null && (
                <span className="font-mono text-[11px] text-slate-400">
                  {(a.consensus_confidence * 100).toFixed(0)}%
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-slate-500">
                {a.seats_available}/{a.seats_total} seats ·{" "}
                {new Date(a.candle_close_at).toLocaleTimeString()}
              </span>
            </div>

            <p className="text-[12px] text-slate-300 mb-2">{a.narrative}</p>

            {a.risk_flags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {a.risk_flags.map((f) => (
                  <span
                    key={f}
                    className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-300/90"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}

            <div className="grid gap-1">
              {a.opinions.map((o, i) => (
                <div key={`${o.role}-${i}`} className="font-mono text-[11px] text-slate-400">
                  <span className="text-slate-500">{o.role}</span>{" "}
                  <span className="text-slate-600">({o.model})</span>{" "}
                  {o.available ? (
                    <>
                      <span className="text-slate-200">{o.action}</span>
                      {o.confidence != null && ` · ${(o.confidence * 100).toFixed(0)}%`}
                      {o.rationale && (
                        <span className="text-slate-500"> — {o.rationale}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-red-300/80">unavailable · {o.unavailable_reason}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
