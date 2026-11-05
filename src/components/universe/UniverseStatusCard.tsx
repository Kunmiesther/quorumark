/**
 * UniverseStatusCard — compact operational status of the dynamic
 * market-universe pipeline. Reads persisted state via
 * `getUniverseStatus`. Shows flag state, snapshot freshness, and the
 * top-ranked symbols currently approved for new entries.
 *
 * Paper-only; when the flag is OFF the card renders a compact "static
 * universe" hint instead of hiding, so operators can see the pipeline
 * exists and is intentionally idle.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getUniverseStatus } from "@/lib/universe/status.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function UniverseStatusCard() {
  const fn = useServerFn(getUniverseStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["universe-status"],
    queryFn: () => fn({}),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const flagOn = !!data?.flagActive;
  const hasSnap = !!data?.snapshotId;

  return (
    <Card className="p-3 text-xs bg-black/40 border-cyan-500/20">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono uppercase tracking-wider text-cyan-300/80">
          Universe Gate
        </div>
        <Badge
          variant="outline"
          className={
            flagOn
              ? hasSnap
                ? "border-emerald-500/40 text-emerald-300"
                : "border-amber-500/40 text-amber-300"
              : "border-slate-500/40 text-slate-300"
          }
        >
          {flagOn ? (hasSnap ? "ACTIVE" : "STARVED") : "STATIC"}
        </Badge>
      </div>

      {isLoading && <div className="text-slate-500">loading…</div>}

      {!isLoading && data && (
        <div className="space-y-1 font-mono text-[11px] text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-500">reason</span>
            <span>{data.reason}</span>
          </div>
          {data.ageMs != null && (
            <div className="flex justify-between">
              <span className="text-slate-500">snapshot age</span>
              <span>{Math.round(data.ageMs / 1000)}s</span>
            </div>
          )}
          {data.capacity && (
            <>
              <div className="flex justify-between">
                <span className="text-slate-500">slots</span>
                <span>
                  {data.capacity.active + data.capacity.committed}/
                  {data.capacity.absoluteCeiling} active · {data.capacity.unassigned} free
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">reserved</span>
                <span>
                  hedge {data.capacity.reservedForHedge} · recov{" "}
                  {data.capacity.reservedForRecovery}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">max new</span>
                <span className="text-cyan-300">{data.capacity.maxNewEntries}</span>
              </div>
            </>
          )}
          {hasSnap && (
            <div className="flex justify-between">
              <span className="text-slate-500">ranked</span>
              <span>
                {data.rankedCount ?? 0}/{data.eligibleCount ?? 0} of{" "}
                {data.exchangeSymbolCount ?? 0}
              </span>
            </div>
          )}
          {data.topRanked.length > 0 && (
            <div className="pt-2 border-t border-slate-800/50">
              <div className="text-slate-500 mb-1">approved</div>
              <div className="flex flex-wrap gap-1">
                {data.topRanked.slice(0, 6).map((r) => (
                  <span
                    key={r.symbol}
                    className={`px-1.5 py-0.5 rounded border ${
                      r.direction === "long"
                        ? "border-emerald-500/30 text-emerald-300"
                        : r.direction === "short"
                          ? "border-rose-500/30 text-rose-300"
                          : "border-slate-600/30 text-slate-400"
                    }`}
                  >
                    {r.symbol.replace("-USDT", "")}
                    {r.direction === "long" ? "↑" : r.direction === "short" ? "↓" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasSnap && data.topRanked.length === 0 && data.rejectionReasons.length > 0 && (
            <div className="pt-2 border-t border-slate-800/50">
              <div className="text-slate-500 mb-1">top rejects</div>
              <div className="space-y-0.5">
                {data.rejectionReasons.map((r) => (
                  <div key={r.reason} className="flex justify-between text-slate-400">
                    <span>{r.reason}</span>
                    <span className="text-slate-500">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.slots && data.slots.length > 0 && (
            <div className="pt-2 border-t border-slate-800/50">
              <div className="text-slate-500 mb-1">slots</div>
              <div className="grid grid-cols-1 gap-0.5">
                {data.slots.map((s) => (
                  <div key={s.slotIndex} className="flex justify-between text-[10px]">
                    <span className="text-slate-500">#{s.slotIndex}</span>
                    <span
                      className={
                        s.state === "unassigned"
                          ? "text-slate-400"
                          : s.state === "hedge_reserved" || s.state === "recovery_reserved"
                            ? "text-amber-300/80"
                            : "text-cyan-300"
                      }
                    >
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.epoch && (
            <div className="pt-2 border-t border-slate-800/50 text-[10px] text-slate-500">
              run <span className="text-slate-300">{data.epoch.runId}</span> · {data.epoch.reason}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

