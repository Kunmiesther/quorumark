import { useScoutActivation } from "@/hooks/useScoutActivation";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { cn } from "@/lib/utils";
import type { ScoutFleetReport } from "@/lib/scout/types";
import { Loader2, RefreshCw } from "lucide-react";

interface Props {
  data: ScoutFleetReport | undefined;
  isScanning: boolean;
  onRefresh: () => void;
}

const HEALTH_TONE: Record<ScoutFleetReport["health"], string> = {
  healthy:
    "text-[hsl(var(--state-success))] ring-[hsl(var(--state-success)/0.3)] bg-[hsl(var(--state-success)/0.1)]",
  degraded: "text-amber-300 ring-amber-500/30 bg-amber-500/10",
  stale: "text-amber-300 ring-amber-500/30 bg-amber-500/10",
  offline: "text-white/50 ring-white/[0.08] bg-white/[0.03]",
};

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ScoutHeader({ data, isScanning, onRefresh }: Props) {
  const { active, toggle, saving, unauthenticated, error, persistent } = useScoutActivation();
  const reducedMotion = useReducedMotion();
  const health = data?.health ?? (active ? "stale" : "offline");
  const watched = data?.symbols.length ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full",
                active
                  ? "bg-[hsl(var(--data-cyan))] shadow-[0_0_10px_hsl(var(--data-cyan))]"
                  : "bg-white/25",
                active && isScanning && !reducedMotion && "animate-pulse",
              )}
            />
            <span className="font-display text-[12px] font-semibold uppercase tracking-[0.18em] text-white">
              {active ? "Scout Intelligence On" : "Scout Intelligence Off"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-white/55">
            Monitoring only · No trade execution · Multi-timeframe read-only recon
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={active ? "Turn Scout off" : "Turn Scout on"}
            disabled={saving || unauthenticated}
            onClick={() => toggle()}
            className={cn(
              "inline-flex h-7 w-14 items-center rounded-full ring-1 transition disabled:opacity-50",
              active
                ? "bg-[hsl(var(--data-cyan)/0.35)] ring-[hsl(var(--data-cyan)/0.6)]"
                : "bg-white/[0.06] ring-white/15",
            )}
          >
            <span
              className={cn(
                "h-6 w-6 rounded-full bg-white shadow transition-transform",
                active ? "translate-x-7" : "translate-x-0.5",
              )}
            />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!active || isScanning}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-white/80 ring-1 ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-40"
          >
            {isScanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isScanning ? "Scanning" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-white/[0.03] p-2 ring-1 ring-white/[0.06]">
          <div className="text-[9px] uppercase tracking-wider text-white/40">Last scan</div>
          <div className="mt-0.5 font-display text-[13px] tabular-nums text-white">
            {fmtTime(data?.finishedAt)}
          </div>
        </div>
        <div className="rounded-md bg-white/[0.03] p-2 ring-1 ring-white/[0.06]">
          <div className="text-[9px] uppercase tracking-wider text-white/40">Next refresh</div>
          <div className="mt-0.5 font-display text-[13px] tabular-nums text-white">
            {fmtTime(data?.nextRefreshAt)}
          </div>
        </div>
        <div className="rounded-md bg-white/[0.03] p-2 ring-1 ring-white/[0.06]">
          <div className="text-[9px] uppercase tracking-wider text-white/40">Watched</div>
          <div className="mt-0.5 font-display text-[13px] tabular-nums text-white">{watched}</div>
        </div>
        <div className={cn("rounded-md p-2 ring-1", HEALTH_TONE[health])}>
          <div className="text-[9px] uppercase tracking-wider opacity-70">Health</div>
          <div className="mt-0.5 font-display text-[13px] font-bold uppercase leading-none">
            {health}
          </div>
        </div>
      </div>

      {unauthenticated && (
        <p className="mt-2 text-[11px] text-amber-300">
          Sign in to persist your Scout preference across devices.
        </p>
      )}
      {error ? (
        <p className="mt-2 text-[11px] text-rose-300" role="alert">
          Scout preference could not be saved: {error}
        </p>
      ) : !persistent ? (
        <p className="mt-2 text-[11px] text-cyan-200/60">
          Scout is running in compatibility mode; this device remembers the switch.
        </p>
      ) : null}
    </div>
  );
}
