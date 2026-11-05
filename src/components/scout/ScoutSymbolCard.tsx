import { cn } from "@/lib/utils";
import type { ScoutSymbolReport, TimeframeState } from "@/lib/scout/types";
import { TIMEFRAME_LABEL } from "@/lib/scout/types";
import { TimeframeMatrix } from "./TimeframeMatrix";
import { Anchor, AlertTriangle, ChevronDown } from "lucide-react";
import { useState } from "react";

function biasLabel(bias: ScoutSymbolReport["consensus"]["bias"]): string {
  switch (bias) {
    case "long-priority": return "LONG";
    case "short-priority": return "SHORT";
    case "balanced": return "BALANCED";
    case "no-signal": return "NO-SIGNAL";
  }
}

const BIAS_TONE: Record<ScoutSymbolReport["consensus"]["bias"], string> = {
  "long-priority": "text-[hsl(var(--state-success))] ring-[hsl(var(--state-success)/0.35)] bg-[hsl(var(--state-success)/0.1)]",
  "short-priority": "text-[hsl(var(--state-danger))] ring-[hsl(var(--state-danger)/0.35)] bg-[hsl(var(--state-danger)/0.1)]",
  balanced: "text-white/70 ring-white/15 bg-white/[0.04]",
  "no-signal": "text-white/40 ring-white/[0.08] bg-white/[0.02]",
};

const READY_TONE: Record<ScoutSymbolReport["consensus"]["readiness"], string> = {
  armed: "text-[hsl(var(--data-cyan))] ring-[hsl(var(--data-cyan)/0.35)] bg-[hsl(var(--data-cyan)/0.1)]",
  watching: "text-amber-300 ring-amber-500/30 bg-amber-500/10",
  "no-signal": "text-white/40 ring-white/[0.08] bg-white/[0.02]",
};

function fmtAge(ageMs: number | null): string {
  if (ageMs == null) return "—";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function failCategory(s: TimeframeState): string {
  if (s.state !== "unavailable" && !s.stale) return "ok";
  if (s.reasons.includes("stale_data")) return "stale";
  if (s.reasons.includes("insufficient_history")) return "insufficient history";
  if (s.reasons.includes("aggregation_gap")) return "aggregation gap";
  return "no data";
}

export function ScoutSymbolCard({ report }: { report: ScoutSymbolReport }) {
  const { consensus } = report;
  const [expanded, setExpanded] = useState(false);
  const confPct = Math.round(consensus.confidence * 100);
  const conflictPct = Math.round(consensus.conflict * 100);
  const availPct = Math.round(consensus.availability * 100);

  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      {/* Row 1: identity + flags. Symbol never wraps. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate whitespace-nowrap font-display text-[14px] font-semibold text-white">
          {report.symbol}
        </span>
        {report.anchor && (
          <Anchor
            className="h-3 w-3 shrink-0 text-[hsl(var(--data-cyan))]"
            aria-label="anchor"
          />
        )}
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-white/40">
          {report.base}
        </span>
      </div>

      {/* Row 2: mode / bias / readiness — dedicated non-overlapping row. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-white/[0.04] text-white/60 ring-1 ring-white/10">
          Monitor
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1",
            BIAS_TONE[consensus.bias],
          )}
        >
          {biasLabel(consensus.bias)}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1",
            READY_TONE[consensus.readiness],
          )}
        >
          {consensus.readiness}
        </span>
      </div>

      {/* Row 3: health/freshness — separate row, never overlaps badges. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-white/45">
        <span>avail {availPct}%</span>
        <span>conflict {conflictPct}%</span>
        {report.degraded && (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <AlertTriangle className="h-3 w-3" /> degraded
          </span>
        )}
      </div>

      {/* Confidence bar */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/45">
          <span>Confidence</span>
          <span className="tabular-nums text-white/70">{confPct}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-[hsl(var(--data-cyan))]"
            style={{ width: `${confPct}%` }}
          />
        </div>
      </div>

      {/* Timeframe matrix */}
      <div className="mt-3">
        <TimeframeMatrix states={report.timeframes} />
      </div>

      {consensus.readiness !== "armed" && (
        <div className="mt-2 text-[10.5px] leading-snug text-white/45">
          {consensus.bias === "no-signal"
            ? "Higher-timeframe context missing or stale — no bias published."
            : consensus.readiness === "watching"
              ? "Bias formed; waiting for lower-timeframe confirmation."
              : ""}
        </div>
      )}

      {/* Data-health expander */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 self-start rounded text-[10px] uppercase tracking-wider text-white/45 hover:text-white/70"
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
        />
        Data health
      </button>
      {expanded && (
        <div className="mt-1 overflow-x-auto rounded-md bg-black/30 p-2 ring-1 ring-white/[0.06]">
          <table className="w-full text-[10.5px] tabular-nums text-white/70">
            <thead className="text-white/40">
              <tr>
                <th className="text-left font-normal">TF</th>
                <th className="text-left font-normal">State</th>
                <th className="text-left font-normal">Age</th>
                <th className="text-left font-normal">Issue</th>
              </tr>
            </thead>
            <tbody>
              {report.timeframes.map((s) => (
                <tr key={s.tf}>
                  <td>{TIMEFRAME_LABEL[s.tf]}</td>
                  <td>{s.state}</td>
                  <td>{fmtAge(s.ageMs)}</td>
                  <td className={cn(s.stale || s.state === "unavailable" ? "text-amber-300" : "text-white/50")}>
                    {failCategory(s)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
