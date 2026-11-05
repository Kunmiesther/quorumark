/**
 * IntelligenceHub — combined command view of the 6 turtles + Onyx.
 *
 * Single source of truth: reads `useTurtleStates`. Advisory only, no writes.
 * Adds per-turtle open-signal detail + Scout activity feed sourced from
 * `bot_events` (PAPER_TICK_REASONS, guardian verdicts, onyx_decisions).
 */
import { useMemo } from "react";
import {
  useTurtleStates,
  type TurtleState,
  type OpenSignal,
  type TurtleStatus,
  type TurtleKey,
} from "@/hooks/useTurtleStates";
import { useBotEvents } from "@/hooks/useBotEvents";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<
  TurtleStatus,
  { dot: string; label: string; text: string; ring: string }
> = {
  armed:         { dot: "bg-[color:var(--accent)]",   label: "Armed",       text: "text-[color:var(--accent)]",  ring: "ring-[color:var(--accent)]/30" },
  watching:      { dot: "bg-white/40",                label: "Watching",    text: "text-white/60",                ring: "ring-white/10" },
  "in-position": { dot: "bg-[color:var(--positive)]", label: "In position", text: "text-[color:var(--positive)]", ring: "ring-[color:var(--positive)]/30" },
  "locked-out":  { dot: "bg-amber-400",               label: "Locked-out",  text: "text-amber-300",               ring: "ring-amber-400/25" },
  benched:       { dot: "bg-white/20",                label: "Benched",     text: "text-white/40",                ring: "ring-white/5" },
};

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const fmtSigned = (n: number) => `${n >= 0 ? "+" : ""}${fmtUsd(n)}`;

const fmtPrice = (n: number | null) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });

const ZERO_ROSTER: TurtleState[] = (
  [
    { key: "vanguard",    label: "Vanguard",    role: "Break-and-retest frontline" },
    { key: "accumulator", label: "Accumulator", role: "5-rung compounding ladder" },
    { key: "sniper",      label: "Sniper",      role: "Zone-reversal precision" },
    { key: "hunter",      label: "Hunter",      role: "Fair-value-gap tracker" },
    { key: "arbiter",     label: "Arbiter",     role: "Market-neutral funding arb" },
  ] as Array<{ key: TurtleKey; label: string; role: string }>
).map<TurtleState>((r) => ({
  ...r,
  status: "watching",
  openPositions: 0,
  openSignals: [],
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  realizedPnl: 0,
  lockedSymbols: [],
  armedSymbols: [],
}));

export function IntelligenceHub({ book = "paper" }: { book?: "paper" | "live" } = {}) {
  const isLive = book === "live";
  const { data, isLoading } = useTurtleStates();
  const states = isLive ? ZERO_ROSTER : (data ?? []);

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-black p-5">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-white/50">
            Intelligence Hub
          </p>
          <h3 className="mt-1 font-display text-[16px] font-semibold uppercase tracking-[0.08em] text-white">
            Turtle collective · {isLive ? "live state" : "paper state"}
          </h3>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/35">
          Observation only
        </p>
      </header>

      {!isLive && isLoading && states.length === 0 ? (
        <p className="text-[12px] text-white/50">Loading turtle states…</p>
      ) : (
        <div className="grid auto-rows-fr gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {states.map((t) => (
            <TurtleRow key={t.key} state={t} />
          ))}
          <ScoutActivityFeed live={isLive} />
        </div>
      )}
    </section>
  );
}

function TurtleRow({ state: t }: { state: TurtleState }) {
  const tone = STATUS_TONE[t.status];
  const pnlColor =
    t.realizedPnl > 0
      ? "text-[color:var(--positive)]"
      : t.realizedPnl < 0
        ? "text-[color:var(--negative)]"
        : "text-white/60";
  return (
    <article
      className={cn(
        "group relative rounded-xl border border-white/[0.06] bg-white/[0.015] p-3 ring-1 transition-colors hover:border-white/15",
        tone.ring,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-white">
            {t.label}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-white/50">{t.role}</p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
            tone.text,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
          {tone.label}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-white/[0.05] pt-3">
        <Stat label="Open" value={String(t.openPositions)} />
        <Stat label="Trades" value={String(t.trades)} />
        <Stat
          label="Win %"
          value={t.trades ? `${Math.round(t.winRate * 100)}%` : "—"}
        />
      </dl>
      <p className={cn("mt-2 font-display text-[13px] font-semibold tabular-nums", pnlColor)}>
        {t.trades ? fmtSigned(t.realizedPnl) : "—"}
      </p>

      {t.openSignals.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-white/[0.05] pt-2">
          {t.openSignals.slice(0, 3).map((s, i) => (
            <SignalLine key={`${s.symbol}-${s.side}-${i}`} signal={s} />
          ))}
        </ul>
      )}

      {t.status === "locked-out" && t.lockedSymbols.length > 0 && (
        <p className="mt-2 border-t border-white/[0.05] pt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-300/80">
          Cooling · {t.lockedSymbols.slice(0, 3).join(", ")}
        </p>
      )}
      {t.status === "armed" && t.armedSymbols.length > 0 && (
        <p className="mt-2 border-t border-white/[0.05] pt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]/85">
          Armed · {t.armedSymbols.slice(0, 3).join(", ")}
        </p>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9.5px] font-semibold uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="mt-0.5 font-display text-[14px] font-semibold tabular-nums text-white">
        {value}
      </dd>
    </div>
  );
}

function SignalLine({ signal }: { signal: OpenSignal }) {
  const sideColor =
    signal.side === "long"
      ? "text-[color:var(--positive)]"
      : "text-[color:var(--negative)]";
  return (
    <li className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-white/70">
      <span className={cn("shrink-0 font-semibold uppercase tracking-[0.12em]", sideColor)}>
        {signal.symbol.replace("-USDT", "")} · {signal.side}
      </span>
      <span className="truncate tabular-nums text-white/60">
        @ {fmtPrice(signal.entry)}
        {signal.promoted ? (
          <>
            {" · BE "}
            {fmtPrice(signal.runnerBreakevenStop)}
            <span className="ml-1 rounded bg-[color:var(--accent)]/20 px-1 text-[9px] uppercase tracking-wider text-[color:var(--accent)]">
              runner
            </span>
          </>
        ) : (
          <>
            {" · SL "}
            {fmtPrice(signal.stop)}
            {" · TP "}
            {fmtPrice(signal.tp)}
          </>
        )}
      </span>
    </li>
  );
}

/* ============= Scout Activity Feed ============= */

type FeedLine = { id: string | number; ts: string; text: string; tone: "info" | "warn" | "good" };

function ScoutActivityFeed({ live = false }: { live?: boolean }) {
  const eventsQ = useBotEvents(60);
  const lines: FeedLine[] = useMemo(
    () => (live ? [] : summariseEvents(eventsQ.data ?? []).slice(0, 20)),
    [eventsQ.data, live],
  );

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.015] p-3 ring-1 ring-white/10">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-white">
          Scout
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/30">
          last 20
        </p>
      </div>
      {lines.length === 0 ? (
        <p className="text-[11px] text-white/45">No verdicts yet.</p>
      ) : (
        <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {lines.map((l) => (
            <li key={l.id} className="flex gap-2 text-[10.5px] leading-snug">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  l.tone === "good"
                    ? "bg-[color:var(--positive)]"
                    : l.tone === "warn"
                      ? "bg-amber-400"
                      : "bg-white/40",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-white/75">{l.text}</p>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">
                  {new Date(l.ts).toLocaleTimeString()}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function summariseEvents(
  events: Array<{
    id: number;
    created_at: string;
    event: string;
    level: string;
    detail: Record<string, unknown> | null;
  }>,
): FeedLine[] {
  const out: FeedLine[] = [];
  for (const e of events) {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    if (e.event === "SCOUT_BOS_REJECTED") {
      const disp = fmtNum(d.displacement_atr);
      const min = fmtNum(d.min_atr);
      out.push({
        id: e.id,
        ts: e.created_at,
        tone: "warn",
        text: `HOLD ${d.symbol ?? ""} — bos_below_significance ${disp}×ATR < ${min}×ATR`,
      });
    } else if (e.event === "SCOUT_BOS_CLOSE" || e.event === "SCOUT_GUARDIAN_CLOSE") {
      out.push({
        id: e.id,
        ts: e.created_at,
        tone: "warn",
        text: `CUT ${d.symbol ?? ""} ${d.direction ?? ""} — ${d.reason ?? e.event.toLowerCase()}`,
      });
    } else if (e.event === "HTF_PROMOTION") {
      out.push({
        id: e.id,
        ts: e.created_at,
        tone: "good",
        text: `PROMOTE ${d.symbol ?? ""} ${d.direction ?? ""} → runner (1h BOS aligned)`,
      });
    } else if (e.event === "ENTRY_GATE_BLOCKED") {
      out.push({
        id: e.id,
        ts: e.created_at,
        tone: "info",
        text: `BLOCK ${d.symbol ?? ""} — ${d.reason ?? "gate"}`,
      });
    } else if (e.event === "PAPER_TICK_REASONS") {
      const onyx = (d.onyx as Record<string, unknown> | undefined) ?? {};
      const approved = fmtInt(onyx.approved);
      const rejected = fmtInt(onyx.rejected);
      const candidates = fmtInt(onyx.candidates);
      if (Number(approved) + Number(rejected) + Number(candidates) === 0) continue;
      out.push({
        id: e.id,
        ts: e.created_at,
        tone: Number(approved) > 0 ? "good" : "info",
        text: `TICK — ${candidates} cand · ${approved} approved · ${rejected} rejected`,
      });
    }
    if (out.length >= 40) break;
  }
  return out;
}

function fmtNum(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}
function fmtInt(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? String(Math.round(n)) : "0";
}
