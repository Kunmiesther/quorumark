/**
 * TradeDesk — Owner reference match (Onixus palette).
 *
 * SHARED implementation for both paper and live books. Only the mode pill
 * and data source differ. No engine/strategy/flag changes; execution guards
 * untouched. Manual execution retains the reviewed preview and confirmation path.
 *
 * Palette:
 *   --onixus-purple #9945FF  (brand)
 *   --onixus-teal   #14F195  (long / positive)
 *   --onixus-hot-blue #4EA8FF (accents, gridlines)
 *   --onixus-red    #E4677A  (short / negative — faint)
 *   Canvas         #05070D  (dark navy-black)
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { compactSymbol, fetchPaperQuote, paperValuation } from "@/lib/paper/deskMarks";
import { submitPaperDeskOrder } from "@/lib/paper/manualDesk.functions";
import { paperDeskTicket } from "@/lib/paper/manualDesk";
import { exchangeWalletIdentitiesQuery } from "@/hooks/exchangeWalletIdentities";
import { connectedWallets } from "@/lib/wallet/accountIdentity";
import { useServerFn } from "@tanstack/react-start";
import { LIVE_TEST_MODE } from "@/lib/app-env";
import { submitManualLiveTestOrder } from "@/lib/live/manualLiveTest.functions";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { getLifeMapSnapshot } from "@/lib/bills/bills.functions";
import { MAX_SELECTABLE_LEVERAGE, MIN_SELECTABLE_LEVERAGE } from "@/lib/strategy-config";

import { Bell, Eye, EyeOff, CircleDot, ExternalLink } from "lucide-react";

// Candlestick / volume series intentionally removed — desk chart is line-only.
import { useCandles, type Candle, type Interval } from "@/hooks/useCandles";
import { useApexTicker } from "@/hooks/useApexTicker";
import { useApexPublicStream, type StreamStatus } from "@/hooks/useApexPublicStream";
import { useApexMarkets, apexMarketsWithFallback } from "@/hooks/useApexMarkets";
import { usePortfolioTotals } from "@/hooks/usePortfolioTotals";
import { useExecutionStatus } from "@/hooks/useExecutionStatus";
import { useBotHealth } from "@/hooks/useBotHealth";
import { readHealthString } from "@/lib/health/workerHealth";
import { useSignalFeed, type EntrySummary } from "@/hooks/useSignalFeed";
import { cn } from "@/lib/utils";
import { formatPrice, formatSize } from "@/lib/formatPrice";
import { readPositionProtection, type PositionProtection } from "@/lib/live/positionProtection";
import { PositionProtectionReadout } from "./PositionProtectionReadout";
import { RefreshPositionsButton } from "./RefreshPositionsButton";
import { BotLineChart } from "@/components/trade/BotLineChart";
import { useTradeDeskSymbol } from "@/hooks/useTradeDeskSymbol";
import { ChartSymbolSelector } from "./ChartSymbolSelector";

import { ManualTradeTicket } from "@/components/trade/ManualTradeTicket";
import { useTradeBalance } from "@/hooks/useTradeBalance";
import { accountAssetTotals } from "@/lib/trade/accountAssets";
import { PaperWalletsCard } from "./PaperWalletsCard";
import { venueKind, SUPPORTED_VENUES } from "@/lib/supported-exchanges";
import { venueLogo } from "@/lib/venue-logos";
import { PairBadge } from "@/components/trade/PairBadge";
import { venueLabel } from "@/lib/venue-logos";
import {
  ExchangeIdentity,
  WalletIdentity,
  type WalletIdentityRecord,
} from "@/components/exchanges/ConnectionIdentity";
import { DeployFormationModal } from "@/components/trade/DeployFormationModal";
import { planManualLadder } from "@/lib/manualLadderPlan";
import { DCA_RUNGS } from "@/lib/paper/ladder";
import { DEFAULT_PAPER_SYMBOLS } from "@/lib/paper/constants";
import { WALLET_CAMPAIGN_RUNG_COUNT } from "@/lib/paper/walletCampaignSizing";
import { CoinBadge } from "@/components/trade/CoinBadge";
import { PanelErrorBoundary } from "@/components/trade/PanelErrorBoundary";
import { ActivityDrawer } from "@/components/trade/ActivityDrawer";
import { TradeIntelligencePanel } from "@/components/trade/TradeIntelligencePanel";

import { useShortlistCycle } from "@/hooks/useShortlistCycle";

const DecisionProofPanel = lazy(() =>
  import("@/components/trade/DecisionProofPanel").then((module) => ({
    default: module.DecisionProofPanel,
  })),
);
const RungActivityPanel = lazy(() =>
  import("@/components/trade/RungActivityPanel").then((module) => ({
    default: module.RungActivityPanel,
  })),
);
const SystemLogPanel = lazy(() =>
  import("@/components/trade/SystemLogPanel").then((module) => ({
    default: module.SystemLogPanel,
  })),
);
const TpCouncilPanel = lazy(() =>
  import("@/components/trade/TpCouncilPanel").then((module) => ({
    default: module.TpCouncilPanel,
  })),
);
const TradeHistoryCard = lazy(() =>
  import("@/components/trade/TradeHistoryCard").then((module) => ({
    default: module.TradeHistoryCard,
  })),
);
const OrderIntentPanel = lazy(() =>
  import("@/components/trade/OrderIntentPanel").then((module) => ({
    default: module.OrderIntentPanel,
  })),
);

function DeferredTradePanel({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="py-4 text-center text-xs text-white/40">Loading panel…</p>}>
      {children}
    </Suspense>
  );
}

// ---------- internal-identifier → human-readable label lookup ----------
//
// Any string that leaves the engine (evaluator payloads, reason codes, rule
// ids, exit tags) MUST pass through here before it lands in UI copy.
// Missing entries fall back to a Title-cased de-snake of the raw token so
// we never surface `S26_break_candle_atr` verbatim again.
const IDENTIFIER_LABELS: Record<string, string> = {
  // zone_assumption tags emitted by src/lib/paper/signal.ts
  s26_break_candle_atr: "Break candle ATR retest",
  break_candle_atr: "Break candle ATR retest",
  // retest states
  confirmed: "confirmed",
  pending: "pending",
  expired_window: "expired (window)",
  expired_breach: "expired (breach)",
};
function humanizeIdentifier(raw: string | null | undefined): string {
  if (!raw) return "";
  const key = String(raw).trim().toLowerCase();
  if (IDENTIFIER_LABELS[key]) return IDENTIFIER_LABELS[key];
  // Fallback: strip common id prefixes (S12_, R3_, RULE_), de-snake, Title Case.
  const stripped = key.replace(/^(s|r|rule|code)_?\d*_?/i, "");
  return stripped
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type Side = "long" | "short";

interface TradeDeskProps {
  book: "paper" | "live";
  onChangeBook?: (b: "paper" | "live") => void;
  /** Central URL-addressable candidate selection. Authoritative when present. */
  candidateId?: string | null;
  /** Optional URL-selected market, used when entering from Home positions. */
  initialSymbol?: string | null;
}

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const EMPTY_CANDLES: Candle[] = [];
const CHART_WINDOW_MINUTES: Record<Interval, number> = {
  "1m": 90,
  "5m": 480,
  "15m": 1_440,
  "1h": 5_760,
  "4h": 23_040,
  "1d": 172_800,
};
// (Old RUNG_LABELS / RUNG_DEFAULTS removed — see RungActivityPanel.)

// ---------- formatters ----------
function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}
function fmtUsd(n: number | null | undefined, digits = 2): string {
  const s = fmt(n, digits);
  return s === "—" ? s : `$${s}`;
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`;
}

// ---------- top strip (mainnet pill, exchange chip, wallet, bell) ----------
function TopStrip({
  book,
  onChangeBook,
  balanceHidden,
  onToggleBalance,
  openPositions,
  scoutLabel,
  scoutActive,
}: {
  book: "paper" | "live";
  onChangeBook?: (b: "paper" | "live") => void;
  balanceHidden: boolean;
  onToggleBalance: () => void;
  openPositions: number | null;
  scoutLabel: string;
  scoutActive: boolean;
}) {
  const exec = useExecutionStatus();
  const portfolio = usePortfolioTotals();
  const modeBalance = useTradeBalance(book);

  // Real derived state → chip tone.
  //   mainnet_active            → teal   (armed / live-routing ready)
  //   needs_attention / setup   → red    (error / halted-equivalent: no verified conn or broken creds)
  //   any other not-live status → amber  (not armed: locked, routing off, paper)
  //   book=paper                → purple (sandbox — informational, not a live-state signal)
  const liveArmed = book === "live" && exec.automationTradingReady;
  const liveReady = book === "live" && exec.manualTradingReady;
  const liveError =
    book === "live" && (exec.status === "needs_attention" || exec.status === "setup");
  const modeTone: ChipTone =
    book !== "live" ? "purple" : liveArmed || liveReady ? "teal" : liveError ? "red" : "amber";
  const modeLabel =
    book !== "live"
      ? "PAPER • SANDBOX"
      : liveArmed
        ? "MAINNET • AUTOMATION READY"
        : liveReady
          ? "MAINNET • MANUAL READY"
          : `MAINNET • ${exec.label.toUpperCase()}`;

  // ApeX chip reflects real connection state derived from exchange_connections
  // via useExecutionStatus. `setup` means no verified connection at all.
  const apexConnected = exec.connectedVenues.includes("apex_omni");
  const apexTone: ChipTone = apexConnected ? (liveError ? "red" : "teal") : "amber";
  const apexLabel = apexConnected ? "CONNECTED" : "DISCONNECTED";

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-xl bg-[color:var(--surface-1)] px-2.5 py-1.5"
      data-testid="desk-status-strip"
    >
      <ModePill label={modeLabel} tone={modeTone} />
      <Chip
        icon={<CircleDot className="h-3 w-3" style={{ color: chipColor(apexTone) }} />}
        label="ApeX Omni"
        sub={book === "paper" ? "PUBLIC DATA" : apexLabel}
        subTone={book === "paper" ? "purple" : apexTone}
      />
      <MicroStat label="Positions" value={openPositions == null ? "—" : String(openPositions)} />
      <MicroStat
        label="Scout"
        value={scoutLabel}
        tone={scoutActive ? "teal" : undefined}
        pulse={scoutActive}
      />
      <MicroStat
        label="Execution"
        value={
          book === "paper"
            ? "SIMULATED"
            : exec.automationTradingReady
              ? "AUTOMATION READY"
              : exec.manualTradingReady
                ? "MANUAL READY"
                : exec.label.toUpperCase()
        }
        tone={
          book === "paper"
            ? "purple"
            : liveError || exec.isError
              ? "red"
              : exec.manualTradingReady
                ? "teal"
                : "amber"
        }
      />
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onToggleBalance}
          className="group flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-[color:var(--surface-2)] px-2.5 py-1 text-[10.5px] font-medium text-white/80 hover:border-[color:var(--onixus-purple)]/40"
        >
          <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">Portfolio</span>
          <span className="font-mono tabular-nums text-white">
            {balanceHidden
              ? "••••••"
              : fmtUsd(book === "paper" ? modeBalance.equity : portfolio.totalUsd)}
          </span>
          {balanceHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
        <button
          className="relative rounded-full border border-white/[0.06] bg-[color:var(--surface-2)] p-1.5 text-white/70 hover:text-white"
          aria-label="Notifications"
        >
          <Bell className="h-3.5 w-3.5" />
          {/* Unread count not wired — no notifications hook yet */}
        </button>
        {onChangeBook ? (
          <div className="flex items-center overflow-hidden rounded-full border border-white/[0.06] bg-[color:var(--surface-2)] text-[10px] font-semibold uppercase tracking-[0.12em]">
            {(["live", "paper"] as const).map((b) => (
              <button
                key={b}
                onClick={() => onChangeBook(b)}
                className={cn(
                  "px-2.5 py-1",
                  book === b
                    ? "bg-[color:var(--onixus-purple)] text-white"
                    : "text-white/55 hover:text-white",
                )}
              >
                {b}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Compact label/value pill for the one-row status strip. */
function MicroStat({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone?: ChipTone;
  pulse?: boolean;
}) {
  const color = tone ? chipColor(tone) : undefined;
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-[color:var(--surface-2)] px-2.5 py-1 text-[10.5px]">
      {pulse ? (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: color ?? "var(--onixus-teal)" }}
        />
      ) : null}
      <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <span className="font-mono tabular-nums" style={{ color: color ?? "white" }}>
        {value}
      </span>
    </div>
  );
}

type ChipTone = "teal" | "amber" | "purple" | "red";

function chipColor(tone: ChipTone): string {
  switch (tone) {
    case "teal":
      return "var(--onixus-teal)";
    case "amber":
      return "var(--warning)";
    case "red":
      return "var(--onixus-red)";
    case "purple":
      return "var(--onixus-purple)";
  }
}

function ModePill({ label, tone }: { label: string; tone: ChipTone }) {
  const color = chipColor(tone);
  return (
    <div
      className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em]"
      style={{ borderColor: `${color}55`, background: `${color}14`, color }}
    >
      <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: color }} />
      {label}
    </div>
  );
}

function Chip({
  icon,
  label,
  sub,
  subTone,
}: {
  icon?: ReactNode;
  label: string;
  sub?: string;
  subTone?: ChipTone;
}) {
  const subColor = subTone ? chipColor(subTone) : undefined;
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[color:var(--surface-2)] px-3 py-1.5 text-[11px] text-white/75">
      {icon}
      <span className="font-semibold text-white">{label}</span>
      {sub ? (
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={subColor ? { color: subColor } : undefined}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}

function DesktopMarketChart({
  symbol,
  symbols,
  onSymbol,
  venue,
  interval,
  onInterval,
  candles,
  loading,
  error,
  fallbackPrice,
}: {
  symbol: string;
  symbols: string[];
  onSymbol: (symbol: string) => void;
  venue: string;
  interval: Interval;
  onInterval: (interval: Interval) => void;
  candles: Candle[];
  loading: boolean;
  error: boolean;
  fallbackPrice: number | null;
}) {
  const first = candles.at(0)?.close ?? null;
  const latest = candles.at(-1)?.close ?? fallbackPrice;
  const change =
    first != null && latest != null && first !== 0 ? ((latest - first) / first) * 100 : null;
  const positive = (change ?? 0) >= 0;

  return (
    <section
      className="trade-chart-shell min-w-0 overflow-hidden rounded-[22px]"
      aria-label={`${symbol} market chart`}
      data-testid="desktop-market-chart"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-1 pt-3 lg:px-5 lg:pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <PairBadge symbol={symbol} showLabel={false} size={28} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="sr-only">{symbol.replace("-", " / ")} chart</h2>
              <ChartSymbolSelector symbol={symbol} symbols={symbols} onSymbol={onSymbol} />
              <span className="truncate text-[10px] uppercase tracking-[0.14em] text-white/35">
                {venue}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-[15px] font-semibold tabular-nums text-white">
                {latest == null ? "—" : `$${formatPrice(latest)}`}
              </span>
              <span
                className={cn(
                  "text-[11px] font-semibold tabular-nums",
                  positive ? "text-emerald-300" : "text-rose-300",
                )}
              >
                {change == null ? "Syncing market" : `${positive ? "+" : ""}${change.toFixed(2)}%`}
              </span>
            </div>
          </div>
        </div>
        <div
          className="tb-neu-inset flex max-w-full items-center gap-1 overflow-x-auto rounded-xl p-1"
          role="group"
          aria-label="Chart interval"
        >
          {INTERVALS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={interval === item}
              onClick={() => onInterval(item)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-[10.5px] font-semibold transition",
                interval === item
                  ? "tb-neu-raised text-violet-200"
                  : "text-white/40 hover:text-white/75",
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </header>
      <div className="h-[250px] px-2 pb-2">
        {error ? (
          <div className="grid h-full place-items-center text-sm text-white/45">
            Market chart is reconnecting.
          </div>
        ) : loading && candles.length === 0 ? (
          <div className="m-4 h-[210px] animate-pulse rounded-2xl bg-white/[0.035]" />
        ) : (
          <BotLineChart
            key={symbol}
            candles={candles}
            height={250}
            regime={positive ? "bullish" : "bearish"}
            windowMinutes={CHART_WINDOW_MINUTES[interval]}
          />
        )}
      </div>
    </section>
  );
}

// Rung/entry/TP/SL overlays now render as Recharts ReferenceLine guides
// INSIDE BotLineChart (see BotLineChart.tsx). Recharts clips them to the plot
// rect and maps to the real animated Y-domain, so overlays cannot escape the
// chart or wash the panel with a purple tint.

// Drawing rail, chart footer, and formation buttons removed by owner directive.
// The chart ends cleanly, then the order panel + bottom row follow.

// DCA Rung Allocation editor removed by owner directive — replaced with the
// read-only <RungActivityPanel /> imported from ./RungActivityPanel. The
// manual Deploy Formation button never consumed the allocation splits (it's
// UI-stubbed), so no execution path depended on them.

// Ruling #8 ADD1 — venue base-asset step defaults. Kept co-located with the
// tickSize default until useApexMarkets exposes contract precision.
function defaultStepForSymbol(sym: string): number {
  const base = sym.split("-")[0]?.toUpperCase() ?? "";
  if (base === "BTC") return 0.001;
  if (base === "ETH") return 0.01;
  if (base === "SOL") return 0.1;
  return 0.001;
}

// Client-selectable leverage: every integer from 1x to 100x.
//
// SUPERSEDES Ruling #8 ADD2, which fixed this to {10, 100}. Owner instruction
// 2026-08-01: the customer picks their own leverage up to 100x on ApeX.
//
// The spirit of that ruling is kept and is the reason this list stops at 100
// rather than going higher — "anything else must be removed as an option, not
// silently clamped." 100 is where the ceiling actually is, enforced in three
// independent places: `pilot.max_leverage`, the signer's
// `max(1, min(100, leverage))`, and the live venue ceiling from the ApeX
// contract. Offering more would be exactly the silent clamp it forbids.
//
// 1 is the floor because ApeX has no 0x. "0x" is not a leverage, it is not
// trading.
// PER SYMBOL, not one global list. ApeX's top tier is 100x and BTC/ETH get
// it, but SOL/XRP/ARB cap at 50x. Offering 100x everywhere meant the sizer
// silently clamped — `plan_entry_size` does `min(requested, venue_max)` — so
// 80x on SOL became 50x with nothing said. That is the same silent clamp
// Ruling #8 ADD2 forbade.
//
// `venueMax` null means the venue did not publish a ceiling. Fall back to the
// ratified pilot ceiling rather than guessing higher; the sizer refuses an
// unknown symbol outright (SYMBOL_LEVERAGE_UNKNOWN), so this cannot let an
// unsupported leverage through.
function leverageChoicesFor(venueMax: number | null | undefined): number[] {
  const ceiling = Math.min(
    MAX_SELECTABLE_LEVERAGE,
    Number.isFinite(venueMax as number) && (venueMax as number) > 0
      ? Math.floor(venueMax as number)
      : MAX_SELECTABLE_LEVERAGE,
  );
  const top = Math.max(ceiling, MIN_SELECTABLE_LEVERAGE);
  return Array.from({ length: top - MIN_SELECTABLE_LEVERAGE + 1 }, (_, i) => top - i);
}
const DEFAULT_LEVERAGE = Math.min(5, MAX_SELECTABLE_LEVERAGE);

function TradeVenueSelector({
  venues,
  selectedId,
  onSelect,
  supported,
  loading,
}: {
  venues: Array<{ id: string; exchange: string; status: string | null }>;
  selectedId: string;
  onSelect: (id: string) => void;
  supported: boolean | undefined;
  loading: boolean;
}) {
  const selected = venues.find((venue) => venue.id === selectedId) ?? null;
  const kind = selected ? venueKind(selected.exchange) : null;

  return (
    <div className="grid min-w-0 gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label className="min-w-0">
        <span className="mb-1 block text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/45">
          Venue for this trade
        </span>
        <select
          aria-label="Venue for this trade"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
          disabled={loading || venues.length === 0}
          className="h-9 w-full min-w-0 rounded-lg border border-white/[0.08] bg-[color:var(--surface-2)] px-2.5 text-[12px] font-semibold text-white outline-none focus:border-[color:var(--onixus-purple)] disabled:text-white/35"
        >
          {venues.length === 0 ? <option value="">No verified venue</option> : null}
          {venues.map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venueLabel(venue.exchange)} · {venue.id.slice(0, 8)} ·{" "}
              {(venueKind(venue.exchange) ?? "venue").toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-2 sm:block sm:text-right">
        <span className="text-[9px] uppercase tracking-[0.14em] text-white/35">
          {kind ? kind.toUpperCase() : "ROUTE"}
        </span>
        <p
          className="mt-0.5 text-[10px] font-semibold"
          style={{ color: supported ? "var(--onixus-teal)" : "var(--warning)" }}
        >
          {selected
            ? supported
              ? "Execution adapter ready"
              : "Adapter not yet executable"
            : "Connect a venue first"}
        </p>
      </div>
      <div className="col-span-full flex flex-wrap gap-1.5" aria-label="Exchange choices">
        {SUPPORTED_VENUES.map((exchange) => {
          const connected = venues.some((venue) => venue.exchange === exchange);
          return (
            <a
              key={exchange}
              href="/exchanges"
              className="tb-neu-inset inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] text-white/65"
            >
              <img
                src={venueLogo(exchange)}
                alt=""
                width={18}
                height={18}
                className="h-[18px] w-[18px] object-contain"
              />
              {venueLabel(exchange)} · {connected ? "Manage" : "Connect"}
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ---------- order panel ----------
function OrderPanel({
  connectionId,
  book,
  symbol,
  tickSize,
  stepSize,
  side,
  onSide,
  margin,
  onMargin,
  leverage,
  onLeverage,
  venueMaxLeverage,
  lastPrice,
  lastPriceAt,
  lastPriceSymbol,
  onSymbol,
  symbols,
  exchangeName,
  executionEnabled,
}: {
  connectionId?: string | null;
  book: "paper" | "live";
  symbol: string;
  onSymbol: (s: string) => void;
  symbols: string[];
  tickSize: number;
  stepSize: number;
  side: Side;
  onSide: (s: Side) => void;
  margin: number;
  onMargin: (n: number) => void;
  leverage: number;
  onLeverage: (n: number) => void;
  /** This symbol's ApeX ceiling; null when the venue did not publish one. */
  venueMaxLeverage: number | null;
  lastPrice: number | null;
  lastPriceAt: number | null;
  lastPriceSymbol: string | null;
  exchangeName: string;
  executionEnabled: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const submitLiveTest = useServerFn(submitManualLiveTestOrder);
  const submitPaper = useServerFn(submitPaperDeskOrder);
  const queryClient = useQueryClient();
  // A paper ticket spends its destination role wallet, never the other five.
  const balance = useTradeBalance(book, book === "paper" ? side : undefined);

  const leverageChoices = useMemo(() => leverageChoicesFor(venueMaxLeverage), [venueMaxLeverage]);
  // A symbol switch can strand the selection above the new ceiling. Correct
  // it in the CONTROL rather than letting the sizer clamp it silently, so the
  // number on screen is the number that will be sent.
  useEffect(() => {
    const ceiling = leverageChoices[0];
    if (leverage > ceiling) onLeverage(ceiling);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverageChoices]);
  const notional = margin * leverage;
  // Rough liquidation: entry * (1 - 1/lev * 0.95) for long, mirror for short
  const estLiq = lastPrice
    ? lastPrice * (1 + (side === "long" ? -1 : 1) * (0.95 / leverage))
    : null;

  // Compute preview plan client-side using the SAME shared parity constants
  // the signer reads. Server /v1/manual-deploy-plan is the source of truth
  // at submission time; this is a pre-submit preview.
  //
  // Ruling #6 — refuse to plan on stale/symbol-mismatched marks. Any
  // LadderGuardError from planManualLadder is surfaced instead of silently
  // producing a "plan" against a wrong price.
  const [planError, plan] = useMemo<
    [string | null, ReturnType<typeof planManualLadder> | null]
  >(() => {
    if (lastPrice == null || lastPriceAt == null || !lastPriceSymbol) {
      return ["Waiting on live price…", null];
    }
    try {
      return [
        null,
        planManualLadder({
          symbol,
          side: side === "long" ? "BUY" : "SELL",
          markPrice: lastPrice,
          leverage,
          tickSize: tickSize > 0 ? tickSize : 0.1,
          stepSize: stepSize > 0 ? stepSize : defaultStepForSymbol(symbol),
          markSymbol: lastPriceSymbol,
          markPriceAt: lastPriceAt,
        }),
      ];
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return [msg, null];
    }
  }, [symbol, side, lastPrice, lastPriceAt, lastPriceSymbol, leverage, tickSize, stepSize]);

  const liveTest = book === "live" && LIVE_TEST_MODE;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-2xl bg-[color:var(--surface-1)] p-3">
      {liveTest ? null : (
        <div className="flex overflow-hidden rounded-lg border border-white/[0.08] text-[11px] font-bold uppercase tracking-[0.14em]">
          {(["long", "short"] as Side[]).map((s) => {
            const active = side === s;
            const activeBg = s === "long" ? "var(--onixus-hot-blue)" : "var(--onixus-red)";
            return (
              <button
                key={s}
                onClick={() => onSide(s)}
                aria-pressed={active}
                className={cn(
                  "flex-1 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
                  active
                    ? "text-white"
                    : "bg-transparent text-white/45 hover:bg-white/[0.04] hover:text-white/80",
                )}
                style={{
                  background: active ? activeBg : undefined,
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}

      {liveTest ? null : (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/50">
            Margin (USDT)
          </span>
          <input
            type="number"
            value={margin}
            onChange={(e) => onMargin(Number(e.target.value) || 0)}
            className="h-8 rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] px-2.5 font-mono text-[13px] tabular-nums text-white outline-none transition-colors focus:border-[color:var(--onixus-purple)] focus:ring-2 focus:ring-[color:var(--onixus-purple)]/40"
          />
        </label>
      )}

      {/* Leverage lives inside the manual trade ticket — one control only. */}

      <div className="flex min-h-0 flex-1 flex-col">
        <ManualTradeTicket
          connectionId={connectionId}
          book={book}
          exchange={exchangeName}
          symbol={symbol}
          symbols={symbols}
          onSymbol={onSymbol}
          side={side}
          onSide={onSide}
          margin={margin}
          onMargin={onMargin}
          leverage={leverage}
          onLeverage={onLeverage}
          venueMaxLeverage={venueMaxLeverage}
          tickSize={tickSize}
          stepSize={stepSize}
          markPrice={lastPrice}
          markPriceAt={lastPriceAt}
          availableBalance={balance.available}
          executionEnabled={executionEnabled}
          liveTestMode={liveTest}
          paperMarketOnly={book === "paper"}
          onSubmitLiveTest={
            executionEnabled
              ? async (args) => {
                  const res = await submitLiveTest({ data: args });
                  return res;
                }
              : undefined
          }
          onSubmit={async (ticket) => {
            if (book === "paper") {
              const result = await submitPaper({ data: paperDeskTicket.parse(ticket) });
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["open-positions", "paper"] }),
                queryClient.invalidateQueries({ queryKey: ["trade-balance", "paper"] }),
              ]);
              return result;
            }
            if (plan) setPreviewOpen(true);
          }}
        />
      </div>

      {liveTest || book === "paper" ? null : (
        <>
          <div className="space-y-1 rounded-lg border border-white/[0.06] bg-[color:var(--surface-2)] p-3 text-[11.5px]">
            <SummaryRow label="Take Profit" value="1% move per rung" />
            <SummaryRow
              label="Stop Logic"
              value={`After final rung (R${WALLET_CAMPAIGN_RUNG_COUNT})`}
            />
            <SummaryRow label="Est. Liquidation" value={fmtUsd(estLiq)} />
            <SummaryRow label="Est. Max Position" value={fmtUsd(notional)} sub="Notional" />
          </div>

          {/* Ruling #7 STEP 3 — order-action surface MUST carry a mode label. */}
          <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-black/40 px-2.5 py-1.5">
            <span className="text-[9.5px] uppercase tracking-[0.16em] text-white/50">
              Order routes to
            </span>
            <BookBadge book={book} />
          </div>

          {planError ? (
            <p
              role="alert"
              className="rounded border border-[color:var(--onixus-red)]/50 bg-[color:var(--onixus-red)]/10 px-2 py-1 text-center text-[10.5px] font-semibold text-[color:var(--onixus-red)]"
            >
              {planError}
            </p>
          ) : (
            <p className="text-center text-[10px] text-white/50">
              Preview only — atomic submit not wired.
            </p>
          )}
        </>
      )}

      {book === "paper" && (
        <p className="text-xs text-violet-200">
          Order routes to <BookBadge book={book} /> · Simulated market entry after Council review.
          No exchange order or wallet signature.
        </p>
      )}
      <DeployFormationModal
        open={previewOpen}
        plan={plan}
        armed={false}
        onClose={() => setPreviewOpen(false)}
        onConfirm={() => setPreviewOpen(false)}
      />
    </div>
  );
}

function SummaryRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10.5px] uppercase tracking-[0.12em] text-white/55">{label}</span>
      <span className="font-mono tabular-nums text-white">
        {value}
        {sub ? <span className="ml-1 text-[9.5px] text-white/45">{sub}</span> : null}
      </span>
    </div>
  );
}

// ---------- bottom row: scout signals (full trade plan per card) ----------
//
// Data source: bot_events.SIGNAL_EVALUATION rows via useSignalFeed. The
// evaluator payload contains identity + per-direction entry summaries with
// zone_level / zone_tolerance / retest state, and NOTHING ELSE. Fields
// unavailable at that source render "—" (see REPORT in commit message).
//
// Available from source:
//   • symbol, direction (dominant / per-side entry_summaries)
//   • LONG ENTRY / SHORT ENTRY zone = zone_level ± zone_tolerance
//   • EXIT hint: retest state + zone_assumption tag
//   • LEG label: emitter is Onyx's BOS/Accumulator evaluator (bot_worker.py)
//   • RUNGS TO DEPLOY: leg config constant (accumulator = DCA_RUNGS default)
// NOT AVAILABLE from SIGNAL_EVALUATION → rendered "—":
//   • STOP, TP tiers (need engine-side R geometry not in the event)
//   • rung prices (need per-symbol ladder from engine state)
//   • confidence (lives on scout_signals, not on this event) → label removed
export function ScoutSignalsCard() {
  const feed = useSignalFeed(12);
  const rows = feed.history.slice(0, 8);
  return (
    <BottomCard title="Scout Signals" action="View all">
      {rows.length === 0 ? (
        <EmptyRow label={feed.isLoading ? "Loading signals…" : "No signals yet"} />
      ) : (
        <ul className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
          {rows.map((r) => (
            <SignalPlanCard key={r.id} row={r} />
          ))}
        </ul>
      )}
    </BottomCard>
  );
}

function SignalPlanCard({ row }: { row: ReturnType<typeof useSignalFeed>["history"][number] }) {
  const d = row.detail;
  const sym = d.symbol ?? d.normalized_symbol ?? "—";
  const longSum = d.directions?.long?.entry_summaries?.[0];
  const shortSum = d.directions?.short?.entry_summaries?.[0];
  const dominant: Side | null =
    longSum && !shortSum
      ? "long"
      : shortSum && !longSum
        ? "short"
        : longSum
          ? "long"
          : shortSum
            ? "short"
            : null;
  const dirLabel = dominant ?? "long";
  const dirColor = dirLabel === "long" ? "var(--onixus-teal)" : "var(--onixus-red)";
  const dirBg =
    dirLabel === "long"
      ? "color-mix(in oklab, var(--onixus-teal) 18%, transparent)"
      : "color-mix(in oklab, var(--onixus-red) 18%, transparent)";

  const fmtZone = (s?: EntrySummary): string => {
    if (!s || s.zone_level == null || s.zone_tolerance == null) return "—";
    return `${fmt(s.zone_level - s.zone_tolerance, 4)} – ${fmt(s.zone_level + s.zone_tolerance, 4)}`;
  };
  const longEntry = fmtZone(longSum);
  const shortEntry = fmtZone(shortSum);

  // Exit hint: human-readable retest state + human-readable zone tag.
  // Never surface raw rule ids like `S26_break_candle_atr` to the operator;
  // route both fields through humanizeIdentifier.
  const activeSum = dominant === "short" ? shortSum : longSum;
  const stateLabel = humanizeIdentifier(activeSum?.state);
  const assumptionLabel = humanizeIdentifier(activeSum?.zone_assumption);
  const exitLabel = stateLabel
    ? `Retest ${stateLabel}${assumptionLabel ? ` · ${assumptionLabel}` : ""}`
    : "—";

  // Rungs to deploy: leg config only (accumulator default). Per-rung prices
  // are engine-derived and NOT on the SIGNAL_EVALUATION payload → "—".
  const rungCount = DCA_RUNGS;
  const rungsLabel = `${rungCount} rungs · prices —`;

  return (
    <li className="rounded-lg border border-white/[0.05] bg-[color:var(--surface-2)]/40 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <CoinBadge symbol={sym} size={28} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-white">
            {sym.replace("-", "/")}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em]"
            style={{ background: dirBg, color: dirColor }}
          >
            {dirLabel}
          </span>
        </div>
        <span className="text-[9px] uppercase tracking-[0.14em] text-white/45">
          Onyx · Accumulator
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px]">
        <PlanRow label="Long entry" value={longEntry} tone="long" />
        <PlanRow label="Short entry" value={shortEntry} tone="short" />
        <PlanRow label="Stop" value="—" tone="short" />
        <PlanRow label="TP" value="—" tone="long" />
        <PlanRow label="Exit" value={exitLabel} tone="neutral" span />
        <PlanRow label="Rungs" value={rungsLabel} tone="neutral" span />
      </div>
    </li>
  );
}

function PlanRow({
  label,
  value,
  tone,
  span,
}: {
  label: string;
  value: string;
  tone: "long" | "short" | "neutral";
  span?: boolean;
}) {
  const color =
    value === "—"
      ? "rgba(230,232,240,0.45)"
      : tone === "long"
        ? "var(--onixus-teal)"
        : tone === "short"
          ? "var(--onixus-red)"
          : "rgba(230,232,240,0.9)";
  return (
    <div className={cn("flex items-baseline justify-between gap-2", span && "col-span-2")}>
      <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <span className="truncate font-mono tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

// ---------- book badge (per-surface PAPER / LIVE label — safety control) ----------
//
// Ruling #7 STEP 3: every surface that displays positions, trades, or an
// order action MUST carry a visible mode label derived from the runtime book
// state — not from styling, and not defaulted. This chip is the shared
// primitive.
function BookBadge({ book }: { book: "paper" | "live" }) {
  const color = book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)";
  const label = book === "live" ? "LIVE" : "PAPER";
  return (
    <span
      data-testid={`book-badge-${book}`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.16em]"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 40%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ---------- open positions ----------
//
// Reads paper_positions when book="paper" and positions when book="live".
// The two tables have different columns; we normalize to one row shape and
// render the same table for both books (Ruling #7 STEP 2). Rows are surfaced
// exactly as stored — no client-side dedup (Ruling #7 STEP 5). Live mode
// never falls back to paper: if positions is empty, the empty state says so.
export interface OpenPosRow {
  id: string;
  pair: string;
  side: Side;
  /** null when venue omits size — render em-dash, never 0. */
  size: number | null;
  /** null when leverage unavailable — hide chip, never render 0x. */
  lev: number | null;
  /** null when entry unavailable — render em-dash, never 0. */
  entry: number | null;
  /** null when we have no independent live mark — do NOT default to entry. */
  mark: number | null;
  /** null when mark or PnL is unavailable — never render 0 as a real flat PnL. */
  pnl: number | null;
  pnlPct: number | null;
  /**
   * "external" = position opened directly on ApeX by the owner and pulled in
   * by reconciliation (strategy_metadata.origin === "venue_external").
   * "bot" = opened by Turtle Bot. Paper rows are always "bot".
   */
  origin: "bot" | "external";
  /** Actual protective stop price, or null if none is armed. */
  stop: number | null;
  /** Configured take-profit target, or null when the engine has not armed one. */
  takeProfit: number | null;
  venueProtection?: PositionProtection;
  /** Venue liquidation estimate. Paper positions do not have one. */
  liquidation: number | null;
  venue: string;
  /** Live venue connection identifier, or null when reconciliation did not record one. */
  connectionId?: string | null;
  exchange?: string;
  venueName?: string | null;
  walletRecord?: WalletIdentityRecord | null;
  /** Estimate from entry notional / venue leverage, not venue-reserved margin. */
  estimatedMargin?: number | null;
  strategy: string | null;
  wallet: string | null;
  openedAt: string | null;
  syncedAt: string | null;
  filledRungs: number | null;
  totalRungs: number | null;
}

function useOpenPositions(book: "paper" | "live", userId: string | undefined) {
  const queryClient = useQueryClient();
  const positions = useQuery({
    queryKey: ["open-positions", book, userId],
    enabled: !!userId,
    refetchInterval: 15_000,
    queryFn: async (): Promise<OpenPosRow[]> => {
      if (book === "paper") {
        const { data, error } = await supabase
          .from("paper_positions")
          .select(
            "id, symbol, direction, size_qty, leverage, entry_price, margin, stop_level, tp_level, strategy, wallet_key, entry_ts, updated_at, filled_rung_count, configured_rung_count",
          )
          .eq("user_id", userId!)
          .eq("status", "open")
          .order("entry_ts", { ascending: false });
        if (error) throw error;
        return (data ?? []).map((r) => {
          const entryNum = r.entry_price == null ? null : Number(r.entry_price);
          const entry = entryNum != null && Number.isFinite(entryNum) ? entryNum : null;
          const sizeRaw = r.size_qty == null ? null : Number(r.size_qty);
          const size = sizeRaw != null && Number.isFinite(sizeRaw) ? sizeRaw : null;
          const levRaw = r.leverage == null ? null : Number(r.leverage);
          const lev = levRaw != null && Number.isFinite(levRaw) && levRaw > 0 ? levRaw : null;
          const stopRaw = r.stop_level == null ? null : Number(r.stop_level);
          return {
            id: String(r.id),
            pair: String(r.symbol),
            side: (r.direction as Side) ?? "long",
            size,
            lev,
            entry,
            estimatedMargin:
              r.margin != null && Number.isFinite(Number(r.margin)) ? Number(r.margin) : null,
            // Valued below using independent per-symbol public quotes.
            mark: null,
            pnl: null,
            pnlPct: null,
            stop: stopRaw != null && Number.isFinite(stopRaw) && stopRaw > 0 ? stopRaw : null,
            takeProfit:
              r.tp_level != null && Number.isFinite(Number(r.tp_level)) && Number(r.tp_level) > 0
                ? Number(r.tp_level)
                : null,
            liquidation: null,
            venue: "Paper engine",
            strategy: r.strategy ?? null,
            wallet: r.wallet_key ?? null,
            openedAt: r.entry_ts ?? null,
            syncedAt: r.updated_at ?? null,
            filledRungs: Number.isFinite(Number(r.filled_rung_count))
              ? Number(r.filled_rung_count)
              : null,
            totalRungs:
              r.configured_rung_count != null && Number.isFinite(Number(r.configured_rung_count))
                ? Number(r.configured_rung_count)
                : null,
            origin: "bot" as const,
          };
        });
      }
      // LIVE — reads only public.positions. Never falls back to paper_positions
      // (Ruling #7 STEP 4).
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id, connection_id, wallet_connection_id, autopilot_workflow_id, strategy_id, decision_id, pair, side, size, leverage, entry_price, mark_price, current_price, unrealized_pnl, pnl_pct, liquidation_price, synced_at, opened_at, exchange, tp_price, tp_state, tp_venue_order_id, open_orders, strategy_metadata",
        )
        .eq("user_id", userId!)
        .eq("source", "live")
        .eq("status", "open")
        .order("opened_at", { ascending: false });
      if (error) throw error;
      const [venueResult, walletResult, identities] = await Promise.all([
        supabase
          .from("exchange_connections")
          .select("id,exchange,display_name")
          .eq("user_id", userId!),
        supabase
          .from("wallet_connections")
          .select("id,assigned_exchange_connection_id,label,public_address,status,provider")
          .eq("user_id", userId!)
          .eq("is_active", true),
        queryClient.fetchQuery(exchangeWalletIdentitiesQuery(userId)).catch(() => []),
      ]);
      return (data ?? []).map((r) => {
        // Ruling #16 — DB now returns NULL for unavailable fields. Never
        // coerce null → 0; a null must render as em-dash so the UI reads
        // "unavailable", not "flat / zero".
        const entryNum = r.entry_price == null ? null : Number(r.entry_price);
        const entry = entryNum != null && Number.isFinite(entryNum) ? entryNum : null;
        const sizeRaw = r.size == null ? null : Number(r.size);
        const size = sizeRaw != null && Number.isFinite(sizeRaw) ? sizeRaw : null;
        const levRaw = r.leverage == null ? null : Number(r.leverage);
        const lev = levRaw != null && Number.isFinite(levRaw) && levRaw > 0 ? levRaw : null;
        const rawMark = r.mark_price ?? r.current_price;
        const markNum = rawMark == null ? null : Number(rawMark);
        // Ruling #9 DEFECT 3: an identical-to-entry mark means the feed is
        // not updating. Treat it as unavailable rather than rendering a
        // fake $0.00 flat PnL.
        const markAvailable =
          markNum != null && Number.isFinite(markNum) && (entry == null || markNum !== entry);
        const pnlRaw = r.unrealized_pnl == null ? null : Number(r.unrealized_pnl);
        const pnl = markAvailable && pnlRaw != null && Number.isFinite(pnlRaw) ? pnlRaw : null;
        const pnlPctRaw = r.pnl_pct == null ? null : Number(r.pnl_pct);
        const pnlPct =
          markAvailable && pnlPctRaw != null && Number.isFinite(pnlPctRaw) ? pnlPctRaw : null;
        const venueProtection = readPositionProtection(
          r.open_orders,
          r.pair,
          r.side,
          r.tp_venue_order_id,
        );
        const stop = venueProtection.stops[0]?.price ?? null;
        const liquidationRaw = r.liquidation_price == null ? null : Number(r.liquidation_price);
        const takeProfitRaw = r.tp_price == null ? null : Number(r.tp_price);
        const metadata =
          r.strategy_metadata &&
          typeof r.strategy_metadata === "object" &&
          !Array.isArray(r.strategy_metadata)
            ? (r.strategy_metadata as Record<string, unknown>)
            : {};
        // Positions the owner opened directly on ApeX are reconciled in and
        // tagged `origin: venue_external`. They are NOT Turtle Bot positions
        // and must never be presented as bot-managed.
        const origin =
          metadata.origin === "venue_external" ? ("external" as const) : ("bot" as const);
        const venueConnection = venueResult.data?.find((item) => item.id === r.connection_id);
        const matchingWallets =
          !r.wallet_connection_id && r.connection_id
            ? connectedWallets(walletResult.data ?? [], r.connection_id, identities)
            : [];
        const attributedWallet = r.wallet_connection_id
          ? ((walletResult.data ?? []).find((item) => item.id === r.wallet_connection_id) ?? null)
          : null;
        const linkedWallet =
          attributedWallet ?? (matchingWallets.length === 1 ? matchingWallets[0] : null);
        return {
          id: String(r.id),
          pair: String(r.pair),
          side: (r.side as Side) ?? "long",
          size,
          lev,
          entry,
          mark: markAvailable ? markNum : null,
          pnl,
          pnlPct,
          stop: stop && stop > 0 ? stop : null,
          venueProtection,
          takeProfit:
            takeProfitRaw != null && Number.isFinite(takeProfitRaw) && takeProfitRaw > 0
              ? takeProfitRaw
              : null,
          liquidation:
            liquidationRaw != null && Number.isFinite(liquidationRaw) && liquidationRaw > 0
              ? liquidationRaw
              : null,
          venue: `${venueConnection?.display_name || venueLabel(String(r.exchange ?? "apex_omni"))}${r.connection_id ? ` · ${r.connection_id.slice(0, 8)}…` : " · connection unverified"}`,
          connectionId: r.connection_id,
          exchange: venueConnection?.exchange ?? r.exchange ?? "",
          venueName: venueConnection?.display_name,
          walletRecord: walletResult.error ? null : linkedWallet,
          estimatedMargin:
            size != null && entry != null && lev != null ? (size * entry) / lev : null,
          strategy:
            typeof metadata.strategy === "string"
              ? metadata.strategy
              : (r.strategy_id ??
                (typeof metadata.strategy_id === "string" ? metadata.strategy_id : null)),
          wallet: walletResult.error
            ? "Wallet lookup unavailable"
            : linkedWallet
              ? `${linkedWallet.label || "Wallet"} · ${linkedWallet.public_address.slice(0, 6)}…${linkedWallet.public_address.slice(-4)} · ${linkedWallet.status}`
              : r.wallet_connection_id
                ? "Recorded wallet is unavailable"
                : matchingWallets.length > 1
                  ? "Multiple wallets linked — unresolved"
                  : "No linked wallet on record",
          openedAt: r.opened_at ?? null,
          syncedAt: r.synced_at ?? null,
          filledRungs: null,
          totalRungs: null,
          origin,
        };
      });
    },
  });
  const symbols =
    book === "paper" ? [...new Set((positions.data ?? []).map((row) => row.pair))] : [];
  const quotes = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ["paper-reference-price", compactSymbol(symbol)],
      queryFn: () => fetchPaperQuote(symbol),
      refetchInterval: 5_000,
      staleTime: 3_000,
      retry: 1,
    })),
  });
  return {
    ...positions,
    data:
      book === "paper"
        ? positions.data?.map((row) => ({
            ...row,
            ...paperValuation(row, quotes[symbols.indexOf(row.pair)]?.data),
          }))
        : positions.data,
  };
}

function OpenPositionsCard({
  book,
  onSelectSymbol,
}: {
  book: "paper" | "live";
  onSelectSymbol?: (symbol: string) => void;
}) {
  const { user } = useAuth();
  const q = useOpenPositions(book, user?.id);
  const rows = q.data ?? [];
  // Ruling #9 DEFECT 3 — panel-level staleness notice. When we have rows
  // but no independent mark for any of them, the feed is not updating.
  const anyMarkStale = rows.some((r) => r.mark == null);
  return (
    <BottomCard title="Open Positions" headerAction={<RefreshPositionsButton book={book} />} badge={<BookBadge book={book} />}>
      {q.isLoading ? (
        <EmptyRow label="Loading positions…" />
      ) : q.isError ? (
        <div className="rounded-xl border border-[color:var(--onixus-red)]/30 bg-[color:var(--onixus-red)]/10 p-3 text-[10px] text-[color:var(--onixus-red)]">
          <p className="font-semibold">
            Open positions could not be read. No empty state is assumed.
          </p>
          <p className="mt-1 break-words font-mono opacity-75">
            {(q.error instanceof Error ? q.error.message : "Unknown positions read error")
              .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
              .slice(0, 220)}
          </p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="mt-2 rounded-lg border border-current/25 px-2 py-1 font-semibold hover:bg-white/[0.04]"
          >
            Retry read
          </button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyRow label={`No open positions (${book})`} />
      ) : (
        <>
          {anyMarkStale && (
            <div
              data-testid={`open-positions-stale-notice-${book}`}
              className="mb-2 rounded border border-[color:var(--onixus-red)]/40 bg-[color:var(--onixus-red)]/10 px-2 py-1 text-[10px] leading-snug text-[color:var(--onixus-red)]"
            >
              A fresh reference price is unavailable for one or more positions. Their unrealized PnL
              is unavailable until pricing resumes.
            </div>
          )}
          {book === "paper" && (
            <p className="pb-2 text-xs text-violet-200">
              Paper valuation · ApeX public reference prices · estimated gross unrealized P&amp;L
              before fees.
            </p>
          )}
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[1180px] text-[11px]"
              data-testid={`open-positions-${book}`}
            >
              <thead className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">
                <tr>
                  <th className="py-1.5 text-left">Symbol</th>
                  <th className="py-1.5 text-left">Exchange</th>
                  <th className="py-1.5 text-left">Wallet</th>
                  <th className="py-1.5 text-right">Size</th>
                  <th className="py-1.5 text-right">Entry / Mark</th>
                  <th className="py-1.5 text-right">Margin</th>
                  <th className="py-1.5 text-right">Leverage</th>
                  <th className="py-1.5 text-right">PnL</th>
                  <th className="py-1.5 text-right">
                    TP / <span>Stop</span>
                  </th>
                  <th className="py-1.5 text-right">Liquidation</th>
                  <th className="py-1.5 text-right">Management</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const sideColor = r.side === "long" ? "var(--onixus-teal)" : "var(--onixus-red)";
                  const pnlColor =
                    r.pnl == null
                      ? "rgba(255,255,255,0.55)"
                      : r.pnl >= 0
                        ? "var(--onixus-teal)"
                        : "var(--onixus-red)";
                  const hasStop = r.stop != null;
                  return (
                    <tr
                      key={r.id}
                      className="border-t border-white/[0.06]"
                      style={{ borderTopWidth: "0.5px" }}
                    >
                      {/* Market — symbol on one line, direction + leverage below */}
                      <td className="py-2.5 pr-2 align-middle">
                        <button
                          type="button"
                          onClick={() => onSelectSymbol?.(r.pair)}
                          className="flex items-center gap-2 text-left transition hover:text-[color:var(--onixus-teal)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--onixus-purple)]"
                          aria-label={`Load ${r.pair} in the trading chart`}
                        >
                          <PairBadge symbol={r.pair} showLabel={false} size={20} />
                          <div className="min-w-0">
                            <div
                              className="flex items-center gap-1.5 whitespace-nowrap font-semibold text-white"
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {r.pair}
                              <span
                                data-testid={`position-origin-${r.origin}`}
                                className="rounded px-1 py-[1px] text-[8.5px] font-semibold uppercase tracking-[0.1em]"
                                style={
                                  r.origin === "external"
                                    ? {
                                        color: "var(--onixus-amber, #F5A524)",
                                        border:
                                          "0.5px solid color-mix(in srgb, var(--onixus-amber, #F5A524) 45%, transparent)",
                                        background:
                                          "color-mix(in srgb, var(--onixus-amber, #F5A524) 12%, transparent)",
                                      }
                                    : {
                                        color: "var(--onixus-teal)",
                                        border:
                                          "0.5px solid color-mix(in srgb, var(--onixus-teal) 45%, transparent)",
                                        background:
                                          "color-mix(in srgb, var(--onixus-teal) 12%, transparent)",
                                      }
                                }
                              >
                                {r.origin === "external"
                                  ? `${venueLabel(r.exchange || "Venue")} direct`
                                  : "Turtle Bot"}
                              </span>
                            </div>
                            <div
                              className="mt-0.5 text-[10px] font-medium capitalize"
                              style={{ color: sideColor }}
                            >
                              {r.side}
                              <span className="text-white/45">
                                {r.lev != null && r.lev > 0 ? ` · ${r.lev}x` : ""}
                              </span>
                            </div>
                            {r.strategy ? (
                              <div className="mt-0.5 max-w-[180px] truncate text-[9px] text-white/35">
                                {humanizeIdentifier(r.strategy)}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      </td>

                      <td className="max-w-[170px] break-words py-2.5 pr-2 align-middle text-[10px] text-white/70">
                        {book === "live" ? (
                          <ExchangeIdentity
                            exchange={r.exchange ?? ""}
                            name={r.venueName}
                            connectionId={r.connectionId}
                          />
                        ) : (
                          r.venue
                        )}
                      </td>
                      <td className="max-w-[190px] break-words py-2.5 pr-2 align-middle text-[10px] text-white/70">
                        {book === "live" ? (
                          <WalletIdentity
                            wallet={r.walletRecord}
                            emptyLabel={r.wallet ?? "Not linked"}
                          />
                        ) : (
                          (r.wallet ?? "Not linked")
                        )}
                      </td>

                      {/* Size — right-aligned, monospace, magnitude-aware */}
                      <td className="py-2.5 text-right align-middle font-mono tabular-nums text-white">
                        {formatSize(r.size)}
                      </td>

                      {/* Entry / Mark — stacked, right-aligned */}
                      <td className="py-2.5 text-right align-middle font-mono tabular-nums">
                        <div className="text-white">{formatPrice(r.entry)}</div>
                        <div className="mt-0.5 text-[10px] text-white/50">
                          {r.mark == null ? "—" : formatPrice(r.mark)}
                        </div>
                      </td>
                      <td
                        className="py-2.5 text-right align-middle font-mono tabular-nums text-white/70"
                        title={
                          book === "live"
                            ? "Estimated as entry notional divided by leverage; venue-reserved margin may differ."
                            : undefined
                        }
                      >
                        {r.estimatedMargin == null
                          ? "—"
                          : `${book === "live" ? "~" : ""}${fmtUsd(r.estimatedMargin)}`}
                      </td>
                      <td className="py-2.5 text-right align-middle font-mono tabular-nums text-white/70">
                        {r.lev == null ? "—" : `${r.lev}×`}
                      </td>

                      {/* PnL — em-dash when unavailable, colored by sign otherwise */}
                      <td
                        className="py-2.5 text-right align-middle font-mono tabular-nums"
                        style={{ color: pnlColor }}
                      >
                        {r.pnl == null ? (
                          <span data-testid="pnl-unavailable">—</span>
                        ) : (
                          <>
                            <div>{fmtUsd(r.pnl)}</div>
                            <div className="mt-0.5 text-[10px]">{pct(r.pnlPct)}</div>
                          </>
                        )}
                      </td>

                      {/* Take profit and protective stop. */}
                      <td className="py-2.5 text-right align-middle font-mono tabular-nums">
                        {r.venueProtection ? (
                          <PositionProtectionReadout
                            protection={r.venueProtection}
                            botTarget={r.takeProfit}
                            syncedAt={r.syncedAt}
                          />
                        ) : (
                          <>
                            <div style={{ color: "var(--onixus-teal)" }}>
                              {r.takeProfit == null ? "TP —" : `TP ${formatPrice(r.takeProfit)}`}
                            </div>
                            <div className="mt-0.5">
                              {hasStop ? (
                                <span data-testid="stop-present" className="text-white/55">
                                  SL {formatPrice(r.stop)}
                                </span>
                              ) : (
                                <span
                                  data-testid="stop-none"
                                  style={{ color: "var(--onixus-red)" }}
                                >
                                  None
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="py-2.5 text-right align-middle font-mono tabular-nums text-amber-200/80">
                        {r.liquidation == null ? "—" : formatPrice(r.liquidation)}
                      </td>
                      <td className="py-2.5 pl-3 text-right align-middle">
                        <button
                          type="button"
                          onClick={() => onSelectSymbol?.(r.pair)}
                          className="rounded-lg border border-white/[0.08] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-white/65 hover:border-violet-400/30 hover:text-violet-200"
                        >
                          Load chart
                        </button>
                        <div className="mt-1 text-[8.5px] leading-4 text-white/35">
                          {r.origin === "external"
                            ? "Manage at venue"
                            : book === "paper"
                              ? "Paper engine-managed exit"
                              : "Council-managed exit"}
                          {r.totalRungs != null
                            ? ` · ${r.filledRungs ?? 0}/${r.totalRungs} rungs`
                            : ""}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </BottomCard>
  );
}

// ---------- life map funding ----------
function useAccumulatedRealized(book: "paper" | "live") {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["trade-desk-accumulated-realized", book, user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async (): Promise<number | null> => {
      if (book === "paper") {
        const { data, error } = await supabase
          .from("paper_trades")
          .select("pnl_net")
          .eq("user_id", user!.id);
        if (error) throw error;
        return (data ?? []).reduce((a, r) => a + Number(r.pnl_net ?? 0), 0);
      }
      const { data, error } = await supabase
        .from("trades")
        .select("realized_pnl")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + Number(r.realized_pnl ?? 0), 0);
    },
  });
}

/**
 * LifeMapFundingCard — reads the same `getLifeMapSnapshot` selector as the
 * Life Map page and the LifeProgressCard, so this card and /life-map always
 * report identical numbers. Rows are rendered in the engine's allocation
 * priority order (already applied server-side: priority ASC, then created_at).
 * Overflow strategy: compact rows fit ~10 in the card body; if the user has
 * more bills than that we show the top N and an in-card "+K more" toggle
 * that expands the list inline (no navigation, no data refetch).
 */
const FUNDING_COLLAPSED_ROWS = 8;

export function LifeMapFundingCard({ book }: { book: "paper" | "live" }) {
  const fetchSnap = useServerFn(getLifeMapSnapshot);
  const snapQ = useQuery({
    queryKey: ["life-map-snapshot"],
    queryFn: () => fetchSnap(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const accQ = useAccumulatedRealized(book);
  const [expanded, setExpanded] = useState(false);

  const snap = snapQ.data;
  const rows = snap?.bills ?? []; // server pre-sorts by priority ASC, created_at ASC
  const totalAmount = snap?.total_amount_usd ?? 0;
  const totalCovered =
    book === "paper" ? (snap?.total_paper_covered_usd ?? 0) : (snap?.total_covered_usd ?? 0);
  const coveragePct = totalAmount > 0 ? Math.min(100, (totalCovered / totalAmount) * 100) : 0;

  const overflow = Math.max(0, rows.length - FUNDING_COLLAPSED_ROWS);
  const visible = expanded ? rows : rows.slice(0, FUNDING_COLLAPSED_ROWS);
  const available = accQ.data ?? null;

  return (
    <BottomCard title="Life Map Funding" action="View" href="/life-map">
      {snapQ.isLoading ? (
        <EmptyRow label="Loading Life Map…" />
      ) : rows.length === 0 ? (
        <EmptyRow label="No bills yet — add categories on the Life Map page" />
      ) : (
        <div
          className={cn(
            "space-y-1.5",
            expanded && rows.length > FUNDING_COLLAPSED_ROWS ? "max-h-64 overflow-y-auto pr-1" : "",
          )}
          data-testid="life-map-funding-rows"
        >
          {visible.map((r) => {
            const amount = r.bill.amount_usd;
            const covered = Math.min(
              book === "paper" ? r.paper_covered_usd : r.covered_usd,
              amount,
            );
            const pct = amount > 0 ? Math.min(100, (covered / amount) * 100) : 0;
            const zero = covered <= 0;
            return (
              <div
                key={r.bill.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5"
                data-testid="life-map-funding-row"
              >
                <div className="min-w-0 truncate text-[11px] font-semibold text-white">
                  {r.bill.name}
                </div>
                <div className="justify-self-end font-mono text-[10px] tabular-nums text-white/55">
                  {Math.round(pct)}%
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: zero ? "transparent" : "var(--onixus-teal)",
                    }}
                  />
                </div>
                <div className="justify-self-end font-mono text-[10px] tabular-nums text-white/60">
                  {fmtUsd(covered)} / {fmtUsd(amount)}
                </div>
              </div>
            );
          })}
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 w-full rounded-md border border-white/[0.06] py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--onixus-hot-blue)] hover:bg-white/[0.03]"
              data-testid="life-map-funding-more"
            >
              {expanded ? "Show less" : `+${overflow} more`}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 space-y-1 border-t border-white/[0.05] pt-2">
        <div className="flex items-baseline justify-between font-mono text-[10px] tabular-nums text-white/55">
          <span className="uppercase tracking-[0.12em] text-white/45">
            Coverage · {rows.length} bill{rows.length === 1 ? "" : "s"}
          </span>
          <span className="text-white/80">{Math.round(coveragePct)}%</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-white/45">
            Available Realized-Profit Allocation
          </div>
          <div className="font-mono text-[13px] font-bold tabular-nums text-white">
            {accQ.isLoading ? "…" : fmtUsd(available)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[9.5px] text-white/45">
            {book === "paper" ? "Simulated gains — not real funds." : "Protected for funding."}
          </p>
          <Link
            to="/life-map"
            className="inline-block rounded-md border border-white/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/75 hover:text-white"
          >
            Manage Allocation
          </Link>
        </div>
      </div>
    </BottomCard>
  );
}

function BottomCard({
  headerAction,
  title,
  action,
  href,
  badge,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  action?: string;
  href?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-[color:var(--surface-1)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-white">{title}</h3>
          {badge}
        </div>
        {headerAction ?? (action ? (
          href ? (
            <Link
              to={href}
              className="flex items-center gap-1 text-[10.5px] font-semibold text-[color:var(--onixus-hot-blue)] hover:underline"
            >
              {action} <ExternalLink className="h-3 w-3" />
            </Link>
          ) : (
            <button className="flex items-center gap-1 text-[10.5px] font-semibold text-[color:var(--onixus-hot-blue)] hover:underline">
              {action} <ExternalLink className="h-3 w-3" />
            </button>
          )
        ) : null)}
      </div>
      {children}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-white/[0.06] py-6 text-[11px] text-white/40">
      {label}
    </div>
  );
}

// ---------- status bar ----------
function StatusBar({
  feedStatus,
  lastTickAt,
}: {
  feedStatus: StreamStatus;
  lastTickAt: number | null;
}) {
  const health = useBotHealth();
  const exec = useExecutionStatus();
  const workerOnline = health.heartbeatFresh;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const marketLive = feedStatus === "live";
  const feedLabel = (() => {
    const ageSec = lastTickAt ? Math.max(0, Math.round((now - lastTickAt) / 1000)) : null;
    if (feedStatus === "live") return ageSec != null ? `Feed Live · ${ageSec}s` : "Feed Live";
    if (feedStatus === "connecting") return "Feed Connecting…";
    if (feedStatus === "reconnecting") return "Feed Reconnecting…";
    if (feedStatus === "stale") return ageSec != null ? `Feed Stale · ${ageSec}s` : "Feed Stale";
    return "Feed Offline";
  })();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-[color:var(--surface-1)] px-4 py-2 text-[10.5px] text-white/60">
      <StatusDot ok={workerOnline} label={workerOnline ? "Worker Online" : "Worker Offline"} />
      <StatusDot ok={marketLive} label={feedLabel} />
      <StatusDot
        ok={exec.manualTradingReady}
        label={
          exec.isLoading
            ? "Execution Checking"
            : exec.automationTradingReady
              ? "Execution + Automation Ready"
              : exec.manualTradingReady
                ? "Manual Execution Ready"
                : "Execution Not Ready"
        }
      />
      <span className="max-w-[420px] truncate text-white/45" title={exec.runtimeReason}>
        {exec.runtimeReason}
      </span>
      <LiveSyncChip />
      <span className="rounded border border-white/[0.06] px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums">
        {health.worker.workerId ?? "no worker"} · {health.worker.environment ?? "—"}/
        {health.worker.mode ?? "—"} · creds{" "}
        {health.worker.credentialsOk === true
          ? "ok"
          : health.worker.credentialsOk === false
            ? "missing"
            : "?"}
        {readHealthString(health.worker.healthPayload, "guard_version")
          ? ` · guard v${readHealthString(health.worker.healthPayload, "guard_version")}`
          : ""}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-white/45">Latency</span>
        <span className="font-mono tabular-nums text-white">
          {health.heartbeatAgeSec != null
            ? `${Math.max(0, Math.round(health.heartbeatAgeSec))}s`
            : "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * Live venue sync chip — surfaces the most recent
 * LIVE_POSITION_RECONCILE_{OK,FAIL} bot_events row so a stalled reader
 * (the exact failure mode that hid this for 18 hours in Ruling #10) is
 * visible at a glance.
 *
 * - data-stale=true when no OK event in the last 3 minutes.
 * - data-error=true when the most recent event is a FAIL.
 */
function LiveSyncChip() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["live-sync-chip", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("bot_events")
        .select("event, level, created_at, detail")
        .eq("user_id", user!.id)
        .in("event", ["LIVE_POSITION_RECONCILE_OK", "LIVE_POSITION_RECONCILE_FAIL"])
        .order("created_at", { ascending: false })
        .limit(1);
      return (data ?? [])[0] ?? null;
    },
  });
  const row = q.data as {
    event?: string;
    created_at?: string;
    detail?: Record<string, unknown>;
  } | null;
  const ageSec = row?.created_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(row.created_at)) / 1000))
    : null;
  const isError = row?.event === "LIVE_POSITION_RECONCILE_FAIL";
  const isStale = ageSec == null || ageSec > 180;
  const ok = !!row && !isError && !isStale;
  const failureReason = typeof row?.detail?.reason === "string" ? row.detail.reason : "err";
  const label = !row
    ? "Venue Sync: no data"
    : isError
      ? `Venue Sync FAIL · ${failureReason}`
      : isStale
        ? `Venue Sync Stale · ${ageSec}s`
        : `Venue Sync OK · ${ageSec}s`;
  return (
    <span
      data-testid="live-sync-chip"
      data-stale={isStale ? "true" : "false"}
      data-error={isError ? "true" : "false"}
      className="flex items-center gap-1.5"
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: ok
            ? "var(--onixus-teal)"
            : isError
              ? "var(--onixus-red)"
              : "var(--onixus-amber, #F5A524)",
        }}
      />
      {label}
    </span>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: ok ? "var(--onixus-teal)" : "var(--onixus-red)" }}
      />
      {label}
    </span>
  );
}

// ---------- main ----------
export function TradeDesk({
  book,
  onChangeBook,
  candidateId = null,
  initialSymbol = null,
}: TradeDeskProps) {
  const [symbol, setSymbol] = useTradeDeskSymbol(initialSymbol, candidateId);
  const [chartInterval, setChartInterval] = useState<Interval>("15m");
  const [venueId, setVenueId] = useState("");
  const [side, setSide] = useState<Side>("long");
  const [margin, setMargin] = useState<number>(100);
  const [leverage, setLeverage] = useState<number>(DEFAULT_LEVERAGE);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const venuePortfolio = usePortfolioTotals();
  const tradeVenues = venuePortfolio.verifiedConns;
  const selectedVenue = tradeVenues.find((venue) => venue.id === venueId) ?? tradeVenues[0] ?? null;
  const selectedVenueSupportsExecution = selectedVenue?.exchange === "apex_omni";
  const tradeExecutionEnabled =
    book === "paper" || (Boolean(selectedVenue) && selectedVenueSupportsExecution);

  const ticker = useApexTicker(symbol, true);
  const stream = useApexPublicStream(symbol, "1m");
  const chart = useCandles(symbol, chartInterval, 180);
  const markets = useApexMarkets();
  // This symbol's ApeX leverage ceiling. Falls back to the same table the
  // worker uses when the live fetch has not landed.
  const venueMaxLeverage = useMemo(
    () =>
      apexMarketsWithFallback(markets.data).find((m) => m.symbol === symbol)?.maxLeverage ?? null,
    [markets.data, symbol],
  );

  // SYMBOL-VERIFIED lastPrice (Ruling #6).
  // The stream tags its state with the RAW venue symbol; the ticker query
  // does the same. We refuse to surface a price that did not originate from
  // the currently-selected symbol — no silent fallback to a value belonging
  // to a different asset, ever.
  const rawSymbol = symbol.replace(/[-_/]/g, "").toUpperCase();
  const streamMatches = stream.symbol === rawSymbol;
  const tickerMatches = ticker.data?.symbol === rawSymbol;
  const lastPriceSource: { price: number; symbol: string; at: number } | null = streamMatches
    ? stream.latestCandle
      ? { price: stream.latestCandle.close, symbol: rawSymbol, at: stream.lastTickAt ?? Date.now() }
      : stream.ticker?.lastPrice != null
        ? { price: stream.ticker.lastPrice, symbol: rawSymbol, at: stream.ticker.receivedAt }
        : null
    : null;
  const lastPricePayload =
    lastPriceSource ??
    (tickerMatches && ticker.data
      ? { price: ticker.data.price, symbol: rawSymbol, at: ticker.data.fetchedAt }
      : null);
  const lastPrice = lastPricePayload?.price ?? null;
  const lastPriceAt = lastPricePayload?.at ?? null;

  const marketList = useMemo(() => {
    const available = new Set(apexMarketsWithFallback(markets.data).map((market) => market.symbol));
    return DEFAULT_PAPER_SYMBOLS.filter((candidate) => available.has(candidate));
  }, [markets.data]);

  // Desk-level reads for the status strip and the slim position rail. Same
  // query keys as the drawer panels, so nothing double-fetches and no two
  // surfaces can disagree.
  const { user: deskUser } = useAuth();
  const openPosQ = useOpenPositions(book, deskUser?.id);
  const openPosRows = openPosQ.data ?? [];
  const scoutCycle = useShortlistCycle(book);
  const scoutScanning = scoutCycle.data?.status === "running" || scoutCycle.isFetching;
  const scoutLabel = scoutCycle.data
    ? `${scoutCycle.data.candidateCount ?? scoutCycle.data.rows.length}/${scoutCycle.data.universeSize ?? "—"}`
    : "—";

  return (
    <div
      className="trade-mobile-neu flex min-h-[calc(100dvh-4rem)] flex-col bg-[color:var(--bg-void)] text-white"
      data-testid="trade-desk"
    >
      <div className="flex w-full flex-1 flex-col gap-2 px-2 py-2 lg:px-3">
        <TopStrip
          book={book}
          onChangeBook={onChangeBook}
          balanceHidden={balanceHidden}
          onToggleBalance={() => setBalanceHidden((h) => !h)}
          openPositions={openPosQ.isLoading ? null : openPosRows.length}
          scoutLabel={scoutLabel}
          scoutActive={scoutScanning}
        />

        <div className="trade-workspace grid min-w-0 gap-3">
          <DesktopMarketChart
            symbol={symbol}
            symbols={marketList.length ? marketList : [symbol]}
            onSymbol={setSymbol}
            venue="ApeX market data"
            interval={chartInterval}
            onInterval={setChartInterval}
            candles={chart.data ?? EMPTY_CANDLES}
            loading={chart.isLoading}
            error={chart.isError}
            fallbackPrice={lastPrice}
          />

          {/* Execution first: the dashboard owns market context; this page owns
            placement, protection, and active-position control. */}
          <div className="trade-control-grid grid min-w-0 gap-3">
            <section className="trade-order-shell min-w-0" data-testid="trade-control-panel">
              <header className="px-4 pb-1 pt-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[color:var(--onixus-purple)]">
                  Trade control
                </p>
                <h1 className="mt-1 text-xl font-semibold text-white">Configure your trade</h1>
                <p className="mt-1 text-xs leading-5 text-white/50">
                  {book === "live" && LIVE_TEST_MODE
                    ? "Choose direction, minimum venue size, and leverage for the owner market-order canary."
                    : "Choose direction, size, leverage, take profit, stop loss, and entry plan before execution."}
                </p>
              </header>
              <div className="px-4 pb-2">
                {book === "paper" ? (
                  <div className="tb-neu-inset rounded-xl p-3 text-xs text-violet-200">
                    Paper simulator · ApeX public market data · no connected wallet required
                  </div>
                ) : (
                  <TradeVenueSelector
                    venues={tradeVenues}
                    selectedId={selectedVenue?.id ?? ""}
                    onSelect={setVenueId}
                    supported={selectedVenueSupportsExecution}
                    loading={venuePortfolio.isLoading}
                  />
                )}
              </div>
              <OrderPanel
                connectionId={book === "paper" ? null : (selectedVenue?.id ?? null)}
                book={book}
                symbol={symbol}
                tickSize={0.1}
                stepSize={defaultStepForSymbol(symbol)}
                side={side}
                onSide={setSide}
                margin={margin}
                onMargin={setMargin}
                leverage={leverage}
                onLeverage={setLeverage}
                venueMaxLeverage={
                  book === "paper" || selectedVenueSupportsExecution ? venueMaxLeverage : null
                }
                lastPrice={lastPrice}
                lastPriceAt={lastPriceAt}
                lastPriceSymbol={lastPricePayload?.symbol ?? null}
                onSymbol={setSymbol}
                symbols={marketList.length ? marketList : [symbol]}
                exchangeName={
                  book === "paper"
                    ? "ApeX Omni"
                    : selectedVenue
                      ? venueLabel(selectedVenue.exchange)
                      : "No venue selected"
                }
                executionEnabled={tradeExecutionEnabled}
              />
            </section>

            <section
              className="trade-position-control grid min-w-0 content-start gap-3"
              data-testid="position-control-panel"
            >
              <div className="trade-account-overview grid min-w-0 gap-3">
                <PanelErrorBoundary label="Exposure summary">
                  <ExposureSummaryCard
                    rows={openPosRows}
                    isLoading={openPosQ.isLoading}
                    isError={openPosQ.isError}
                    book={book}
                  />
                </PanelErrorBoundary>
                <PanelErrorBoundary label="Account assets">
                  <AccountAssetsCard portfolio={venuePortfolio} book={book} />
                </PanelErrorBoundary>
              </div>
              <div className="trade-open-positions min-w-0">
                {book === "paper" ? <PanelErrorBoundary label="Paper wallets"><PaperWalletsCard /></PanelErrorBoundary> : null}
                <PanelErrorBoundary label="Open positions">
                  <OpenPositionsCard book={book} onSelectSymbol={setSymbol} />
                </PanelErrorBoundary>
              </div>
            </section>

            <section
              className="trade-manual-tools hidden min-w-0 rounded-[24px] p-3 xl:block"
              data-testid="desktop-manual-tools"
            >
              <header className="mb-2 px-2 pt-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[color:var(--onixus-purple)]">
                  Desk activity
                </p>
                <p className="mt-1 text-xs text-white/45">
                  Review rungs, orders, trade history, and decision evidence without crowding the
                  order ticket.
                </p>
              </header>
              <ActivityDrawer
                defaultExpanded
                defaultTab="rungs"
                tabs={[
                  {
                    key: "rungs",
                    label: "Rungs",
                    content: (
                      <DeferredTradePanel>
                        <PanelErrorBoundary label="Rung activity">
                          <RungActivityPanel book={book} />
                        </PanelErrorBoundary>
                      </DeferredTradePanel>
                    ),
                  },
                  {
                    key: "orders",
                    label: "Open Orders",
                    content: (
                      <DeferredTradePanel>
                        <PanelErrorBoundary label="Order lifecycle">
                          <OrderIntentPanel book={book} />
                        </PanelErrorBoundary>
                      </DeferredTradePanel>
                    ),
                  },
                  {
                    key: "history",
                    label: "Trade History",
                    content: (
                      <DeferredTradePanel>
                        <PanelErrorBoundary label="Trade history">
                          <TradeHistoryCard book={book} />
                        </PanelErrorBoundary>
                      </DeferredTradePanel>
                    ),
                  },
                  {
                    key: "proof",
                    label: "Decision Proof",
                    content: (
                      <DeferredTradePanel>
                        <PanelErrorBoundary label="Decision proof">
                          <DecisionProofPanel />
                        </PanelErrorBoundary>
                      </DeferredTradePanel>
                    ),
                  },
                  {
                    key: "system",
                    label: "System Log",
                    content: (
                      <DeferredTradePanel>
                        <PanelErrorBoundary label="System log">
                          <SystemLogPanel book={book} />
                        </PanelErrorBoundary>
                      </DeferredTradePanel>
                    ),
                  },
                ]}
              />
            </section>
          </div>
        </div>

        <PanelErrorBoundary label="Trade intelligence">
          <TradeIntelligencePanel book={book} />
        </PanelErrorBoundary>

        {/* LIVE ACTIVITY BAR — collapsed by default, one line of status */}
        <div className="xl:hidden">
          <ActivityDrawer
            defaultTab="positions"
            summary={
              <>
                <span className="text-white/70">Live activity</span>
                <span className="text-white/35">
                  {openPosRows.length} position{openPosRows.length === 1 ? "" : "s"} · orders and
                  history
                </span>
              </>
            }
            tabs={[
              {
                key: "positions",
                label: "Positions",
                badge: openPosRows.length ? openPosRows.length : undefined,
                content: (
                  <PanelErrorBoundary label="Open positions">
                    <OpenPositionsCard book={book} onSelectSymbol={setSymbol} />
                  </PanelErrorBoundary>
                ),
              },
              {
                key: "orders",
                label: "Orders",
                content: (
                  <DeferredTradePanel>
                    <div className="space-y-4">
                      <PanelErrorBoundary label="Order lifecycle">
                        <OrderIntentPanel book={book} />
                      </PanelErrorBoundary>
                      <PanelErrorBoundary label="Take-profit council">
                        <TpCouncilPanel />
                      </PanelErrorBoundary>
                      <PanelErrorBoundary label="Orders">
                        <RungActivityPanel book={book} />
                      </PanelErrorBoundary>
                    </div>
                  </DeferredTradePanel>
                ),
              },
              {
                key: "proof",
                label: "Decision proof",
                content: (
                  <DeferredTradePanel>
                    <PanelErrorBoundary label="Decision proof">
                      <DecisionProofPanel />
                    </PanelErrorBoundary>
                  </DeferredTradePanel>
                ),
              },
              {
                key: "history",
                label: "Trade History",
                content: (
                  <DeferredTradePanel>
                    <PanelErrorBoundary label="Trade history">
                      <TradeHistoryCard book={book} />
                    </PanelErrorBoundary>
                  </DeferredTradePanel>
                ),
              },
              {
                key: "system",
                label: "System Log",
                content: (
                  <DeferredTradePanel>
                    <PanelErrorBoundary label="System log">
                      <SystemLogPanel book={book} />
                    </PanelErrorBoundary>
                  </DeferredTradePanel>
                ),
              },
            ]}
          />
        </div>

        <StatusBar feedStatus={stream.status} lastTickAt={stream.lastTickAt} />
      </div>
    </div>
  );
}

/** ExposureSummaryCard — compact open-exposure roll-up for the secondary row. */
function ExposureSummaryCard({
  rows,
  isLoading,
  isError,
  book,
}: {
  rows: OpenPosRow[];
  isLoading: boolean;
  isError: boolean;
  book: "paper" | "live";
}) {
  const withPnl = rows.filter((r) => r.pnl != null);
  const netPnl = withPnl.length ? withPnl.reduce((a, r) => a + (r.pnl ?? 0), 0) : null;
  const longs = rows.filter((r) => r.side === "long").length;
  const shorts = rows.length - longs;
  const noStop = rows.filter((r) => r.stop == null).length;
  return (
    <section
      className="flex min-h-0 flex-col rounded-xl bg-[color:var(--surface-1)] p-2.5"
      data-testid="exposure-summary-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">
          Exposure
        </span>
        <BookBadge book={book} />
      </div>
      {isLoading ? (
        <p className="mt-2 font-mono text-[10.5px] text-white/35">Loading…</p>
      ) : isError ? (
        <p className="mt-2 font-mono text-[10px] text-[color:var(--onixus-red)]">
          Position data unavailable
        </p>
      ) : (
        <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
          <div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Open</div>
            <div className="text-white">{rows.length}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Net PnL</div>
            <div
              style={{
                color:
                  netPnl == null
                    ? "rgba(230,232,240,0.45)"
                    : netPnl >= 0
                      ? "var(--onixus-teal)"
                      : "var(--onixus-red)",
              }}
            >
              {netPnl == null ? "—" : fmtUsd(netPnl)}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">L / S</div>
            <div className="text-white">
              {longs} / {shorts}
            </div>
          </div>
        </div>
      )}
      {!isError && noStop > 0 && (
        <p className="mt-1.5 truncate font-mono text-[10px]" style={{ color: "var(--onixus-red)" }}>
          {noStop} position{noStop === 1 ? "" : "s"} without a stop
        </p>
      )}
    </section>
  );
}

/**
 * Compact, read-only holdings view. It reuses the desk's single
 * usePortfolioTotals subscription, so balances cannot disagree with the
 * venue selector or header totals.
 */
function AccountAssetsCard({
  portfolio,
  book,
}: {
  portfolio: ReturnType<typeof usePortfolioTotals>;
  book: "paper" | "live";
}) {
  const balance = useTradeBalance(book);
  const totals = accountAssetTotals(book, balance, portfolio);
  const walletAssets =
    book === "paper"
      ? []
      : portfolio.walletEntries.flatMap((wallet) =>
          wallet.balances
            .filter((balance) => balance.amount !== 0)
            .map((balance) => ({
              key: `${wallet.id}:${balance.asset}`,
              label: balance.asset,
              amount: balance.amount,
              usdValue: balance.usdValue,
              source: wallet.chain,
            })),
        );
  const visibleAssets = walletAssets.slice(0, 4);

  return (
    <section
      className="flex min-h-0 flex-col rounded-xl bg-[color:var(--surface-1)] p-2.5"
      data-testid="account-assets-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">
          Assets &amp; buying power
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/35">
          {book === "paper"
            ? "Paper · simulated funds"
            : `${portfolio.exchangeSuccesses.length} venue · ${portfolio.walletCount} wallet`}
        </span>
      </div>
      {totals.isLoading ? (
        <p className="mt-2 font-mono text-[10.5px] text-white/35">Loading balances…</p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
            <AssetMetric
              label="Portfolio"
              value={totals.equity == null ? "—" : fmtUsd(totals.equity)}
            />
            <AssetMetric
              label="Available"
              value={totals.available == null ? "—" : fmtUsd(totals.available)}
            />
            <AssetMetric
              label="In trades"
              value={totals.allocated == null ? "—" : fmtUsd(totals.allocated)}
            />
          </div>
          {visibleAssets.length ? (
            <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
              {visibleAssets.map((asset) => (
                <div
                  key={asset.key}
                  className="flex items-center justify-between gap-3 text-[10px]"
                >
                  <span className="truncate text-white/55">
                    {asset.label} <span className="text-white/25">· {asset.source}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-white/75">
                    {asset.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    <span className="ml-2 text-white/35">
                      {asset.usdValue == null ? "$—" : fmtUsd(asset.usdValue)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-white/35">
              {book === "paper"
                ? "Simulation balance only; no real wallet funds are used."
                : "No non-zero connected-wallet assets were returned."}
            </p>
          )}
          {totals.hasError ? (
            <p className="mt-2 text-[10px] text-amber-200">
              {book === "paper"
                ? "Paper balance is unavailable. No live balance is substituted."
                : "At least one balance source is unavailable; totals include verified sources only."}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function AssetMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tb-neu-inset rounded-lg px-2 py-1.5">
      <div className="text-[8.5px] uppercase tracking-[0.12em] text-white/30">{label}</div>
      <div className="mt-0.5 truncate text-white">{value}</div>
    </div>
  );
}
