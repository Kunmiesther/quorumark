import { cn } from "@/lib/utils";
import type { Timeframe, TimeframeState, TfState, ReasonCode } from "@/lib/scout/types";
import { TIMEFRAMES, TIMEFRAME_LABEL, TIMEFRAME_ROLE } from "@/lib/scout/types";

const STATE_TONE: Record<TfState, string> = {
  bullish: "bg-[hsl(var(--state-success)/0.18)] text-[hsl(var(--state-success))] ring-[hsl(var(--state-success)/0.4)]",
  bearish: "bg-[hsl(var(--state-danger)/0.18)] text-[hsl(var(--state-danger))] ring-[hsl(var(--state-danger)/0.4)]",
  neutral: "bg-white/[0.04] text-white/60 ring-white/10",
  mixed: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  unavailable: "bg-white/[0.02] text-white/25 ring-white/[0.06]",
};

const STATE_GLYPH: Record<TfState, string> = {
  bullish: "▲",
  bearish: "▼",
  neutral: "◆",
  mixed: "±",
  unavailable: "·",
};

const REASON_LABEL: Record<ReasonCode, string> = {
  ema_stack_up: "EMA stack up",
  ema_stack_down: "EMA stack down",
  slope_flat: "slope flat",
  range_compression: "range compression",
  bos_up: "BOS up",
  bos_down: "BOS down",
  atr_spike: "ATR spike",
  insufficient_history: "insufficient history",
  stale_data: "stale data",
  aggregation_gap: "aggregation gap",
};

/**
 * Seven timeframe cells. Uses a 4-column grid on narrow widths (two rows: 4+3)
 * and expands to a single 7-column strip at `sm:` and up, so cells always stay
 * readable and never overflow the card.
 */
export function TimeframeMatrix({ states }: { states: TimeframeState[] }) {
  const byTf = new Map(states.map((s) => [s.tf, s]));
  return (
    <div
      role="grid"
      aria-label="Timeframe evidence matrix"
      className="grid grid-cols-4 gap-1 sm:grid-cols-7"
    >
      {TIMEFRAMES.map((tf: Timeframe) => {
        const s = byTf.get(tf);
        const state: TfState = s?.state ?? "unavailable";
        const reasonText =
          s && s.reasons.length > 0
            ? s.reasons.map((r) => REASON_LABEL[r] ?? r).join(" · ")
            : "no evidence";
        return (
          <div
            key={tf}
            role="gridcell"
            title={`${TIMEFRAME_LABEL[tf]} (${TIMEFRAME_ROLE[tf]}) — ${state}${
              s?.stale ? " · stale" : ""
            }\n${reasonText}`}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center rounded-md px-1 py-1.5 ring-1",
              STATE_TONE[state],
            )}
          >
            <span className="text-[9px] uppercase tracking-wider opacity-70">
              {TIMEFRAME_LABEL[tf]}
            </span>
            <span className="text-[13px] leading-none">{STATE_GLYPH[state]}</span>
          </div>
        );
      })}
    </div>
  );
}
