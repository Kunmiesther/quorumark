import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { Activity, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSignalFeed,
  type DirectionEval,
  type EntrySummary,
  type SignalEvaluation,
} from "@/hooks/useSignalFeed";
import { statusLabel } from "@/lib/presentation-labels";
import onyxHead from "@/assets/onyx-head.png.asset.json";
import { OnyxDecisionsPanel } from "@/components/onyx/OnyxDecisionsPanel";
import { LiveDecisionFlowPanel } from "@/components/scout/LiveDecisionFlowPanel";

const OnyxSetupAssistant = lazy(() =>
  import("@/components/onyx/OnyxSetupAssistant").then((module) => ({
    default: module.OnyxSetupAssistant,
  })),
);

/** Onyx identity color — teal. Reserved for Onyx state readout + long side. */
const ONYX_TEAL = "#2DD4BF";




/* ============================================================
 * External store — module-level open state + subscribers.
 * Same pattern as CommandPalette.openCommandPalette().
 * ============================================================ */

let isOpen = false;
let lastTrigger: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function openOnyx() {
  if (typeof document !== "undefined") {
    const el = document.activeElement;
    if (el instanceof HTMLElement) lastTrigger = el;
  }
  // Mutually exclusive with Scout — only one side panel open at a time.
  // Dynamic import avoids a circular module dep between the two panels.
  import("@/components/scout/ScoutPanel").then((m) => m.closeScout()).catch(() => {});
  if (!isOpen) {
    isOpen = true;
    emit();
  }
}

export function closeOnyx() {
  if (isOpen) {
    isOpen = false;
    emit();
    // Return focus to whatever opened us.
    queueMicrotask(() => {
      lastTrigger?.focus?.();
      lastTrigger = null;
    });
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reactive hook — layouts (e.g. AppShell main) use this to reflow. */
export function useOnyxOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}

/* ============================================================
 * Panel
 * ============================================================ */

export function OnyxPanel() {
  const open = useOnyxOpen();
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeOnyx();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Move focus into the panel on open.
  useEffect(() => {
    if (open) {
      queueMicrotask(() => panelRef.current?.focus?.());
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop — mobile + tablet only. Desktop uses push-layout, no scrim. */}
      <div
        aria-hidden
        onClick={closeOnyx}
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm lg:hidden"
      />

      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Onyx"
        tabIndex={-1}
        className={cn(
          "fixed z-[70] text-white outline-none ring-1 ring-white/10",
          // MOBILE (<768) — bottom sheet
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-3xl",
          // TABLET (md 768-1023) — right side overlay, ~380px
          "md:inset-y-0 md:right-0 md:left-auto md:top-0 md:h-full md:max-h-none md:w-[380px] md:rounded-none md:rounded-l-3xl",
          // DESKTOP (lg 1024+) — right side push panel, 420px
          "lg:w-[420px] lg:rounded-none",
        )}
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%), rgba(11,11,13,0.72)",
          backdropFilter: "blur(24px) saturate(140%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.12), 0 24px 60px -30px rgba(0,0,0,0.8)",
        }}
      >
        <OnyxHeader />
        <div className="max-h-[calc(85dvh-64px)] overflow-y-auto md:max-h-[calc(100dvh-64px)]">
          <OnyxBody />
        </div>
      </aside>
    </>
  );
}

function OnyxHeader() {
  return (
    <header className="relative flex h-16 items-center gap-3 border-b border-white/[0.06] px-4">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.10]"
        style={{
          background:
            "radial-gradient(60% 100% at 100% 50%, #9945FF33 0%, transparent 70%)",
        }}
      />
      <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
        <img
          src={onyxHead.url}
          alt=""
          aria-hidden
          className="h-12 w-12 object-contain"
          style={{ mixBlendMode: "screen" }}
          draggable={false}
        />
      </div>

      <div className="relative min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-tight text-white">Onyx</p>
        <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">
          Decision layer
        </p>
      </div>
      <button
        type="button"
        onClick={closeOnyx}
        aria-label="Close Onyx"
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-white/60 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

/* ============================================================
 * Body — setup assistant first, detailed decision telemetry second.
 * ============================================================ */

function OnyxBody() {
  return (
    <div className="space-y-4 p-4">
      <Suspense
        fallback={
          <div className="tb-neu-inset grid min-h-52 place-items-center rounded-[26px] text-xs text-cyan-300/70">
            Onyx is reading your setup…
          </div>
        }
      >
        <OnyxSetupAssistant />
      </Suspense>

      {/* THE flow — MARKET -> DECISION -> SAFETY -> APEX — from the same
          `strategy_decisions` rows and the same decision_id Scout renders.
          Onyx and Scout must never be able to disagree about what the worker
          decided, which is why there is exactly one component for it.

          A second, hand-rolled six-stage "Pipeline" list used to live below
          here. It reported stage 6 from `paper_order_intents` — the PAPER
          engine's table — so a live order intent was never actually checked,
          and stages 4 and 5 were hardcoded to "waiting" regardless of what
          had been evaluated. It is deleted rather than repaired: two pipeline
          views over one pipeline is how they drift.

          NOTE ON THE MERGE: main independently patched that stage 6 to count
          paper AND live intents. That fix is superseded, not discarded — the
          Trust Center reads `order_intents` directly and shows the last
          intent, submission, fill and queue depth, and it does not carry the
          two stages that were hardcoded to "waiting" and evaluated nothing. */}
      <details className="tb-neu-panel rounded-[24px] p-3">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-2 py-2 text-sm font-semibold text-white/70">
          <span className="tb-neu-raised grid h-9 w-9 place-items-center rounded-full text-cyan-300">
            <Activity className="h-4 w-4" />
          </span>
          Live trading intelligence
          <span className="ml-auto text-[10px] font-normal uppercase tracking-[0.14em] text-white/30">
            Details
          </span>
        </summary>
        <div className="mt-4 space-y-4 border-t border-white/[0.05] pt-4">
          <LiveDecisionFlowPanel />
          <LiveSignalSection />
          <LivePositionSection />
          <OnyxDecisionsPanel />
        </div>
      </details>
    </div>
  );
}

/* ============================================================
 * Live signal section — reads bot_events SIGNAL_EVALUATION rows.
 * Observation only. Never rendered as executed trades.
 * ============================================================ */

const REASON_PHRASES: Record<string, string> = {
  UNSUPPORTED_MARKET_TYPE: "Waiting — strategy market type isn't perpetual.",
  NO_ACTIVE_STRATEGY: "Waiting — no active strategy for this account.",
  NO_CANDLES: "Waiting — no candles from the exchange yet.",
  INSUFFICIENT_CANDLES: "Warming up — not enough candles yet.",
  STALE_CANDLE: "Waiting — newest candle is stale.",
  MISSING_SYMBOL: "Waiting — strategy has no symbol configured.",
};

function reasonPhrase(code?: string): string | null {
  if (!code) return null;
  return REASON_PHRASES[code] ?? statusLabel(code);
}

function fmtPrice(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}


/* ------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------ */

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const EYEBROW =
  "font-mono text-[10px] uppercase tracking-[0.18em] text-white/40";
const FOOTER_TAG =
  "font-mono text-[10px] uppercase tracking-[0.22em] text-white/35";

/* ============================================================
 * Card 1 — Proposed entry (live observation)
 * ============================================================ */

function LiveSignalSection() {
  const { latest, isLoading, hasNoData, isStale } = useSignalFeed(20);

  return (
    <div>
      <p className={`${EYEBROW} mb-2 px-1`}>Proposed entry</p>
      {isLoading && !latest ? (
        <div className="rounded-2xl bg-white/[0.04] p-6 text-[12.5px] text-white/55">
          Loading latest observation…
        </div>
      ) : hasNoData || !latest ? (
        <div className="rounded-2xl bg-white/[0.04] p-6">
          <p className="text-[15px] font-semibold text-white/70">Observing</p>
          <p className="mt-1 text-xs text-white/40">No signal yet.</p>
          <p className={`${FOOTER_TAG} mt-4`}>Observation only — no orders placed</p>
        </div>
      ) : (
        <ProposedEntryCard evalRow={latest} isStale={isStale} />
      )}
    </div>
  );
}

function ProposedEntryCard({
  evalRow,
  isStale,
}: {
  evalRow: SignalEvaluation;
  isStale: boolean;
}) {
  const d = evalRow.detail;
  const status = d.status ?? "evaluated";
  const symbol = d.symbol ?? d.normalized_symbol ?? "—";
  const interval = d.interval_min ? `${d.interval_min}m` : null;

  const evaluatedMs = d.evaluated_at
    ? Date.parse(d.evaluated_at)
    : Date.parse(evalRow.created_at);
  const ageMs = Number.isFinite(evaluatedMs)
    ? Math.max(0, Date.now() - evaluatedMs)
    : null;
  const ageSecLive = ageMs != null ? Math.round(ageMs / 1000) : null;

  const long = d.directions?.long;
  const short = d.directions?.short;
  const longConfirmed = num(long?.retest_states?.confirmed);
  const shortConfirmed = num(short?.retest_states?.confirmed);
  const longPending = num(long?.retest_states?.pending);
  const shortPending = num(short?.retest_states?.pending);

  // Freshness pill
  let freshnessNode: React.ReactNode;
  if (ageSecLive == null) {
    freshnessNode = <span className="text-white/50">Observing…</span>;
  } else if (isStale) {
    freshnessNode = (
      <span style={{ color: "var(--negative)" }}>
        Stale · {Math.round(ageSecLive / 60)}m
      </span>
    );
  } else if (ageSecLive < 60) {
    freshnessNode = (
      <span style={{ color: ONYX_TEAL }} className="inline-flex items-center gap-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: ONYX_TEAL }} />
        Live · {ageSecLive}s
      </span>
    );
  } else {
    freshnessNode = (
      <span style={{ color: ONYX_TEAL }} className="inline-flex items-center gap-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: ONYX_TEAL }} />
        Live · {Math.round(ageSecLive / 60)}m
      </span>
    );
  }


  // Hero state
  let heroText = "Watching";
  let heroColor = "rgba(255,255,255,0.75)";
  if (status === "skipped") {
    heroText = reasonPhrase(d.reason_code) ?? "Waiting";
    heroColor = "rgba(255,255,255,0.6)";
  } else if (status === "error") {
    heroText = "Feed error";
    heroColor = "var(--negative)";
  } else if (longConfirmed + shortConfirmed > 0) {
    heroText = "Confirmed structure";
    heroColor = ONYX_TEAL;

  } else if (longPending + shortPending > 0) {
    heroText = "Pending retest";
    heroColor = "#FFB020";
  }

  return (
    <div className="rounded-2xl bg-white/[0.04] p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[15px] font-semibold text-white">{symbol}</span>
        {interval && (
          <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-white/60">
            {interval}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] tabular-nums">{freshnessNode}</span>
      </div>

      {/* Hero */}
      <p
        className="mt-5 text-4xl font-semibold leading-none tracking-tight lg:text-5xl"
        style={{ color: heroColor }}
      >
        {heroText}
      </p>
      {status === "error" && d.error_text && (
        <p className="mt-2 text-xs text-white/60">{d.error_text}</p>
      )}

      {status !== "skipped" && status !== "error" && (
        <>
          {/* Divider */}
          <div className="my-5 border-t border-white/5" />

          {/* Long / Short columns */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:divide-x lg:divide-white/5">
            <DirectionColumn side="LONG" dir={long} tone="positive" />
            <div className="lg:pl-5">
              <DirectionColumn side="SHORT" dir={short} tone="negative" />
            </div>
          </div>

          {/* Zones */}
          <ZoneList long={long} short={short} />
        </>
      )}

      {/* Footer tag */}
      <p className={`${FOOTER_TAG} mt-5`}>Observation only — no orders placed</p>
    </div>
  );
}

function DirectionColumn({
  side,
  dir,
  tone,
}: {
  side: "LONG" | "SHORT";
  dir?: DirectionEval;
  tone: "positive" | "negative";
}) {
  const confirmed = num(dir?.retest_states?.confirmed);
  const pending = num(dir?.retest_states?.pending);
  const breaks = num(dir?.breaks);
  const retests = num(dir?.retests);
  const entries = num(dir?.entries);
  const accent = tone === "positive" ? ONYX_TEAL : "var(--negative)";
  return (
    <div>
      <p className={EYEBROW}>{side}</p>
      <p
        className="mt-2 text-2xl font-semibold leading-none tabular-nums"
        style={{ color: confirmed > 0 ? accent : "rgba(255,255,255,0.55)" }}
      >
        {confirmed} <span className="text-sm font-medium text-white/50">confirmed</span>
      </p>

      <p className="mt-1.5 text-sm tabular-nums" style={{ color: pending > 0 ? "#FFB020" : "rgba(255,255,255,0.55)" }}>
        {pending} pending
      </p>
      <p className="mt-2 font-mono text-[11px] tabular-nums text-white/45">
        {breaks} breaks · {retests} retests · {entries} entries
      </p>
      {/* thin accent underline — the single accent per column */}
      <div className="mt-3 h-px w-8" style={{ background: accent, opacity: 0.5 }} />
    </div>
  );
}

function ZoneList({ long, short }: { long?: DirectionEval; short?: DirectionEval }) {
  const items: Array<{ side: "L" | "S"; e: EntrySummary; accent: string }> = [];
  for (const e of long?.entry_summaries ?? []) {
    items.push({ side: "L", e, accent: ONYX_TEAL });
    if (items.length >= 2) break;
  }
  if (items.length < 2) {
    for (const e of short?.entry_summaries ?? []) {
      items.push({ side: "S", e, accent: "var(--negative)" });
      if (items.length >= 2) break;
    }
  }
  const totalLong = long?.entry_summaries?.length ?? 0;
  const totalShort = short?.entry_summaries?.length ?? 0;
  const remaining = Math.max(0, totalLong + totalShort - items.length);
  const truncated = long?.entry_summaries_truncated || short?.entry_summaries_truncated;

  if (!items.length) return null;

  return (
    <div className="mt-5">
      <p className={EYEBROW}>Zones</p>
      <ul className="mt-2 space-y-1.5">
        {items.map(({ side, e, accent }, i) => {
          const confirmed = e.state === "confirmed";
          return (
            <li
              key={i}
              className="flex items-center gap-3 font-mono text-xs tracking-wider tabular-nums text-white/75"
            >
              <span className="w-3 text-white/45">{side}</span>
              <span>{fmtPrice(e.zone_level)}</span>
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={
                  confirmed
                    ? { background: accent }
                    : { background: "transparent", boxShadow: `inset 0 0 0 1px ${accent}` }
                }
              />
              <span className="text-white/40">{confirmed ? "confirmed" : "pending"}</span>
            </li>
          );
        })}
        {(remaining > 0 || truncated) && (
          <li className={`${EYEBROW} pl-6`}>+ {remaining || "more"}</li>
        )}
      </ul>
    </div>
  );
}

/* ============================================================
 * Card 2 — Live position
 * Empty state today. FILLED variant designed, wired later.
 * ============================================================ */

type PositionData = {
  instrument: string; // "BTC PERP"
  direction: "Long" | "Short";
  leverage: number;
  pnlPct: number;
  cost: number;
  margin: number;
  entryPrice: number;
  openedAt: string; // ISO
};

function LivePositionSection() {
  // Execution is disabled today — no real position source. Render empty.
  const position: PositionData | null = null;

  return (
    <div>
      <p className={`${EYEBROW} mb-2 px-1`}>Live position</p>
      {position ? <FilledPositionCard p={position} /> : <EmptyPositionCard />}
    </div>
  );
}

function EmptyPositionCard() {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-5 lg:p-6">
      <p className={EYEBROW}>Position</p>
      <p className="mt-4 text-3xl leading-none text-white/25">∞</p>
      <p className="mt-3 text-lg font-medium text-white/70">No open position</p>
      <p className="mt-1 text-xs text-white/40">Unlocks when execution is enabled.</p>
      <div className="mt-5 border-t border-white/5" />
      <p className={`${FOOTER_TAG} mt-3`}>Execution · disabled</p>
    </div>
  );
}

function FilledPositionCard({ p }: { p: PositionData }) {
  const up = p.pnlPct > 0;
  const flat = p.pnlPct === 0;
  const pnlColor = flat
    ? "rgba(255,255,255,0.7)"
    : up
      ? "var(--positive)"
      : "var(--negative)";
  const sign = up ? "+" : "";
  const opened = new Date(p.openedAt);
  const openedLabel = Number.isFinite(opened.getTime())
    ? `${opened.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })} UTC`
    : "—";

  return (
    <div className="rounded-2xl bg-white/[0.04] p-5 lg:p-6">
      <p className="text-sm font-semibold text-white/80">
        {p.instrument} · {p.direction} {p.leverage}x
      </p>

      <p
        className="mt-5 text-5xl font-semibold leading-none tracking-tight tabular-nums lg:text-6xl"
        style={{ color: pnlColor }}
      >
        {sign}
        {p.pnlPct.toFixed(2)}%
      </p>
      <p className={`${EYEBROW} mt-2`}>Return (PNL)</p>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className={EYEBROW}>Cost</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-white">
            ${p.cost.toFixed(2)}
          </p>
        </div>
        <div>
          <p className={EYEBROW}>Margin</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-white">
            ${p.margin.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-white/5" />
      <p className={`${FOOTER_TAG} mt-3 tabular-nums`}>
        Entry {fmtPrice(p.entryPrice)} · Opened {openedLabel}
      </p>
    </div>
  );
}




export function OnyxTriggerLabel() {
  const open = useOnyxOpen();
  return open ? "Close Onyx" : "Onyx";
}
