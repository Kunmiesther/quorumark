/**
 * ScoutQueuePanel — the dense, ranked opportunity queue for the desk's left
 * rail. Shows EVERY Scout candidate the committee reviewed for the current
 * cycle (not just BTC), ordered by rank, with the strongest actionable setup
 * highlighted.
 *
 * Read-only: it renders the same persisted `committee_cycles` /
 * `committee_shortlist` rows as the full ShortlistPanel through the shared
 * `useShortlistCycle` subscription. Selecting a row only changes the desk's
 * displayed instrument — no orders, no engine calls.
 */
import { useMemo } from "react";
import { useShortlistCycle } from "@/hooks/useShortlistCycle";
import type { ShortlistRowDto } from "@/lib/ai/shortlist.functions";
import { cn } from "@/lib/utils";

function stateTone(row: ShortlistRowDto): { label: string; color: string } {
  if (row.selected) {
    const type = row.entryPlan?.entryType;
    return type === "limit"
      ? { label: "Pending entry", color: "var(--onixus-hot-blue)" }
      : { label: "Approved", color: "var(--onixus-teal)" };
  }
  if (row.state === "rejected") return { label: "Not approved", color: "rgba(230,232,240,0.42)" };
  if (row.state === "degraded") return { label: "Limited review", color: "var(--warning)" };
  return { label: "In review", color: "rgba(230,232,240,0.72)" };
}

const numOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function strengthPct(row: ShortlistRowDto): number {
  const s = row.score;
  if (s == null) return 0;
  // Scores are unit-ish; clamp defensively so the bar can never overflow.
  return Math.max(0, Math.min(100, s <= 1 ? s * 100 : s));
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function ScoutQueuePanel({
  book = "paper",
  activeSymbol,
  onSelectSymbol,
}: {
  book?: "paper" | "live";
  activeSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
}) {
  const q = useShortlistCycle(book);
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const lead = useMemo(
    () => rows.find((r) => r.selected) ?? rows[0] ?? null,
    [rows],
  );
  const scanning = q.data?.status === "running" || q.isFetching;

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-[color:var(--surface-1)]"
      data-testid="scout-queue"
    >
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", scanning && "animate-pulse")}
            style={{ background: scanning ? "var(--onixus-teal)" : "rgba(230,232,240,0.35)" }}
          />
          <h3 className="truncate text-[11px] font-bold uppercase tracking-[0.16em] text-white">
            Opportunities
          </h3>
        </div>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/40">
          {q.data ? `${q.data.candidateCount ?? rows.length}/${q.data.universeSize ?? "—"}` : "—"}
        </span>
      </header>

      <div className="border-b border-white/[0.05] px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/40">
        Trade review {relTime(q.data?.startedAt ?? null)} · {q.data?.status === "running" ? "in progress" : (q.data?.status ?? "idle")}
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-white/[0.05] overflow-y-auto">
        {q.isLoading ? (
          <li className="px-3 py-6 text-center text-[11px] text-white/40">Reviewing the market…</li>
        ) : rows.length === 0 ? (
          <li className="px-3 py-6 text-center text-[11px] leading-snug text-white/40">
            {q.data?.noTradeReason
              ? q.data.noTradeReason.replace(/_/g, " ")
              : "No opportunities in this review"}
          </li>
        ) : (
          rows.map((r) => (
            <QueueRow
              key={r.id}
              row={r}
              isLead={lead?.id === r.id}
              isActive={activeSymbol === r.symbol}
              onSelect={onSelectSymbol}
            />
          ))
        )}
      </ul>
    </section>
  );
}

function QueueRow({
  row,
  isLead,
  isActive,
  onSelect,
}: {
  row: ShortlistRowDto;
  isLead: boolean;
  isActive: boolean;
  onSelect?: (symbol: string) => void;
}) {
  const tone = stateTone(row);
  const plan = row.entryPlan;
  const entry = numOf(plan?.entryPrice) ?? numOf(plan?.entry);
  const low = numOf(plan?.entryLow);
  const high = numOf(plan?.entryHigh);
  const tf = typeof plan?.timeframe === "string" ? plan.timeframe : null;
  const long = row.direction === "long";
  const seatsOk = row.seats.filter((s) => s.available).length;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect?.(row.symbol)}
        className={cn(
          "w-full px-3 py-2 text-left transition-colors hover:bg-white/[0.03]",
          isActive && "bg-white/[0.05]",
        )}
        style={
          isLead
            ? { boxShadow: "inset 2px 0 0 0 var(--onixus-teal)" }
            : undefined
        }
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-mono text-[9.5px] tabular-nums text-white/35">
              {row.rank ?? "—"}
            </span>
            <span className="truncate text-[12px] font-semibold text-white">
              {row.symbol.replace("-", "/")}
            </span>
            {row.direction ? (
              <span
                className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-[0.1em]"
                style={{
                  color: long ? "var(--onixus-teal)" : "var(--onixus-red)",
                  background: `color-mix(in oklab, ${long ? "var(--onixus-teal)" : "var(--onixus-red)"} 14%, transparent)`,
                }}
              >
                {long ? "L" : "S"}
              </span>
            ) : null}
          </div>
          <span
            className="shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.12em]"
            style={{ color: tone.color }}
          >
            {tone.label}
          </span>
        </div>

        <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${strengthPct(row)}%`,
              background: isLead ? "var(--onixus-teal)" : "var(--onixus-purple)",
            }}
          />
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[9.5px] tabular-nums text-white/50">
          <span>
            {row.netEdgeBps == null ? "— bps" : `${row.netEdgeBps.toFixed(1)} bps`}
          </span>
          <span className="text-white/25">·</span>
          <span>{tf ?? "15m"}</span>
          <span className="text-white/25">·</span>
          <span className="truncate">
            {low != null && high != null
              ? `${low} – ${high}`
              : entry != null
                ? `@ ${entry}`
                : "no zone"}
          </span>
          <span className="ml-auto text-white/35">{seatsOk}/3 analysts</span>
        </div>

        {row.rejectionReason ? (
          <p className="mt-0.5 truncate font-mono text-[9px] text-white/35">
            {row.rejectionReason.replace(/_/g, " ")}
          </p>
        ) : null}
      </button>
    </li>
  );
}
