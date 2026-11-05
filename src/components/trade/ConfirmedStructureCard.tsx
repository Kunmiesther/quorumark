/**
 * ConfirmedStructureCard — the "Structure" row on the trade desk. This is
 * now a two-card group: a compact SignalCard and the shared TurtleStatsCard.
 * They sit side by side on desktop and stack on mobile.
 *
 * Visual identity is preserved from the previous SignalCard (Onyx teal for
 * long/confirmed, negative red for short, amber pending, same font stack,
 * same dividers). What changed:
 *   - STATE headline shrunk substantially (was 36–44px, now 20–24px).
 *   - Confirmed price rows are capped at 3 per side with a subtle "+N more"
 *     line so the card stays compact even in dense states.
 *   - Section paddings tightened.
 *   - Footer no longer hardcodes "observation only — no orders placed".
 *     It reads the shared useExecutionStatus derivation and names the real
 *     routing state so the caption never lies when live orders are firing.
 *
 * No new data sources — same `latest` SignalEvent already used by the desk,
 * and useTurtleStates via TurtleStatsCard for the sibling card.
 */
import type { CSSProperties } from "react";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import type { SignalEvent } from "@/hooks/useSignalEvents";
import { useExecutionStatus } from "@/hooks/useExecutionStatus";
import { TurtleStatsCard } from "@/components/trade/TurtleStatsCard";

const ONYX_TEAL = "#2DD4BF";
const AMBER = "#FFB020";
const MAX_ROWS_PER_SIDE = 3;

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function fmtPrice(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtSecondsAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
function fmtCandleTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

type RetestStates = {
  confirmed?: unknown;
  pending?: unknown;
  expired_window?: unknown;
  expired_breach?: unknown;
};
type EntrySummary = {
  state?: string;
  direction?: string;
  zone_level?: unknown;
  zone_assumption?: string;
};
type DirectionEval = {
  breaks?: unknown;
  entries?: unknown;
  retests?: unknown;
  retest_states?: RetestStates;
  entry_summaries?: EntrySummary[];
};
type SideAgg = {
  confirmed: number;
  pending: number;
  breaks: number;
  retests: number;
  entries: number;
  summaries: EntrySummary[];
  totalSummaries: number;
};

function aggregate(dir?: DirectionEval): SideAgg {
  const rs = dir?.retest_states ?? {};
  const all = Array.isArray(dir?.entry_summaries) ? dir!.entry_summaries! : [];
  return {
    confirmed: num(rs.confirmed),
    pending: num(rs.pending),
    breaks: num(dir?.breaks),
    retests: num(dir?.retests),
    entries: num(dir?.entries),
    summaries: all.slice(0, MAX_ROWS_PER_SIDE),
    totalSummaries: all.length,
  };
}

export function ConfirmedStructureCard({ event }: { event: SignalEvent | null }) {
  return (
    <div
      data-testid="trade-structure-split"
      className="grid grid-cols-1 items-start gap-3 sm:gap-4 md:grid-cols-2"
    >
      <SurfaceCard as="section" className="flex flex-col overflow-hidden p-0">
        <div className="flex min-h-0 flex-1 flex-col p-2.5 sm:p-3">
          {event ? <SignalBody event={event} /> : <EmptyCollapsed />}
        </div>
      </SurfaceCard>
      <TurtleStatsCard />
    </div>
  );
}

/** Collapsed empty-state — a single line. Height ≈ 56–64px including padding. */
function EmptyCollapsed() {
  const exec = useExecutionStatus();
  return (
    <div
      data-testid="structure-collapsed"
      className="flex min-w-0 items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/55"
      title={exec.description}
    >
      <span className="truncate font-semibold text-white/85">BTC-USDT</span>
      <span className="shrink-0 text-white/30">·</span>
      <span className="shrink-0">15m</span>
      <span className="shrink-0 text-white/30">·</span>
      <span className="shrink-0 text-white/70">watching</span>
      <span className="shrink-0 text-white/30">·</span>
      <span className="truncate text-white/45">no zones</span>
      <span className="ml-auto shrink-0 text-white/35">{exec.label}</span>
    </div>
  );
}

function SignalBody({ event }: { event: SignalEvent }) {
  const exec = useExecutionStatus();
  const d = (event.detail ?? {}) as SignalEvent["detail"] & {
    directions?: { long?: DirectionEval; short?: DirectionEval };
  };
  const long = aggregate(
    (d.directions?.long ?? (d.long as unknown as DirectionEval | undefined)) as DirectionEval | undefined,
  );
  const short = aggregate(
    (d.directions?.short ?? (d.short as unknown as DirectionEval | undefined)) as DirectionEval | undefined,
  );

  const totalConfirmed = long.confirmed + short.confirmed;
  const totalPending = long.pending + short.pending;
  const hasAnyStructure = totalConfirmed > 0 || totalPending > 0;

  const symbol = (d.symbol ?? d.normalized_symbol ?? "—").toString().toUpperCase();
  const interval = d.interval_min ? `${num(d.interval_min)}m` : "—";
  const arrivedAgo = fmtSecondsAgo(event.created_at);

  // Collapsed single-line for any symbol when no structure has arrived yet.
  if (!hasAnyStructure) {
    return (
      <div
        data-testid="structure-collapsed"
        className="flex min-w-0 items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/55"
        title={exec.description}
      >
        <span className="truncate font-semibold text-white/85">{symbol}</span>
        <span className="shrink-0 text-white/30">·</span>
        <span className="shrink-0">{interval}</span>
        <span className="shrink-0 text-white/30">·</span>
        <span className="shrink-0 text-white/70">watching</span>
        <span className="shrink-0 text-white/30">·</span>
        <span className="truncate text-white/45">no zones</span>
        <span className="ml-auto shrink-0 tabular-nums text-white/35">{arrivedAgo}</span>
      </div>
    );
  }

  return <CompactSignal event={event} long={long} short={short} exec={exec} />;
}

function CompactSignal({
  event,
  long,
  short,
  exec,
}: {
  event: SignalEvent;
  long: SideAgg;
  short: SideAgg;
  exec: ReturnType<typeof useExecutionStatus>;
}) {
  const d = (event.detail ?? {}) as SignalEvent["detail"];

  const totalConfirmed = long.confirmed + short.confirmed;
  const totalPending = long.pending + short.pending;

  const heroLabel =
    totalConfirmed > 0 ? "Confirmed structure" : totalPending > 0 ? "Pending retest" : "Watching";
  const heroColor =
    totalConfirmed > 0 ? ONYX_TEAL : totalPending > 0 ? AMBER : "rgba(255,255,255,0.55)";

  const symbol = (d.symbol ?? d.normalized_symbol ?? "—").toString().toUpperCase();
  const interval = d.interval_min ? `${num(d.interval_min)}m` : "—";
  const arrivedAgo = fmtSecondsAgo(event.created_at);
  const isFresh = Date.now() - new Date(event.created_at).getTime() < 60_000;
  const candleLabel = fmtCandleTime(d.newest_completed_candle_ts_ms);

  return (
    <article className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white/[0.04] p-2.5 sm:p-3">
      <header className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11.5px] font-semibold uppercase tracking-[0.16em] text-white/85">
            {symbol}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
            · {interval}
          </span>
        </div>
        <span
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums"
          style={{ color: isFresh ? ONYX_TEAL : "rgba(255,255,255,0.4)" }}
        >
          {isFresh ? `live · ${arrivedAgo}` : arrivedAgo}
        </span>
      </header>

      {/* Hero state — normal card-title size, no STATE micro-label. */}
      <p
        className="mb-2 text-[15px] font-semibold leading-tight tracking-tight sm:text-[16px]"
        style={{ color: heroColor }}
      >
        {heroLabel}
      </p>

      <div className="grid grid-cols-2 divide-x divide-white/5 border-y border-white/5 py-1.5">
        <CompactSide side="long" agg={long} />
        <CompactSide side="short" agg={short} />
      </div>

      <ExecutionFooter
        execLabel={exec.label}
        execDescription={exec.description}
        candleLabel={candleLabel}
      />
    </article>
  );
}

function CompactSide({ side, agg }: { side: "long" | "short"; agg: SideAgg }) {
  const sideAccent = side === "long" ? ONYX_TEAL : "var(--negative)";
  const extra = Math.max(0, agg.totalSummaries - agg.summaries.length);

  return (
    <div className="min-w-0 px-2 py-1">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.22em] text-white/45">
          {side}
        </span>
        <span className="font-mono text-[9.5px] tabular-nums text-white/35">
          {agg.breaks}·{agg.retests}·{agg.entries}
        </span>
      </div>

      <div className="mb-1 flex items-baseline gap-2">
        <span
          className="text-[16px] font-semibold leading-none tabular-nums"
          style={{ color: agg.confirmed > 0 ? sideAccent : "rgba(255,255,255,0.55)" }}
        >
          {agg.confirmed}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">confirmed</span>
      </div>

      <div className="mb-1.5 flex items-baseline gap-2">
        <span
          className="text-[12px] font-medium leading-none tabular-nums"
          style={{ color: agg.pending > 0 ? AMBER : "rgba(255,255,255,0.4)" }}
        >
          {agg.pending}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">pending</span>
      </div>

      {agg.summaries.length > 0 ? (
        <ul className="space-y-0.5">
          {agg.summaries.map((e, i) => {
            const state = (e.state ?? "").toLowerCase();
            const dot =
              state === "confirmed" ? sideAccent : state === "pending" ? AMBER : "rgba(255,255,255,0.25)";
            return (
              <li
                key={i}
                className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 font-mono text-[10.5px] tabular-nums text-white/80"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot } as CSSProperties} />
                <span className="truncate tabular-nums">{fmtPrice(e.zone_level)}</span>
                <span className="truncate text-[9.5px] uppercase tracking-wider text-white/35">
                  {e.state ?? "—"}
                </span>
              </li>
            );
          })}
          {extra > 0 && (
            <li className="pt-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
              +{extra} more
            </li>
          )}
        </ul>
      ) : (
        <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/25">no zones</p>
      )}
    </div>
  );
}

function ExecutionFooter({
  execLabel,
  execDescription,
  candleLabel,
}: {
  execLabel: string;
  execDescription: string;
  candleLabel: string;
}) {
  // Backend-driven mode caption — never hardcodes "observation only".
  // Shows the same status the ExecutionStatusChip surfaces, so if live
  // routing is on the footer reflects that here as well.
  return (
    <footer
      data-testid="structure-exec-footer"
      className="mt-2 flex items-center justify-between gap-3 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/45"
    >
      <span className="truncate" title={execDescription}>
        {execLabel}
      </span>
      <span className="shrink-0 tabular-nums text-white/35">candle {candleLabel}</span>
    </footer>
  );
}
