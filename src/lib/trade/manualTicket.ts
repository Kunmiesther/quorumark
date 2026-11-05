/**
 * Manual trade ticket — pure math + validation.
 *
 * PRESENTATION/PREVIEW LAYER ONLY. Nothing here submits an order, mutates
 * state, or relaxes a gate. The server (signer `/v1/manual-deploy-plan` and
 * the execution broker) remains the sole authority for authorization,
 * entitlement, idempotency, balance, precision, minimum notional and the live
 * gate. This module exists so the client can show truthful numbers and a
 * precise reason when a submission is not allowed.
 */

export type TicketSide = "long" | "short";
export type OrderKind = "market" | "limit";

/** Hard client ceiling; the venue ceiling is applied on top of this. */
export const MAX_TICKET_LEVERAGE = 100;
export const MIN_TICKET_LEVERAGE = 1;

/** Taker fee assumption for worst-case estimates (basis points, per side). */
export const TAKER_FEE_BPS = 5;

/** Exchange-safe manual defaults. Deliberately NOT the automated BTC/ETH
 *  8-rung strategy geometry — a manual ticket on an arbitrary symbol must
 *  start from something conservative the client then edits. */
export const MANUAL_DCA_DEFAULTS = {
  rungCount: 3,
  spacingPct: 0.5,
  minRungs: 2,
  maxRungs: 12,
  minSpacingPct: 0.05,
  maxSpacingPct: 25,
} as const;

export interface TicketRung {
  index: number;
  /** Limit price for this rung. */
  price: number;
  /** Margin allocated to this rung (USD). */
  marginUsd: number;
  /** Venue-step-rounded base size. */
  size: number;
  /** size * price. */
  notionalUsd: number;
}

export interface TicketSummary {
  rungs: TicketRung[];
  totalMargin: number;
  totalNotional: number;
  /** Notional-weighted average entry across all rungs. */
  weightedEntry: number;
  /** Total base quantity. */
  quantity: number;
  estFeesUsd: number;
  estLiquidation: number | null;
  /** Loss if the stop fills exactly, fees included. Null without a stop. */
  worstCaseLossUsd: number | null;
}

export function clampLeverage(requested: number, venueMax?: number | null): number {
  const ceiling = Math.max(
    MIN_TICKET_LEVERAGE,
    Math.min(
      MAX_TICKET_LEVERAGE,
      Number.isFinite(venueMax as number) && (venueMax as number) > 0
        ? Math.floor(venueMax as number)
        : MAX_TICKET_LEVERAGE,
    ),
  );
  if (!Number.isFinite(requested)) return MIN_TICKET_LEVERAGE;
  return Math.max(MIN_TICKET_LEVERAGE, Math.min(ceiling, Math.floor(requested)));
}

export function leverageCeiling(venueMax?: number | null): number {
  return clampLeverage(MAX_TICKET_LEVERAGE, venueMax);
}

/** Risk colour progression for the leverage bar. */
export function leverageRiskTone(leverage: number, ceiling: number): "safe" | "elevated" | "high" | "extreme" {
  const pct = ceiling > 0 ? leverage / ceiling : 0;
  if (leverage <= 5 || pct <= 0.15) return "safe";
  if (pct <= 0.4) return "elevated";
  if (pct <= 0.75) return "high";
  return "extreme";
}

export function floorToStep(size: number, step: number): number {
  if (!(step > 0)) return size;
  return Math.floor(size / step + 1e-9) * step;
}

export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.round(price / tick) * tick;
}

/** Approximate isolated-style liquidation used for display only. Cross margin
 *  on the venue is more forgiving, so this is a conservative estimate. */
export function estimateLiquidation(entry: number, leverage: number, side: TicketSide): number | null {
  if (!(entry > 0) || !(leverage > 0)) return null;
  const move = 0.95 / leverage;
  return side === "long" ? entry * (1 - move) : entry * (1 + move);
}

/** Evenly spaced DCA rung prices, walking AWAY from entry (down for long,
 *  up for short). Rung 1 is always the entry itself. */
export function buildRungPrices(args: {
  entry: number;
  side: TicketSide;
  rungCount: number;
  spacingPct: number;
  tickSize: number;
}): number[] {
  const { entry, side, tickSize } = args;
  const n = Math.max(1, Math.floor(args.rungCount));
  const spacing = Math.max(0, args.spacingPct) / 100;
  const dir = side === "long" ? -1 : 1;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(roundToTick(entry * (1 + dir * spacing * i), tickSize));
  }
  return out;
}

/**
 * Build the full ticket summary. `marginUsd` is the TOTAL margin the client
 * committed; it is split evenly across rungs with the remainder carried on
 * the last rung so the sum never exceeds the committed total.
 */
export function summarizeTicket(args: {
  side: TicketSide;
  entry: number;
  marginUsd: number;
  leverage: number;
  tickSize: number;
  stepSize: number;
  dcaEnabled: boolean;
  rungCount?: number;
  spacingPct?: number;
  /** Optional explicit per-rung margins (client edited). */
  rungMargins?: number[];
  stopLoss?: number | null;
  feeBps?: number;
}): TicketSummary {
  const {
    side,
    entry,
    marginUsd,
    leverage,
    tickSize,
    stepSize,
    dcaEnabled,
    stopLoss = null,
    feeBps = TAKER_FEE_BPS,
  } = args;

  const n = dcaEnabled ? Math.max(1, Math.floor(args.rungCount ?? MANUAL_DCA_DEFAULTS.rungCount)) : 1;
  const prices = buildRungPrices({
    entry,
    side,
    rungCount: n,
    spacingPct: dcaEnabled ? (args.spacingPct ?? MANUAL_DCA_DEFAULTS.spacingPct) : 0,
    tickSize,
  });

  const margins: number[] = [];
  if (args.rungMargins && args.rungMargins.length === n) {
    for (const m of args.rungMargins) margins.push(Math.max(0, Number(m) || 0));
  } else {
    const per = Math.floor((marginUsd / n) * 100) / 100;
    for (let i = 0; i < n; i += 1) margins.push(per);
    // Carry the rounding remainder on the last rung — never overspend.
    const spent = per * n;
    margins[n - 1] = Math.max(0, margins[n - 1] + (marginUsd - spent));
  }

  const rungs: TicketRung[] = [];
  for (let i = 0; i < n; i += 1) {
    const price = prices[i];
    const m = margins[i];
    const rawSize = price > 0 ? (m * leverage) / price : 0;
    const size = floorToStep(rawSize, stepSize);
    const notionalUsd = size * price;
    rungs.push({
      index: i + 1,
      price,
      marginUsd: leverage > 0 ? notionalUsd / leverage : 0,
      size,
      notionalUsd,
    });
  }

  const totalNotional = rungs.reduce((a, r) => a + r.notionalUsd, 0);
  const totalMargin = rungs.reduce((a, r) => a + r.marginUsd, 0);
  const quantity = rungs.reduce((a, r) => a + r.size, 0);
  const weightedEntry = quantity > 0 ? totalNotional / quantity : 0;
  const estFeesUsd = (totalNotional * feeBps) / 10_000 * 2; // entry + exit
  const estLiquidation = estimateLiquidation(weightedEntry || entry, leverage, side);

  let worstCaseLossUsd: number | null = null;
  if (stopLoss != null && stopLoss > 0 && quantity > 0 && weightedEntry > 0) {
    const move = side === "long" ? weightedEntry - stopLoss : stopLoss - weightedEntry;
    worstCaseLossUsd = Math.max(0, move) * quantity + estFeesUsd;
  }

  return {
    rungs,
    totalMargin,
    totalNotional,
    weightedEntry,
    quantity,
    estFeesUsd,
    estLiquidation,
    worstCaseLossUsd,
  };
}

export interface TicketValidationInput {
  symbol: string | null;
  side: TicketSide;
  kind: OrderKind;
  marginUsd: number;
  leverage: number;
  venueMaxLeverage: number | null;
  limitPrice: number | null;
  markPrice: number | null;
  markPriceAt: number | null;
  availableBalance: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  summary: TicketSummary;
  /** Venue minimum order notional (USD). */
  minNotionalUsd?: number;
  nowMs?: number;
  maxMarkAgeMs?: number;
  /** Live submission requires the confirm control to be held/completed. */
  book: "paper" | "live";
  liveConfirmed?: boolean;
  executionEnabled?: boolean;
}

/** Precise, visible blocking reasons. Empty array === submittable. */
export function validateTicket(input: TicketValidationInput): string[] {
  const reasons: string[] = [];
  const now = input.nowMs ?? Date.now();
  const maxAge = input.maxMarkAgeMs ?? 30_000;

  if (!input.symbol) reasons.push("Select a symbol");
  if (!(input.markPrice != null && input.markPrice > 0)) {
    reasons.push("Waiting on a live price for this symbol");
  } else if (input.markPriceAt == null || now - input.markPriceAt > maxAge) {
    reasons.push("Price feed is stale — refusing to size an order");
  }
  if (!(input.marginUsd > 0)) reasons.push("Enter an order amount above 0");
  if (input.availableBalance != null && input.marginUsd > input.availableBalance) {
    reasons.push("Order amount exceeds available balance");
  }
  const ceiling = leverageCeiling(input.venueMaxLeverage);
  if (input.leverage < MIN_TICKET_LEVERAGE || input.leverage > ceiling) {
    reasons.push(`Leverage must be between ${MIN_TICKET_LEVERAGE}× and ${ceiling}× on this symbol`);
  }
  if (input.kind === "limit" && !(input.limitPrice != null && input.limitPrice > 0)) {
    reasons.push("Limit orders need an entry price");
  }
  if (input.summary.quantity <= 0) {
    reasons.push("Order size rounds to zero at this amount — increase the amount or leverage");
  }
  const minNotional = input.minNotionalUsd ?? 0;
  if (minNotional > 0 && input.summary.totalNotional > 0 && input.summary.totalNotional < minNotional) {
    reasons.push(`Below the exchange minimum order size ($${minNotional})`);
  }
  const ref = input.summary.weightedEntry || input.markPrice || 0;
  if (input.takeProfit != null && ref > 0) {
    const wrong = input.side === "long" ? input.takeProfit <= ref : input.takeProfit >= ref;
    if (wrong) reasons.push("Take profit is on the wrong side of entry");
  }
  if (input.stopLoss != null && ref > 0) {
    const wrong = input.side === "long" ? input.stopLoss >= ref : input.stopLoss <= ref;
    if (wrong) reasons.push("Stop loss is on the wrong side of entry");
  }
  if (input.book === "live") {
    if (input.executionEnabled === false) {
      reasons.push("Live execution is disabled in this build");
    } else if (!input.liveConfirmed) {
      reasons.push("Hold the live confirmation control to submit");
    }
  }
  return reasons;
}
