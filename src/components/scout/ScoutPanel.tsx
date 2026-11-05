/**
 * ScoutPanel — global slide-in Scout, mirroring OnyxPanel.
 *
 * Two roles surfaced together:
 *   - OFFENSE: multi-timeframe recon (ScoutHeader + per-symbol MTF cards).
 *   - DEFENSE: live watch tasks on every OPEN paper position, with the
 *     protective structural swing level and BOS status (Watching /
 *     Structure intact / BROKEN), sourced from ONYX_HANDOFF and SCOUT_BOS
 *     bot_events + paper_positions.
 *
 * Module-level `openScout()` / `useScoutOpen()` store follows the exact
 * pattern used by OnyxPanel so any surface (TopBar, CommandPalette, FAB)
 * can open the sheet without prop drilling.
 *
 * UI ONLY — no engine / strategy / DCA / exit logic is touched here.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Radar, X, Shield, Compass, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import scoutAsset from "@/assets/characters/scout.webp.asset.json";
import { ScoutHeader } from "./ScoutHeader";
import { ScoutSymbolCard } from "./ScoutSymbolCard";
import { ScoutDefensePanel } from "./ScoutDefensePanel";
import { useScoutIntelligence } from "@/hooks/useScoutIntelligence";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { closeOnyx } from "@/components/onyx/OnyxPanel";

/** Scout identity color — cyan (matches ScoutHeader accent). */
const SCOUT_CYAN = "#22D3EE";

/* ============================================================
 * External store — module-level open state + subscribers.
 * Mirrors openOnyx()/useOnyxOpen() from OnyxPanel.
 * ============================================================ */

let isOpen = false;
let lastTrigger: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function openScout() {
  if (typeof document !== "undefined") {
    const el = document.activeElement;
    if (el instanceof HTMLElement) lastTrigger = el;
  }
  // Mutually exclusive with Onyx — only one side panel open at a time.
  closeOnyx();
  if (!isOpen) {
    isOpen = true;
    emit();
  }
}

export function closeScout() {
  if (isOpen) {
    isOpen = false;
    emit();
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

/** Reactive hook — layouts use this to reflow when the panel opens. */
export function useScoutOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}

/* ============================================================
 * Panel
 * ============================================================ */

type Tab = "offense" | "defense";

export function ScoutPanel() {
  const open = useScoutOpen();
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("offense");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeScout();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => panelRef.current?.focus?.());
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop — mobile + tablet only. Desktop uses push-layout. */}
      <div
        aria-hidden
        onClick={closeScout}
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm lg:hidden"
      />

      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Scout"
        tabIndex={-1}
        className={cn(
          "fixed z-[70] text-white outline-none ring-1 ring-white/10",
          // MOBILE (<768) — bottom sheet
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-3xl",
          // TABLET (md 768-1023) — LEFT side overlay (opposite of Onyx which is right)
          "md:inset-y-0 md:left-0 md:right-auto md:top-0 md:h-full md:max-h-none md:w-[380px] md:rounded-none md:rounded-r-3xl",
          // DESKTOP (lg 1024+) — LEFT side push panel, 420px
          "lg:w-[420px] lg:rounded-none",
        )}
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%), rgba(11,11,13,0.72)",
          backdropFilter: "blur(24px) saturate(140%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 24px 60px -30px rgba(0,0,0,0.8)",
        }}
      >
        <ScoutSheetHeader tab={tab} onTab={setTab} />
        <div className="max-h-[calc(85dvh-112px)] overflow-y-auto md:max-h-[calc(100dvh-112px)]">
          {tab === "offense" ? <OffenseSection /> : <DefenseSection />}
        </div>
      </aside>
    </>
  );
}

function ScoutSheetHeader({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <header className="relative border-b border-white/[0.06]">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.10]"
        style={{
          background: `radial-gradient(60% 100% at 0% 50%, ${SCOUT_CYAN}33 0%, transparent 70%)`,
        }}
      />
      <div className="relative flex h-16 items-center gap-3 px-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-white/10">
          <img
            src={scoutAsset.url}
            alt=""
            aria-hidden
            className="h-full w-full object-cover"
            draggable={false}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-tight text-white">Scout</p>
          <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">
            Recon &amp; Defense
          </p>
        </div>
        <button
          type="button"
          onClick={closeScout}
          aria-label="Close Scout"
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/60 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2"
          style={{ boxShadow: "inset 0 0 0 0 transparent" }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative flex gap-1 px-3 pb-2">
        <TabButton
          active={tab === "offense"}
          onClick={() => onTab("offense")}
          icon={<Compass className="h-3.5 w-3.5" />}
          label="Offense"
          hint="Recon"
        />
        <TabButton
          active={tab === "defense"}
          onClick={() => onTab("defense")}
          icon={<Shield className="h-3.5 w-3.5" />}
          label="Defense"
          hint="Guarding"
        />
      </div>
    </header>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition",
        active
          ? "bg-white/[0.08] text-white ring-1 ring-white/10"
          : "text-white/55 hover:bg-white/[0.04] hover:text-white",
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">
        · {hint}
      </span>
    </button>
  );
}

/* ============================================================
 * Offense — ranked MTF board (reuses /scout building blocks).
 * ============================================================ */

function OffenseSection() {
  const { active } = useScoutActivation();
  const query = useScoutIntelligence();
  const { data, isFetching, isError, error, refetch } = query;

  return (
    <div className="space-y-3 p-3">
      <a
        href="/scout#blockchain-discovery"
        onClick={closeScout}
        className="tb-neu-raised block rounded-xl px-3 py-3 text-sm text-cyan-200"
      >
        Blockchain discovery · Base, BNB &amp; Solana →
      </a>
      <ScoutHeader data={data} isScanning={isFetching} onRefresh={() => refetch()} />

      {!active ? (
        <div className="rounded-xl bg-white/[0.03] p-4 text-[12px] text-white/55">
          <div className="flex items-start gap-2">
            <Radar className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
            <p>
              Scout is dormant. Turn it on above to begin scanning. Historical intelligence stays
              accessible even when off.
            </p>
          </div>
        </div>
      ) : isError ? (
        <div className="rounded-xl bg-[hsl(var(--state-danger)/0.08)] p-4 text-[12px] text-[hsl(var(--state-danger))]">
          Scan failed — {error instanceof Error ? error.message : "unknown error"}
        </div>
      ) : !data || data.symbols.length === 0 ? (
        <div className="rounded-xl bg-white/[0.03] p-6 text-center text-[12px] text-white/50">
          {isFetching ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Pulling multi-timeframe candles…
            </span>
          ) : (
            "No symbols in scan universe."
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/45">
            Symbol intelligence · {data.symbols.length}
          </p>
          <div className="grid gap-2">
            {data.symbols.map((s) => (
              <ScoutSymbolCard key={s.symbol} report={s} />
            ))}
          </div>
        </div>
      )}

      <p className="pt-1 text-center text-[10px] uppercase tracking-wider text-white/30">
        Monitoring only · Read-only intelligence
      </p>
    </div>
  );
}

/* ============================================================
 * Defense — reuse the existing defense panel verbatim.
 * ============================================================ */

function DefenseSection() {
  return (
    <div className="space-y-3 p-3">
      <ScoutDefensePanel />
      <p className="pt-1 text-center text-[10px] uppercase tracking-wider text-white/30">
        Confirmed 5m close beyond swing → BOS → Onyx exits (scout_bos)
      </p>
    </div>
  );
}
