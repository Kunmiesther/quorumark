/**
 * ManualTradeTicket — compact manual trade setup.
 *
 * Replaces the read-only rung list that used to occupy this slot. The rung
 * history is still available, moved into a collapsed drawer beneath the
 * ticket.
 *
 * EXECUTION SAFETY: this component never submits directly. `onSubmit` is the
 * caller-owned canonical path (preview → server plan → broker). Success is
 * only rendered from what that path returns, never optimistically.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { openOnyx } from "@/components/onyx/OnyxPanel";
import { LIVE_TEST_DEFAULTS } from "@/lib/app-env";
import {
  MANUAL_DCA_DEFAULTS,
  MIN_TICKET_LEVERAGE,
  clampLeverage,
  leverageCeiling,
  leverageRiskTone,
  summarizeTicket,
  validateTicket,
  type OrderKind,
  type TicketSide,
} from "@/lib/trade/manualTicket";
import { RungActivityPanel } from "@/components/trade/RungActivityPanel";
import { useManualCouncil } from "./ManualCouncilReview";

const TONE_COLOR: Record<ReturnType<typeof leverageRiskTone>, string> = {
  safe: "var(--onixus-teal)",
  elevated: "var(--onixus-hot-blue)",
  high: "var(--warning)",
  extreme: "var(--onixus-red)",
};

const INTERNAL_LIVE_SYMBOL_CHOICES = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"];

function usd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
function px(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  const a = Math.abs(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 3 : 6 });
}

export interface ManualTradeTicketProps {
  connectionId?: string | null;
  book: "paper" | "live";
  exchange?: string;
  symbol: string;
  symbols?: string[];
  onSymbol?: (s: string) => void;
  side: TicketSide;
  onSide: (s: TicketSide) => void;
  margin: number;
  onMargin: (n: number) => void;
  leverage: number;
  onLeverage: (n: number) => void;
  venueMaxLeverage: number | null;
  tickSize: number;
  stepSize: number;
  markPrice: number | null;
  markPriceAt: number | null;
  availableBalance: number | null;
  minNotionalUsd?: number;
  executionEnabled?: boolean;
  paperMarketOnly?: boolean;
  /** Owner live-test lifecycle: entry only, CROSS, no SL/TP. */
  liveTestMode?: boolean;
  /** Canonical authenticated live-test submission (server function). */
  onSubmitLiveTest?: (args: {
    symbol: string;
    side: "BUY" | "SELL";
    size: number;
    leverage: number;
    estNotionalUsd: number;
  }) => Promise<{ status: string; exchangeOrderId: string | null; rejectReason: string | null }>;

  /** Canonical submission path. Must resolve only after acknowledgement. */
  onSubmit?: (ticket: {
    requestId: string;
    symbol: string;
    side: TicketSide;
    kind: OrderKind;
    leverage: number;
    marginUsd: number;
    limitPrice: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
    dcaEnabled: boolean;
    rungCount: number;
    spacingPct: number;
  }) => void | Promise<{ orderId?: string; status?: string } | void>;
}

export function ManualTradeTicket(props: ManualTradeTicketProps) {
  if (props.book === "live" && props.liveTestMode) {
    return (
      <LiveTestTicket
        connectionId={props.connectionId}
        exchange={props.exchange ?? "ApeX Omni"}
        symbol={props.symbol}
        symbols={props.symbols}
        onSymbol={props.onSymbol}
        markPrice={props.markPrice}
        markPriceAt={props.markPriceAt}
        stepSize={props.stepSize}
        availableBalance={props.availableBalance}
        leverage={props.leverage}
        onLeverage={props.onLeverage}
        venueMaxLeverage={props.venueMaxLeverage}
        onSubmitLiveTest={props.executionEnabled === false ? undefined : props.onSubmitLiveTest}
      />
    );
  }
  return <FullTicket {...props} />;
}

function FullTicket(props: ManualTradeTicketProps) {
  const {
    book,
    exchange = "ApeX Omni",
    symbol,
    symbols = [],
    onSymbol,
    side,
    onSide,
    margin,
    onMargin,
    leverage,
    onLeverage,
    venueMaxLeverage,
    tickSize,
    stepSize,
    markPrice,
    markPriceAt,
    availableBalance,
    minNotionalUsd = 0,
    executionEnabled = true,
    onSubmit,
  } = props;

  const [kind, setKind] = useState<OrderKind>("market");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [dca, setDca] = useState(false);
  const [rungCount, setRungCount] = useState<number>(MANUAL_DCA_DEFAULTS.rungCount);
  const [spacingPct, setSpacingPct] = useState<number>(MANUAL_DCA_DEFAULTS.spacingPct);
  const [rungMargins, setRungMargins] = useState<number[] | null>(null);
  const [tpPerRung, setTpPerRung] = useState(false);
  const [query, setQuery] = useState("");
  const [liveConfirm, setLiveConfirm] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const [ack, setAck] = useState<{ orderId?: string; status?: string } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);

  const ceiling = leverageCeiling(venueMaxLeverage);
  const lev = clampLeverage(leverage, venueMaxLeverage);
  const tone = leverageRiskTone(lev, ceiling);
  const entry = kind === "limit" ? Number(limitPrice) || 0 : (markPrice ?? 0);
  const council = useManualCouncil({
    connectionId: props.connectionId,
    rungMargins,
    takeProfitPerRung: tpPerRung,
    book,
    exchange,
    symbol,
    side,
    leverage: lev,
    margin,
    kind,
    limitPrice: Number(limitPrice) || null,
    takeProfit: Number(takeProfit) || null,
    stopLoss: Number(stopLoss) || null,
    dca,
    rungCount: dca ? rungCount : 1,
    spacingPct: dca ? spacingPct : 0,
  });

  const summary = useMemo(
    () =>
      summarizeTicket({
        side,
        entry,
        marginUsd: margin,
        leverage: lev,
        tickSize: tickSize > 0 ? tickSize : 0.1,
        stepSize: stepSize > 0 ? stepSize : 0.001,
        dcaEnabled: dca,
        rungCount,
        spacingPct,
        rungMargins: rungMargins ?? undefined,
        stopLoss: Number(stopLoss) || null,
      }),
    [
      side,
      entry,
      margin,
      lev,
      tickSize,
      stepSize,
      dca,
      rungCount,
      spacingPct,
      rungMargins,
      stopLoss,
    ],
  );

  const reasons = validateTicket({
    symbol,
    side,
    kind,
    marginUsd: margin,
    leverage: lev,
    venueMaxLeverage,
    limitPrice: Number(limitPrice) || null,
    markPrice,
    markPriceAt,
    availableBalance,
    takeProfit: Number(takeProfit) || null,
    stopLoss: Number(stopLoss) || null,
    summary,
    minNotionalUsd,
    book,
    liveConfirmed: liveConfirm >= 100,
    executionEnabled,
  });
  if (props.paperMarketOnly && (kind !== "market" || dca)) reasons.push("Paper manual execution supports market single entries; resting limit orders and manual DCA are not connected yet.");
  if (!onSubmit) reasons.push("Order submission is unavailable.");
  const blocked = reasons.length > 0;

  const filtered = symbols
    .filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 8);

  function setRungMargin(i: number, v: number) {
    const base = rungMargins ?? summary.rungs.map((r) => r.marginUsd);
    const next = [...base];
    next[i] = Math.max(0, v);
    setRungMargins(next);
  }
  function resetDca() {
    setRungCount(MANUAL_DCA_DEFAULTS.rungCount);
    setSpacingPct(MANUAL_DCA_DEFAULTS.spacingPct);
    setRungMargins(null);
  }
  function changeRungCount(next: number) {
    const n = Math.max(MANUAL_DCA_DEFAULTS.minRungs, Math.min(MANUAL_DCA_DEFAULTS.maxRungs, next));
    setRungCount(n);
    setRungMargins(null);
  }

  async function submit() {
    if (blocked || inFlight.current || !onSubmit) return;
    if (!council.ready) {
      await council.ask();
      return;
    }
    setSubmitting(true);
    inFlight.current = true;
    setSubmitError(null);
    try {
      const ticket = {
        symbol,
        side,
        kind,
        leverage: lev,
        marginUsd: margin,
        limitPrice: Number(limitPrice) || null,
        takeProfit: Number(takeProfit) || null,
        stopLoss: Number(stopLoss) || null,
        dcaEnabled: dca,
        rungCount: dca ? rungCount : 1,
        spacingPct: dca ? spacingPct : 0,
      };
      const key = JSON.stringify(ticket);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const res = await onSubmit({ ...ticket, requestId: request.current.id });
      if (res && (res.orderId || res.status)) setAck(res);
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "Submission could not be confirmed. Check positions before retrying.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      setLiveConfirm(0);
    }
  }

  if (ack) {
    return (
      <div
        data-testid="manual-trade-ack"
        className="rounded-xl border border-white/[0.08] bg-[color:var(--surface-1)] p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[color:var(--onixus-teal)]">
            {book === "paper" ? "Paper submission confirmed" : "Position active"}
          </span>
          <span className="font-mono text-[10px] text-white/50">
            {ack.status ?? "acknowledged"}
          </span>
        </div>
        <p className="mt-1 font-mono text-[11px] text-white/70">
          {symbol.replace("-", "/")} · {side.toUpperCase()} · {lev}× · {usd(summary.totalMargin)}{" "}
          margin
        </p>
        {ack.orderId ? (
          <p className="mt-0.5 font-mono text-[10px] text-white/40">Order {ack.orderId}</p>
        ) : null}
        <div className="mt-2 flex gap-2">
          <button disabled title="Post-entry TP / SL editing is not connected in this ticket." className="min-h-[44px] flex-1 rounded-lg border border-white/10 text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
            Edit TP / SL
          </button>
          <button
            onClick={() => { request.current = null; setSubmitError(null); setAck(null); }}
            className="min-h-[44px] flex-1 rounded-lg border border-white/10 text-[11px] font-bold uppercase tracking-[0.12em] text-white/70 hover:text-white"
          >
            New ticket
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="manual-trade-ticket"
      className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto pr-0.5"
    >
      {/* Header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/70">
            Manual Trade
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              color: book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)",
              background: `color-mix(in oklab, ${book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)"} 14%, transparent)`,
            }}
          >
            {book}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/45">
          {exchange} · {usd(availableBalance)}
        </span>
      </div>

      <TradeSetupGuide
        book={book}
        open={guideOpen}
        step={guideStep}
        onToggle={() => setGuideOpen((value) => !value)}
        onStep={setGuideStep}
        onAskOnyx={() => {
          openOnyx();
          setGuideStep(1);
        }}
      />

      {/* Row 1 — symbol, side, order kind */}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            aria-label="Symbol"
            value={query || symbol}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-full rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] pl-7 pr-2 font-mono text-[12px] text-white outline-none focus:border-[color:var(--onixus-purple)]"
          />
          {query && filtered.length ? (
            <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-white/10 bg-[color:var(--surface-1)]">
              {filtered.map((s) => (
                <li key={s}>
                  <button
                    onClick={() => {
                      onSymbol?.(s);
                      setQuery("");
                    }}
                    className="block w-full px-2 py-2 text-left font-mono text-[11.5px] text-white/80 hover:bg-white/[0.06]"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex overflow-hidden rounded-md border border-white/[0.08] text-[10.5px] font-bold uppercase tracking-[0.12em]">
            {(["long", "short"] as TicketSide[]).map((s) => (
              <button
                key={s}
                aria-pressed={side === s}
                onClick={() => onSide(s)}
                className={cn("min-h-[36px] flex-1", side === s ? "text-white" : "text-white/45")}
                style={{
                  background:
                    side === s
                      ? s === "long"
                        ? "var(--onixus-hot-blue)"
                        : "var(--onixus-red)"
                      : undefined,
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-md border border-white/[0.08] text-[10.5px] font-bold uppercase tracking-[0.12em]">
            {(["market", "limit"] as OrderKind[]).map((k) => (
              <button
                key={k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "min-h-[36px] flex-1",
                  kind === k ? "bg-white/[0.1] text-white" : "text-white/45",
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2 — amount, qty, entry, tp, sl */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Field label="Amount (USDT)">
          <input
            type="number"
            aria-label="Order amount"
            value={margin}
            onChange={(e) => onMargin(Number(e.target.value) || 0)}
            className={inputCls}
          />
        </Field>
        <Field label="Quantity">
          <div className="flex h-9 items-center rounded-md border border-white/[0.06] bg-black/40 px-2 font-mono text-[12px] tabular-nums text-white/70">
            {summary.quantity > 0 ? summary.quantity.toFixed(6) : "—"}
          </div>
        </Field>
        <Field label="Notional">
          <div className="flex h-9 items-center rounded-md border border-white/[0.06] bg-black/40 px-2 font-mono text-[12px] tabular-nums text-white/70">
            {usd(summary.totalNotional)}
          </div>
        </Field>
        {kind === "limit" ? (
          <Field label="Entry">
            <input
              type="number"
              aria-label="Limit entry price"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className={inputCls}
            />
          </Field>
        ) : null}
        <Field label="Take profit">
          <input
            type="number"
            aria-label="Take profit"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Stop loss">
          <input
            type="number"
            aria-label="Stop loss"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      {/* Leverage bar */}
      <div className="rounded-lg border border-white/[0.06] bg-[color:var(--surface-2)] p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">Leverage</span>
          <span
            className="font-mono text-[15px] font-bold tabular-nums"
            style={{ color: TONE_COLOR[tone] }}
          >
            {lev}×
          </span>
        </div>
        <input
          type="range"
          aria-label="Leverage"
          min={MIN_TICKET_LEVERAGE}
          max={ceiling}
          step={1}
          value={lev}
          onChange={(e) => onLeverage(clampLeverage(Number(e.target.value), venueMaxLeverage))}
          className="mt-1.5 h-6 w-full cursor-pointer accent-[color:var(--onixus-purple)]"
          style={{ accentColor: TONE_COLOR[tone] }}
        />
        <div className="flex justify-between font-mono text-[9px] tabular-nums text-white/35">
          <span>{MIN_TICKET_LEVERAGE}×</span>
          <span>exchange max {ceiling}×</span>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10px] tabular-nums text-white/55">
          <Mini k="Est. liq" v={px(summary.estLiquidation)} />
          <Mini k="Margin" v={usd(summary.totalMargin)} />
        </div>
      </div>

      {/* DCA */}
      <div className="rounded-lg border border-white/[0.06] bg-[color:var(--surface-2)] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/45">
            DCA {dca ? `· ${rungCount} rungs` : "· single entry"}
          </span>
          <button
            role="switch"
            aria-checked={dca}
            aria-label="Enable DCA"
            onClick={() => setDca((d) => !d)}
            className={cn(
              "min-h-[28px] rounded-full px-3 text-[10px] font-bold uppercase tracking-[0.14em]",
              dca ? "text-black" : "text-white/50",
            )}
            style={{ background: dca ? "var(--onixus-purple)" : "rgba(255,255,255,0.08)" }}
          >
            {dca ? "on" : "off"}
          </button>
        </div>

        {dca ? (
          <div className="mt-2" data-testid="dca-advanced">
            {/* concentric ring chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              {summary.rungs.map((r) => (
                <span
                  key={r.index}
                  data-testid="dca-ring"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full border font-mono text-[9.5px] font-bold text-white/80"
                  style={{
                    borderColor: "var(--onixus-purple)",
                    background: `color-mix(in oklab, var(--onixus-purple) ${8 + r.index * 6}%, transparent)`,
                  }}
                >
                  {r.index}
                </span>
              ))}
              <button
                aria-label="Add rung"
                onClick={() => changeRungCount(rungCount + 1)}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/15 text-white/60 hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label="Remove rung"
                onClick={() => changeRungCount(rungCount - 1)}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/15 text-white/60 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label="Reset DCA"
                onClick={resetDca}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/15 text-white/60 hover:text-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="Spacing %">
                <input
                  type="number"
                  aria-label="Rung spacing percent"
                  step={0.05}
                  value={spacingPct}
                  onChange={(e) => setSpacingPct(Math.max(0, Number(e.target.value) || 0))}
                  className={inputCls}
                />
              </Field>
              <Field label="TP behaviour">
                <button
                  onClick={() => setTpPerRung((v) => !v)}
                  className="h-9 rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] px-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-white/70"
                >
                  {tpPerRung ? "Per rung" : "Single TP"}
                </button>
              </Field>
            </div>

            <ul
              className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1"
              data-testid="dca-rung-list"
            >
              {summary.rungs.map((r, i) => (
                <li
                  key={r.index}
                  className="grid grid-cols-[28px_minmax(0,1fr)_72px] items-center gap-2 font-mono text-[10.5px] tabular-nums"
                >
                  <span className="text-white/50">R{r.index}</span>
                  <span className="truncate text-white/75">
                    @ {px(r.price)} · {r.size.toFixed(6)}
                  </span>
                  <input
                    type="number"
                    aria-label={`Rung ${r.index} margin`}
                    value={Number(r.marginUsd.toFixed(2))}
                    onChange={(e) => setRungMargin(i, Number(e.target.value) || 0)}
                    className="h-7 w-full rounded border border-white/[0.08] bg-black/40 px-1.5 text-right text-[10.5px] text-white/80 outline-none"
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* Summary */}
      <div
        className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-white/[0.06] bg-black/40 p-2.5 font-mono text-[10.5px] tabular-nums"
        data-testid="ticket-summary"
      >
        <Mini k="Side" v={`${side.toUpperCase()} ${symbol.replace("-", "/")}`} />
        <Mini k="Leverage" v={`${lev}×`} />
        <Mini k="Entries" v={String(summary.rungs.length)} />
        <Mini k="Total margin" v={usd(summary.totalMargin)} />
        <Mini k="Notional" v={usd(summary.totalNotional)} />
        <Mini k="Weighted entry" v={px(summary.weightedEntry)} />
        <Mini k="TP" v={takeProfit ? px(Number(takeProfit)) : "—"} />
        <Mini k="SL" v={stopLoss ? px(Number(stopLoss)) : "—"} />
        <Mini k="Est. liq" v={px(summary.estLiquidation)} />
        <Mini k="Est. fees" v={usd(summary.estFeesUsd)} />
        <Mini k="Worst case" v={usd(summary.worstCaseLossUsd)} />
        <Mini k="Margin mode" v="Cross" />
      </div>

      {/* Live confirmation */}
      {book === "live" ? (
        <div
          className="rounded-lg border p-2.5"
          style={{
            borderColor: liveConfirm >= 100 ? "var(--onixus-teal)" : "var(--warning)",
            background: `color-mix(in oklab, ${liveConfirm >= 100 ? "var(--onixus-teal)" : "var(--warning)"} 8%, transparent)`,
          }}
        >
          <div
            className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: liveConfirm >= 100 ? "var(--onixus-teal)" : "var(--warning)" }}
          >
            <Lock className="h-3.5 w-3.5" />
            Live order — real funds
          </div>
          <input
            type="range"
            aria-label="Slide to confirm live order"
            min={0}
            max={100}
            value={liveConfirm}
            onChange={(e) => setLiveConfirm(Number(e.target.value))}
            className="h-6 w-full cursor-pointer"
            style={{ accentColor: "var(--onixus-teal)" }}
          />
        </div>
      ) : null}

      {/* History drawer */}
      <details
        className="rounded-lg border border-white/[0.06] bg-black/30 xl:hidden"
        data-testid="rung-history-drawer"
      >
        <summary className="flex min-h-[32px] cursor-pointer list-none items-center justify-between px-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">
          Rung history
          <ChevronDown className="h-3.5 w-3.5" />
        </summary>
        <div className="p-2.5 pt-0">
          <RungActivityPanel book={book} />
        </div>
      </details>

      {/* Sticky action area — always visible, never below the fold. */}
      {council.panel}
      {submitError && <p role="alert" className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">{submitError}</p>}
      <div
        data-testid="ticket-action-bar"
        className="sticky bottom-0 z-10 -mx-0.5 mt-auto space-y-1.5 border-t border-white/[0.08] bg-[color:var(--surface-1)]/95 px-0.5 pb-1 pt-2 backdrop-blur"
      >
        {blocked ? (
          <ul
            data-testid="ticket-blocked-reasons"
            className="max-h-[52px] overflow-y-auto rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 p-1.5 text-[10px] text-[color:var(--warning)]"
          >
            {reasons.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        ) : null}

        <button
          onClick={submit}
          disabled={blocked || submitting || council.pending}
          aria-disabled={blocked || submitting}
          title={reasons[0] ?? "Submit"}
          data-testid="ticket-submit"
          className={cn(
            "min-h-[40px] w-full rounded-xl px-4 text-[12px] font-bold uppercase tracking-[0.16em]",
            blocked || submitting
              ? "cursor-not-allowed bg-white/[0.06] text-white/35"
              : book === "live"
                ? "bg-[color:var(--onixus-teal)] text-black"
                : "bg-[color:var(--onixus-purple)] text-white",
          )}
        >
          {council.pending
            ? "Council is reviewing…"
            : !council.ready
              ? "Review with Council"
              : submitting
                ? "Submitting…"
                : book === "live"
                  ? "Submit Live Order"
                  : "Place Paper Trade"}
        </button>
      </div>
    </div>
  );
}

const TRADE_GUIDE_STEPS = [
  {
    label: "Discover",
    title: "Ask Onyx for the strongest qualified setup",
    detail:
      "Onyx scans eligible markets through the Council. If nothing passes every gate, it will tell you to wait.",
  },
  {
    label: "Market",
    title: "Confirm the symbol and direction",
    detail:
      "Choose the market, Long or Short, and Market or Limit. Onyx recommends; you keep the final choice.",
  },
  {
    label: "Exposure",
    title: "Choose margin and leverage",
    detail:
      "Set how much capital is exposed and adjust leverage within the exchange ceiling. Review estimated liquidation before continuing.",
  },
  {
    label: "Protection",
    title: "Set take-profit and stop-loss",
    detail:
      "Define the exit target and invalidation level. A setup without valid protection remains blocked.",
  },
  {
    label: "Review",
    title: "Review the complete trade before approval",
    detail:
      "Check notional, fees, worst-case loss, and mode. Paper and Live always require separate explicit confirmation.",
  },
] as const;

function TradeSetupGuide({
  book,
  open,
  step,
  onToggle,
  onStep,
  onAskOnyx,
}: {
  book: "paper" | "live";
  open: boolean;
  step: number;
  onToggle: () => void;
  onStep: (step: number) => void;
  onAskOnyx: () => void;
}) {
  const current = TRADE_GUIDE_STEPS[step];
  const last = step === TRADE_GUIDE_STEPS.length - 1;

  return (
    <section
      className="rounded-xl border border-[color:var(--onixus-purple)]/35 bg-[color:var(--onixus-purple)]/[0.07] p-2.5"
      aria-labelledby="onyx-trade-guide-title"
      data-testid="onyx-trade-guide"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--onixus-purple)]/20 text-violet-200">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <strong id="onyx-trade-guide-title" className="block text-xs text-white">
            Trade with Onyx
          </strong>
          <span className="block text-[10px] text-white/45">
            Guided {book} setup · step {step + 1} of {TRADE_GUIDE_STEPS.length}
          </span>
        </span>
        <ChevronDown className={cn("h-4 w-4 text-white/45 transition", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="mt-2 border-t border-white/[0.06] pt-2.5">
          <div className="grid grid-cols-5 gap-1" aria-label="Guided trade progress">
            {TRADE_GUIDE_STEPS.map((item, index) => (
              <button
                key={item.label}
                type="button"
                onClick={() => onStep(index)}
                className="min-w-0"
                aria-current={index === step ? "step" : undefined}
              >
                <span
                  className={cn(
                    "block h-1 rounded-full",
                    index <= step ? "bg-[color:var(--onixus-purple)]" : "bg-white/[0.08]",
                  )}
                />
                <span
                  className={cn(
                    "mt-1 block truncate text-[8px] uppercase tracking-[0.08em]",
                    index === step ? "text-violet-200" : "text-white/30",
                  )}
                >
                  {item.label}
                </span>
              </button>
            ))}
          </div>

          <p className="mt-2 text-[11px] font-semibold text-white/85">{current.title}</p>
          <p className="mt-1 text-[10px] leading-4 text-white/50">{current.detail}</p>

          <div className="mt-2 flex items-center gap-2">
            {step === 0 ? (
              <button
                type="button"
                onClick={onAskOnyx}
                className="min-h-10 flex-1 rounded-xl bg-[color:var(--onixus-purple)] px-3 text-[10px] font-bold uppercase tracking-[0.12em] text-white"
              >
                Ask Onyx for best setup
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onStep(step - 1)}
                className="grid min-h-10 min-w-10 place-items-center rounded-xl border border-white/10 text-white/60"
                aria-label="Previous guided trade step"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {!last ? (
              <button
                type="button"
                onClick={() => onStep(step + 1)}
                className="ml-auto flex min-h-10 items-center justify-center gap-1 rounded-xl border border-white/10 px-3 text-[10px] font-bold uppercase tracking-[0.12em] text-white/70"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="ml-auto text-[9px] uppercase tracking-[0.12em] text-white/35">
                Use the confirmation below
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] px-2 font-mono text-[12px] tabular-nums text-white outline-none focus:border-[color:var(--onixus-purple)]";

const compactInputCls =
  "h-8 w-full rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] px-2 font-mono text-[12px] tabular-nums text-white outline-none focus:border-[color:var(--onixus-teal)]";

const selectCls =
  "h-8 w-full rounded-md border border-white/[0.08] bg-[color:var(--surface-2)] px-2 font-mono text-[11.5px] uppercase tracking-[0.08em] text-white outline-none focus:border-[color:var(--onixus-teal)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[9.5px] uppercase tracking-[0.14em] text-white/45">
        {label}
      </span>
      {children}
    </label>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[9.5px] uppercase tracking-[0.12em] text-white/40">{k}</span>
      <span className="truncate text-white/85">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LIVE TEST TICKET — owner minimum-size live proof.
//
// Fixed lifecycle: MARKET entry only, CROSS margin, signer-attached protective
// stop, and no take-profit ladder at entry. Exit management belongs to the
// TP council after 3 fully closed candles.
//
// Submission goes through the caller-supplied canonical authenticated server
// function. This component never calls the signer or writes rows.
// ---------------------------------------------------------------------------

type LiveTestPhase =
  "ready" | "queued" | "submitted" | "accepted" | "filled" | "council" | "rejected";

const PHASE_LABEL: Record<LiveTestPhase, string> = {
  ready: "Submit Trade",
  queued: "Queued…",
  submitted: "Submitted — awaiting ApeX",
  accepted: "ApeX Accepted",
  filled: "Filled",
  council: "TP/Exit pending — Council review 0/3",
  rejected: "Rejected — see venue error",
};

function LiveTestTicket({
  connectionId,
  exchange,
  symbol,
  onSymbol,
  markPrice,
  markPriceAt,
  stepSize,
  availableBalance,
  leverage,
  onLeverage,
  venueMaxLeverage,
  onSubmitLiveTest,
}: {
  connectionId?: string | null;
  exchange: string;
  symbol: string;
  symbols?: string[];
  onSymbol?: (s: string) => void;
  markPrice: number | null;
  markPriceAt: number | null;
  stepSize: number;
  availableBalance: number | null;
  leverage: number;
  onLeverage: (value: number) => void;
  venueMaxLeverage: number | null;
  onSubmitLiveTest?: (args: {
    symbol: string;
    side: "BUY" | "SELL";
    size: number;
    leverage: number;
    estNotionalUsd: number;
  }) => Promise<{ status: string; exchangeOrderId: string | null; rejectReason: string | null }>;
}) {
  const testSymbol = LIVE_TEST_DEFAULTS.symbol;
  const [side, setSide] = useState<TicketSide>(LIVE_TEST_DEFAULTS.side as TicketSide);
  const [size, setSize] = useState<number>(LIVE_TEST_DEFAULTS.size);
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<LiveTestPhase>("ready");
  const [venueError, setVenueError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const council = useManualCouncil({
    book: "live",
    connectionId,
    exchange,
    symbol,
    side,
    leverage,
    margin: null,
    size,
    kind: "market",
    limitPrice: null,
    takeProfit: null,
    stopLoss: null,
    dca: false,
    rungCount: 1,
    spacingPct: 0,
  });

  // Symbol is now operator-selected. Seed the desk on the default test
  // instrument once when nothing sensible is selected.
  useEffect(() => {
    if (!INTERNAL_LIVE_SYMBOL_CHOICES.includes(symbol)) onSymbol?.(testSymbol);
  }, [symbol, testSymbol, onSymbol]);

  const price = markPrice && markPrice > 0 ? markPrice : null;
  const stale = markPriceAt == null || Date.now() - markPriceAt > 30_000;
  const notional = price ? size * price : null;
  const estMargin = notional != null && leverage > 0 ? notional / leverage : null;
  const step = stepSize > 0 ? stepSize : 0.01;
  const leverageMax = leverageCeiling(venueMaxLeverage);
  const overCeiling = (notional ?? 0) > LIVE_TEST_DEFAULTS.maxNotionalUsd;

  const busy = phase === "queued" || phase === "submitted";
  const reasons: string[] = [];
  if (!price) reasons.push(`Waiting on a live ${symbol || "market"} price`);
  else if (stale) reasons.push("Price feed is stale — refusing to size an order");
  if (!(size > 0)) reasons.push("Size must be greater than 0");
  if (size < step) reasons.push(`Size is below the venue step (${step})`);
  if (!Number.isInteger(leverage) || leverage < MIN_TICKET_LEVERAGE || leverage > leverageMax) {
    reasons.push(`Leverage must be between ${MIN_TICKET_LEVERAGE}× and ${leverageMax}×`);
  }
  if (overCeiling)
    reasons.push(`Notional exceeds the $${LIVE_TEST_DEFAULTS.maxNotionalUsd} internal limit`);
  if (!onSubmitLiveTest) reasons.push("Live submission path unavailable");
  const blocked =
    reasons.length > 0 || busy || phase === "accepted" || phase === "filled" || phase === "council";

  async function submit() {
    if (blocked || !onSubmitLiveTest || notional == null) return;
    if (!council.ready) {
      await council.ask();
      return;
    }
    setVenueError(null);
    setPhase("queued");
    try {
      setPhase("submitted");
      const res = await onSubmitLiveTest({
        symbol,

        side: side === "long" ? "BUY" : "SELL",
        size,
        leverage,
        estNotionalUsd: notional,
      });
      setOrderId(res.exchangeOrderId);
      const s = (res.status ?? "").toLowerCase();
      if (s.includes("reject") || res.rejectReason) {
        setVenueError(res.rejectReason ?? `Venue rejected: ${res.status}`);
        setPhase("rejected");
        setReviewing(false);
      } else if (s.includes("fill")) {
        setPhase("council");
        setReviewing(false);
      } else if (s.includes("accept") || s.includes("open") || s.includes("submit")) {
        setPhase("accepted");
        setReviewing(false);
      } else {
        setPhase("accepted");
        setReviewing(false);
      }
    } catch (e) {
      setVenueError(e instanceof Error ? e.message : "SUBMIT_FAILED");
      setPhase("rejected");
      setReviewing(false);
    }
  }

  return (
    <div
      data-testid="manual-trade-ticket"
      className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto pr-0.5"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/70">
            Manual Trade
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              color: "var(--onixus-teal)",
              background: "color-mix(in oklab, var(--onixus-teal) 14%, transparent)",
            }}
          >
            live test
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/45">
          {exchange} · {usd(availableBalance)}
        </span>
      </div>

      {/* Symbol + fixed owner-canary order type */}
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Symbol">
          <select
            aria-label="Symbol"
            value={symbol}
            onChange={(e) => {
              onSymbol?.(e.target.value);
              setReviewing(false);
            }}
            className={selectCls}
          >
            {INTERNAL_LIVE_SYMBOL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Order type">
          <div className="flex h-8 items-center rounded-md border border-white/[0.08] bg-white/[0.04] px-3 text-[10.5px] font-bold uppercase tracking-[0.12em] text-white/70">
            Market
          </div>
        </Field>
      </div>

      {/* Side + size */}
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Side">
          <div className="flex h-8 overflow-hidden rounded-md border border-white/[0.08] text-[10.5px] font-bold uppercase tracking-[0.12em]">
            {(["long", "short"] as TicketSide[]).map((s) => (
              <button
                key={s}
                aria-pressed={side === s}
                onClick={() => {
                  setSide(s);
                  setReviewing(false);
                }}
                className={cn("flex-1", side === s ? "text-white" : "text-white/45")}
                style={{
                  background:
                    side === s
                      ? s === "long"
                        ? "var(--onixus-hot-blue)"
                        : "var(--onixus-red)"
                      : undefined,
                }}
              >
                {s === "long" ? "buy / long" : "sell / short"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Size">
          <input
            type="number"
            aria-label="Test order size"
            step={step}
            min={step}
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value) || 0);
              setReviewing(false);
            }}
            className={compactInputCls}
          />
        </Field>
      </div>

      <Field label={`Leverage · ${leverage}×`}>
        <input
          type="range"
          aria-label="Leverage"
          min={MIN_TICKET_LEVERAGE}
          max={leverageMax}
          step={1}
          value={leverage}
          onChange={(e) => {
            onLeverage(clampLeverage(Number(e.target.value), venueMaxLeverage));
            setReviewing(false);
          }}
          className="h-8 w-full cursor-pointer accent-[color:var(--onixus-teal)]"
        />
      </Field>

      <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-2 text-[10px] leading-4 text-white/45">
        Owner canary orders are market entry only. The private signer attaches a protective stop; no
        take-profit ladder is attached at entry. Exit management requires Council review.
      </div>

      {/* Calculated figures */}
      <div
        data-testid="live-test-summary"
        className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-white/[0.06] bg-black/40 p-2 font-mono text-[10.5px] tabular-nums"
      >
        <Mini k="Mark" v={px(price)} />
        <Mini k="Notional" v={usd(notional)} />
        <Mini k="Est. margin" v={usd(estMargin)} />
        <Mini k="At leverage" v={`${leverage}× ${LIVE_TEST_DEFAULTS.marginMode.toLowerCase()}`} />
      </div>

      {overCeiling ? (
        <div
          role="alert"
          data-testid="live-test-oversize-warning"
          className="rounded-lg border p-2 text-[10.5px]"
          style={{
            borderColor: "var(--onixus-red)",
            background: "color-mix(in oklab, var(--onixus-red) 12%, transparent)",
            color: "var(--onixus-red)",
          }}
        >
          <div className="flex items-center gap-1.5 font-bold uppercase tracking-[0.14em]">
            <Lock className="h-3.5 w-3.5" />
            Notional {usd(notional)} exceeds the ${LIVE_TEST_DEFAULTS.maxNotionalUsd} test ceiling
          </div>
          <p className="mt-1">
            Reduce size before review. This server-enforced limit cannot be bypassed.
          </p>
        </div>
      ) : null}

      {reviewing && !blocked ? (
        <div
          role="region"
          aria-label="Live order review"
          data-testid="live-order-review"
          className="rounded-lg border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-2.5 text-[10.5px] leading-4 text-white/70"
        >
          <p className="font-bold uppercase tracking-[0.14em] text-[color:var(--warning)]">
            Review real-money order
          </p>
          <p className="mt-1 font-mono text-white/85">
            {side === "long" ? "BUY / LONG" : "SELL / SHORT"} {size} {symbol} · {leverage}× cross ·{" "}
            {usd(notional)} notional
          </p>
          <p className="mt-1">
            The next click sends this order to ApeX. It cannot be undone after the venue fills it.
          </p>
        </div>
      ) : null}

      {venueError ? (
        <p
          role="alert"
          data-testid="live-test-venue-error"
          className="rounded-lg border border-[color:var(--onixus-red)]/50 bg-[color:var(--onixus-red)]/10 p-2 font-mono text-[10.5px] text-[color:var(--onixus-red)]"
        >
          {venueError}
        </p>
      ) : null}

      {orderId ? (
        <p className="font-mono text-[10px] text-white/45">Venue order {orderId}</p>
      ) : null}

      {council.panel}
      <div className="sticky bottom-0 z-10 mt-auto space-y-1.5 border-t border-white/[0.08] bg-[color:var(--surface-1)]/95 pb-1 pt-2 backdrop-blur">
        {reasons.length ? (
          <ul
            data-testid="live-test-blocked-reasons"
            className="max-h-[52px] overflow-y-auto rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 p-1.5 text-[10px] text-[color:var(--warning)]"
          >
            {reasons.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        ) : null}
        <button
          onClick={() => {
            if (!council.ready) {
              void council.ask();
              return;
            }
            if (reviewing) void submit();
            else {
              setPhase("ready");
              setReviewing(true);
            }
          }}
          disabled={blocked || council.pending}
          aria-disabled={blocked}
          data-testid="ticket-submit"
          className={cn(
            "min-h-[44px] w-full rounded-xl px-3 text-[11.5px] font-bold uppercase tracking-[0.14em]",
            blocked
              ? "cursor-not-allowed bg-white/[0.06] text-white/35"
              : "bg-[color:var(--onixus-teal)] text-black",
          )}
        >
          {council.pending
            ? "Council is reviewing…"
            : !council.ready
              ? "Review with Council"
              : busy || phase === "accepted" || phase === "filled" || phase === "council"
                ? PHASE_LABEL[phase]
                : reviewing
                  ? "Confirm and send real order"
                  : phase === "rejected"
                    ? "Review live order again"
                    : "Review live order"}
        </button>
      </div>
    </div>
  );
}
