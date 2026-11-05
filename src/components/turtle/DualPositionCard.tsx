import { useEffect, useState } from "react";
import { ArrowUpRight, ArrowDownRight, Radio, Target, Shield, Layers } from "lucide-react";

/**
 * Dual-sided live position dashboard.
 * Always renders BOTH a Long slot and a Short slot for a given asset.
 * - Active side  -> live metric dashboard (entry, mark, pnl, SL/TP, rungs).
 * - Empty side   -> "listening" placeholder.
 * All numeric fields use tabular-nums to prevent layout jitter as prices tick.
 */

export type Rung = {
  id: number;
  target: number;
  hit: boolean;
};

export type SidePosition = {
  active: boolean;
  leverage?: string;         // "10x", "100x Cross"
  marginMode?: "cross" | "isolated";
  strategy?: string;         // "Sniper", "Hunter", "Accumulator DCA"
  entryPrice?: number;
  currentPrice?: number | null;
  pnlUsd?: number | null;
  pnlPercent?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  rungs?: Rung[];
  openedAt?: string;         // ISO
};

export type DualPositionData = {
  symbol: string;                // "SOL-USDT"
  longPosition: SidePosition;
  shortPosition: SidePosition;
};

// ---------- formatting -------------------------------------------------------

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  const digits = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function distancePct(from: number, to: number): number {
  if (!isFinite(from) || !isFinite(to) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

// ---------- container --------------------------------------------------------

export function DualPositionCard({
  data,
  className,
  book = "paper",
}: {
  data: DualPositionData;
  className?: string;
  book?: "paper" | "live";
}) {
  const longActive = data.longPosition.active;
  const shortActive = data.shortPosition.active;
  const anyActive = longActive || shortActive;

  // Compact single line when fully flat — replaces the two ~300px empty
  // panels with one row so the desk isn't dominated by "nothing happening".
  if (!anyActive) {
    return (
      <section
        data-testid="dual-position-flat"
        className={
          className ??
          "flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[13px] font-semibold tracking-tight text-white">
            {data.symbol}
          </span>
          <span className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/55">
            Flat
          </span>
          <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/45">
            watching for entry
          </span>
        </div>
        <LivePulse book={book} />
      </section>
    );
  }

  return (
    <section
      data-testid="dual-position-active"
      className={
        className ??
        "rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 sm:p-4"
      }
    >
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[15px] font-semibold tracking-tight text-white">
            {data.symbol}
          </span>
        </div>
        <LivePulse book={book} />
      </header>

      <div
        className={
          longActive && shortActive
            ? "grid flex-1 grid-cols-1 items-stretch gap-3 sm:grid-cols-2"
            : "flex flex-1"
        }
      >
        {longActive && (
          <SideSlot side="long" position={data.longPosition} symbol={data.symbol} />
        )}
        {shortActive && (
          <SideSlot side="short" position={data.shortPosition} symbol={data.symbol} />
        )}
      </div>
    </section>
  );
}


// ---------- side slot --------------------------------------------------------

function SideSlot({
  side,
  position,
}: {
  side: "long" | "short";
  position: SidePosition;
  symbol: string;
}) {
  const isLong = side === "long";
  const themed = isLong
    ? {
        border: "border-emerald-500/30",
        borderActive: "border-emerald-500/60",
        bg: "bg-emerald-500/[0.04]",
        text: "text-emerald-400",
        chipBg: "bg-emerald-500/15",
        glow: "shadow-[0_0_32px_-12px_rgba(16,185,129,0.55)]",
        icon: ArrowUpRight,
        label: "LONG" as const,
      }
    : {
        border: "border-rose-500/30",
        borderActive: "border-rose-500/60",
        bg: "bg-rose-500/[0.04]",
        text: "text-rose-400",
        chipBg: "bg-rose-500/15",
        glow: "shadow-[0_0_32px_-12px_rgba(244,63,94,0.55)]",
        icon: ArrowDownRight,
        label: "SHORT" as const,
      };
  return <ActiveSlot theme={themed} side={side} position={position} />;
}


// ---------- active state -----------------------------------------------------

function ActiveSlot({
  theme,
  side,
  position,
}: {
  theme: ReturnType<typeof pickTheme>;
  side: "long" | "short";
  position: SidePosition;
}) {
  const Icon = theme.icon;
  const isLong = side === "long";
  const pnlUsd = position.pnlUsd ?? null;
  const pnlPct = position.pnlPercent ?? null;
  const positive = pnlUsd != null ? pnlUsd >= 0 : pnlPct != null ? pnlPct >= 0 : null;
  const pnlColor =
    positive == null
      ? "text-white/80"
      : positive
        ? "text-emerald-400"
        : "text-rose-400";

  const slDist =
    position.entryPrice != null && position.stopLoss != null
      ? distancePct(position.entryPrice, position.stopLoss)
      : null;
  const tpDist =
    position.entryPrice != null && position.takeProfit != null
      ? distancePct(position.entryPrice, position.takeProfit)
      : null;

  return (
    <div
      className={`relative flex h-full flex-col rounded-xl border ${theme.borderActive} ${theme.bg} p-3.5 transition ${theme.glow}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={`flex h-8 w-8 items-center justify-center rounded-full ${theme.chipBg} ${theme.text}`}>
            <Icon className="h-4 w-4" strokeWidth={2.4} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className={`font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] ${theme.text}`}>
                {theme.label}
              </span>
              {position.leverage && (
                <span className="flex items-center gap-0.5 rounded-md bg-amber-400/15 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-amber-300">
                  <Layers className="h-2.5 w-2.5" />
                  {position.leverage}
                  {position.marginMode ? ` ${position.marginMode}` : ""}
                </span>
              )}
            </div>
            {position.strategy && (
              <p className="mt-0.5 text-[10.5px] text-white/55">
                Strategy · <span className="text-white/80">{position.strategy}</span>
              </p>
            )}
          </div>
        </div>
        <LiveDot color={isLong ? "bg-emerald-400" : "bg-rose-400"} />
      </div>

      {/* PnL hero */}
      <div className="mt-3 border-y border-white/5 py-3">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-white/40">
          Unrealized P&amp;L
        </p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className={`font-mono text-[26px] font-semibold leading-none tabular-nums ${pnlColor}`}>
            {fmtUsd(pnlUsd)}
          </span>
          <span className={`font-mono text-[12.5px] font-semibold tabular-nums ${pnlColor}`}>
            {fmtPct(pnlPct)}
          </span>
        </div>
      </div>

      {/* Price grid */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Entry" value={fmtPrice(position.entryPrice)} />
        <Metric
          label="Mark"
          value={fmtPrice(position.currentPrice)}
          valueClass={pnlColor}
        />
      </div>

      {/* SL / TP */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <RiskCell
          icon={<Shield className="h-3 w-3" />}
          label="Stop"
          price={position.stopLoss}
          dist={slDist}
          tone="rose"
        />
        <RiskCell
          icon={<Target className="h-3 w-3" />}
          label="Target"
          price={position.takeProfit}
          dist={tpDist}
          tone="emerald"
        />
      </div>

      {/* Rungs ladder */}
      {position.rungs && position.rungs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/45">
              Ladder Rungs
            </span>
            <span className="font-mono text-[10px] tabular-nums text-white/60">
              {position.rungs.filter((r) => r.hit).length}/{position.rungs.length} hit
            </span>
          </div>
          <RungBar rungs={position.rungs} theme={theme} />
        </div>
      )}
    </div>
  );
}

// ---------- pieces -----------------------------------------------------------

function Metric({
  label,
  value,
  valueClass = "text-white/90",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 px-2.5 py-1.5">
      <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/40">
        {label}
      </p>
      <p className={`mt-0.5 font-mono text-[13.5px] font-semibold tabular-nums ${valueClass}`}>
        {value}
      </p>
    </div>
  );
}

function RiskCell({
  icon,
  label,
  price,
  dist,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  price: number | null | undefined;
  dist: number | null;
  tone: "rose" | "emerald";
}) {
  const toneText = tone === "rose" ? "text-rose-400" : "text-emerald-400";
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 px-2.5 py-1.5">
      <p className={`flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.16em] ${toneText}`}>
        {icon} {label}
      </p>
      <p className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-white/90">
        {fmtPrice(price)}
      </p>
      {dist != null && price != null && (
        <p className="mt-0.5 font-mono text-[9.5px] tabular-nums text-white/45">
          {dist >= 0 ? "+" : ""}
          {dist.toFixed(2)}%
        </p>
      )}
    </div>
  );
}

function RungBar({
  rungs,
  theme,
}: {
  rungs: Rung[];
  theme: ReturnType<typeof pickTheme>;
}) {
  const sorted = [...rungs].sort((a, b) => a.id - b.id);
  const showLabels = sorted.length <= 5;
  const fmtCompact = (n: number) => {
    if (!isFinite(n)) return "—";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
  };
  return (
    <div className="flex items-start gap-1">
      {sorted.map((r) => (
        <div key={r.id} className="flex min-w-0 flex-1 flex-col items-stretch">
          <div
            className={`h-1.5 rounded-full transition-all ${
              r.hit
                ? `${theme.text.replace("text-", "bg-")} shadow-[0_0_8px_-1px_currentColor] ${theme.text}`
                : "bg-white/10"
            }`}
          />
          {showLabels && (
            <p className="mt-1 truncate text-center font-mono text-[8.5px] tabular-nums text-white/50">
              {fmtCompact(r.target)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}


function LivePulse({ book }: { book: "paper" | "live" }) {
  const isLive = book === "live";
  return (
    <div className="flex items-center gap-1.5">
      <Radio className={`h-3 w-3 ${isLive ? "text-emerald-400" : "text-amber-300"}`} />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/50">
        {isLive ? "Live" : "Paper"}
      </span>
    </div>
  );
}

function LiveDot({ color }: { color: string }) {
  const [beat, setBeat] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => !b), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="relative flex h-2 w-2">
      <span
        className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-40 ${beat ? "animate-ping" : ""}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

// Helper used only to type the `theme` shape.
function pickTheme(_side: "long" | "short") {
  return {
    border: "",
    borderActive: "",
    bg: "",
    text: "",
    chipBg: "",
    glow: "",
    icon: ArrowUpRight,
    label: "" as "LONG" | "SHORT",
  };
}
