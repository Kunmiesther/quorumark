/**
 * ScoutDefensePanel — displays the Scout's live defensive watch tasks.
 *
 * Each open paper position is guarded by the Scout: the protective
 * structural swing level, current status (Watching / Structure intact /
 * BROKEN), and the Onyx↔Scout handshake summary.
 */
import { CommandPanel } from "@/components/command/CommandPanel";
import { useScoutDefense, type DefenseWatchTask } from "@/hooks/useScoutDefense";
import { cn } from "@/lib/utils";
import { Shield, ShieldAlert, ShieldCheck, ArrowRightLeft } from "lucide-react";

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

function statusOf(w: DefenseWatchTask): { label: string; tone: string; icon: typeof Shield } {
  if (w.structureBroken) return { label: "BROKEN", tone: "text-[hsl(var(--state-danger))]", icon: ShieldAlert };
  if (w.protectiveLevel == null) return { label: "Watching", tone: "text-white/60", icon: Shield };
  return { label: "Structure intact", tone: "text-[hsl(var(--state-success))]", icon: ShieldCheck };
}

function WatchRow({ w }: { w: DefenseWatchTask }) {
  const s = statusOf(w);
  const Icon = s.icon;
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-white/[0.04] py-2.5 first:border-t-0">
      <Icon className={cn("h-4 w-4 shrink-0", s.tone)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-white">{w.symbol}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              w.direction === "long"
                ? "bg-[hsl(var(--state-success)/0.12)] text-[hsl(var(--state-success))]"
                : "bg-[hsl(var(--state-danger)/0.12)] text-[hsl(var(--state-danger))]",
            )}
          >
            {w.direction}
          </span>
          <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
            {w.strategy}
          </span>
          <span className="text-[10.5px] text-white/45">rungs {w.rungCount}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[10.5px] tabular-nums text-white/55">
          <span>entry {fmtPrice(w.entryPrice)}</span>
          <span>
            protect{" "}
            <span className="text-white/80">{fmtPrice(w.protectiveLevel)}</span>
            {w.protectiveKind ? ` (${w.protectiveKind})` : ""}
          </span>
          <span>age {Math.round(w.ageMinutes)}m</span>
          {w.structureBroken && w.brokenLevel != null && (
            <span className="text-[hsl(var(--state-danger))]">
              broke @ {fmtPrice(w.brokenLevel)}
            </span>
          )}
        </div>
      </div>
      <div className={cn("font-display text-[11px] font-bold uppercase tracking-wider", s.tone)}>
        {s.label}
      </div>
    </div>
  );
}

export function ScoutDefensePanel() {
  const { data, isLoading, isError, error } = useScoutDefense();

  return (
    <CommandPanel
      tone="warning"
      title={
        <span className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 text-[hsl(var(--state-warning))]" />
          Scout · Defense
        </span>
      }
      subtitle="Guarding open positions. Confirmed 5m close beyond the protective swing → BOS → Onyx exits (scout_bos)."
    >
      {isLoading ? (
        <p className="py-6 text-center text-[12px] text-white/50">Loading watch tasks…</p>
      ) : isError ? (
        <p className="py-6 text-center text-[12px] text-[hsl(var(--state-danger))]">
          {error instanceof Error ? error.message : "Failed to load defense state"}
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[
              { label: "Guarding", value: data?.handshake.guarding ?? 0, tone: "text-white" },
              {
                label: "Flagged BOS",
                value: data?.handshake.broken ?? 0,
                tone: (data?.handshake.broken ?? 0) > 0
                  ? "text-[hsl(var(--state-danger))]"
                  : "text-white/40",
              },
              { label: "Handoffs 24h", value: data?.handshake.handoffs24h ?? 0, tone: "text-[hsl(var(--data-cyan))]" },
              { label: "BOS 24h", value: data?.handshake.bosFlags24h ?? 0, tone: "text-white/70" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/[0.05]">
                <div className="text-[9.5px] uppercase tracking-wider text-white/40">{s.label}</div>
                <div className={cn("mt-1 font-display text-[18px] font-semibold tabular-nums leading-none", s.tone)}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          <div className="mb-2 flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-white/40">
            <ArrowRightLeft className="h-3 w-3" />
            Onyx handed {data?.handshake.handoffs24h ?? 0} fills → Scout guarding{" "}
            {data?.handshake.guarding ?? 0} → {data?.handshake.broken ?? 0} flagged BOS
          </div>

          {!data || data.watch.length === 0 ? (
            <p className="py-4 text-center text-[11.5px] text-white/45">
              No open positions to guard. Scout is on standby.
            </p>
          ) : (
            <div>
              {data.watch.map((w) => <WatchRow key={w.positionId} w={w} />)}
            </div>
          )}
        </>
      )}
    </CommandPanel>
  );
}
