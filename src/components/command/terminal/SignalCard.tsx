import type { SignalEvent } from "@/hooks/useSignalEvents";

/** Onyx identity color — teal, reserved for Onyx state readout + long side. */
const ONYX_TEAL = "#2DD4BF";
const AMBER = "#FFB020";

/** Coerce jsonb value (string | number | null) to a finite number, else 0. */
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
};

function aggregate(dir?: DirectionEval): SideAgg {
  const rs = dir?.retest_states ?? {};
  return {
    confirmed: num(rs.confirmed),
    pending: num(rs.pending),
    breaks: num(dir?.breaks),
    retests: num(dir?.retests),
    entries: num(dir?.entries),
    summaries: Array.isArray(dir?.entry_summaries) ? dir!.entry_summaries!.slice(0, 3) : [],
  };
}

function SideColumn({ side, agg }: { side: "long" | "short"; agg: SideAgg }) {
  // Direction accent: long = Onyx teal, short = negative red.
  const sideAccent = side === "long" ? ONYX_TEAL : "var(--negative)";

  return (
    <div className="min-w-0 px-1 py-1">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">
          {side}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-white/35">
          {agg.breaks}·{agg.retests}·{agg.entries}
        </span>
      </div>

      <div className="mb-3">
        <div
          className="text-[36px] font-semibold leading-none tabular-nums"
          style={{ color: agg.confirmed > 0 ? sideAccent : "rgba(255,255,255,0.55)" }}
        >
          {agg.confirmed}
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
          confirmed
        </div>
      </div>

      <div className="mb-3">
        <div
          className="text-[15px] font-medium leading-none tabular-nums"
          style={{ color: agg.pending > 0 ? AMBER : "rgba(255,255,255,0.4)" }}
        >
          {agg.pending}
          <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            pending
          </span>
        </div>
      </div>

      {agg.summaries.length > 0 ? (
        <ul className="space-y-1">
          {agg.summaries.map((e, i) => {
            const state = (e.state ?? "").toLowerCase();
            const isConfirmed = state === "confirmed";
            const isPending = state === "pending";
            const dot = isConfirmed
              ? sideAccent
              : isPending
                ? AMBER
                : "rgba(255,255,255,0.25)";
            return (
              <li
                key={i}
                className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 font-mono text-[11px] tabular-nums text-white/80"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: dot }}
                />
                <span className="truncate tabular-nums">{fmtPrice(e.zone_level)}</span>
                <span className="truncate text-[10px] uppercase tracking-wider text-white/35">
                  {e.state ?? "—"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/25">
          no zones
        </p>
      )}
    </div>
  );
}


export function SignalCard({ event }: { event: SignalEvent }) {
  const d = (event.detail ?? {}) as SignalEvent["detail"] & {
    directions?: { long?: DirectionEval; short?: DirectionEval };
  };
  const long = aggregate(
    (d.directions?.long ?? (d.long as unknown as DirectionEval | undefined)) as
      | DirectionEval
      | undefined,
  );
  const short = aggregate(
    (d.directions?.short ?? (d.short as unknown as DirectionEval | undefined)) as
      | DirectionEval
      | undefined,
  );

  const totalConfirmed = long.confirmed + short.confirmed;
  const totalPending = long.pending + short.pending;

  const heroLabel =
    totalConfirmed > 0
      ? "Confirmed structure"
      : totalPending > 0
        ? "Pending retest"
        : "Watching";
  // Hero is Onyx's state readout → Onyx teal when confirmed.
  const heroColor =
    totalConfirmed > 0
      ? ONYX_TEAL
      : totalPending > 0
        ? AMBER
        : "rgba(255,255,255,0.55)";

  const symbol = (d.symbol ?? d.normalized_symbol ?? "—").toString().toUpperCase();
  const interval = d.interval_min ? `${num(d.interval_min)}m` : "—";
  const arrivedAgo = fmtSecondsAgo(event.created_at);
  const isFresh = Date.now() - new Date(event.created_at).getTime() < 60_000;
  const candleLabel = fmtCandleTime(d.newest_completed_candle_ts_ms);

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl bg-white/[0.04] p-5">
      {/* Header */}
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-white/85">
            {symbol}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
            · {interval}
          </span>
        </div>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums"
          style={{ color: isFresh ? ONYX_TEAL : "rgba(255,255,255,0.4)" }}
        >
          {isFresh ? `live · ${arrivedAgo}` : arrivedAgo}
        </span>
      </header>

      {/* Hero state */}
      <div className="mb-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/40">
          state
        </p>
        <p
          className="mt-2 text-[36px] font-semibold leading-[1.05] tracking-tight lg:text-[44px]"
          style={{ color: heroColor }}
        >
          {heroLabel}
        </p>
      </div>

      {/* Long / Short split */}
      <div className="grid grid-cols-2 divide-x divide-white/5 border-y border-white/5 py-4">
        <SideColumn side="long" agg={long} />
        <SideColumn side="short" agg={short} />
      </div>

      {/* Footer ticker */}
      <footer className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
        <span>observation only — no orders placed</span>
        <span className="tabular-nums">candle {candleLabel}</span>
      </footer>
    </article>
  );
}
