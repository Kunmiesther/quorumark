/**
 * TurtleStatsCard — compact list of the six execution turtles beside the
 * position card under the chart. Reads exclusively from useTurtleStates so
 * this surface can never disagree with the Squad / Onyx views.
 *
 * Per row: turtle name, current state chip, trades, win %, realized P&L.
 * Sorted best → worst by realized P&L. Zeros render as literal "0" / "0%"
 * / "$0.00" — never placeholder glyphs.
 */
import { useMemo } from "react";
import { Radio } from "lucide-react";
import { useTurtleStates, type TurtleState, type TurtleStatus } from "@/hooks/useTurtleStates";

const STATUS_META: Record<TurtleStatus, { label: string; className: string }> = {
  armed:         { label: "Armed",       className: "border-amber-400/40 bg-amber-500/10 text-amber-200" },
  watching:      { label: "Watching",    className: "border-white/15 bg-white/[0.04] text-white/70" },
  "in-position": { label: "In-Position", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  "locked-out":  { label: "Locked-Out",  className: "border-rose-500/40 bg-rose-500/10 text-rose-300" },
  benched:      { label: "Benched",      className: "border-white/10 bg-white/[0.02] text-white/40" },
};

function fmtUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? "−" : v > 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${Math.round(v * 100)}%`;
}

export function TurtleStatsCard() {
  const q = useTurtleStates();
  const rows = useMemo<TurtleState[]>(() => {
    const list = [...(q.data ?? [])];
    list.sort((a, b) => b.realizedPnl - a.realizedPnl);
    return list;
  }, [q.data]);

  return (
    <section
      data-testid="turtle-stats-card"
      className="flex h-full flex-col gap-2 rounded-2xl border border-white/[0.06] bg-[#000] p-3 sm:p-3.5"
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-white/45">
          Turtle Stats
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/45">
          <Radio className="h-3 w-3 text-emerald-400" />
          Live
        </span>
      </header>

      {q.isLoading && rows.length === 0 ? (
        <p className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-4 text-center font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/40">
          Loading turtles…
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-4 text-center font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/40">
          No turtles reporting
        </p>
      ) : (
        <ul className="flex flex-1 flex-col divide-y divide-white/[0.04] rounded-xl border border-white/[0.05] bg-white/[0.02]">
          {rows.map((t) => (
            <TurtleRow key={t.key} turtle={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TurtleRow({ turtle }: { turtle: TurtleState }) {
  const meta = STATUS_META[turtle.status];
  const pnlPositive = turtle.realizedPnl > 0;
  const pnlNegative = turtle.realizedPnl < 0;
  const pnlClass = pnlPositive
    ? "text-emerald-400"
    : pnlNegative
      ? "text-rose-400"
      : "text-white/60";

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[11.5px] font-semibold tracking-tight text-white">
          {turtle.label}
        </span>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-[0.16em] ${meta.className}`}
        >
          {meta.label}
        </span>
      </div>
      <div className="flex items-center gap-3 font-mono text-[10.5px] tabular-nums text-white/70">
        <span className="w-8 text-right" title="Trades">
          {turtle.trades.toLocaleString()}
        </span>
        <span className="w-9 text-right text-white/55" title="Win rate">
          {fmtPct(turtle.winRate)}
        </span>
        <span className={`w-[68px] text-right font-semibold ${pnlClass}`} title="Realized P&L">
          {fmtUsd(turtle.realizedPnl)}
        </span>
      </div>
    </li>
  );
}
