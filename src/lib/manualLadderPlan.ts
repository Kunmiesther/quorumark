/**
 * Client-side ladder planner — mirror of signer/app/builder.py::build_ladder_plan.
 *
 * PREVIEW ONLY. Used by the Deploy Formation confirmation modal so the owner
 * sees the exact per-rung margin, prices, hard stop, and totals BEFORE any
 * server call. Server-side `POST /v1/manual-deploy-plan` is the source of
 * truth at submission time; this is a UX mirror.
 *
 * Safety mirror: per-rung margin sums EXACTLY to LADDER.dca_total_margin_usd;
 * remainder is carried on the LAST rung. Refuses to plan on overspend.
 *
 * Ruling #6 hard guards (fail loud, never silently size a real ladder off a
 * wrong price):
 *   • SYMBOL_MISMATCH — the mark price MUST originate from the same symbol
 *     the ladder is being planned for. Caller supplies `markSymbol` alongside
 *     `markPrice`; the venue's RAW ("BTCUSDT") and the project's dashed
 *     ("BTC-USDT") are both accepted and normalized.
 *   • STALE_MARK_PRICE — the mark price MUST carry a `markPriceAt` epoch-ms
 *     timestamp within `maxAgeMs` (default 30s). Older or missing → refuse.
 *   • INVALID_MARK_PRICE — non-finite or non-positive → refuse.
 */
import { LADDER } from "@/lib/paper/parityConstants";

export type Side = "BUY" | "SELL";

export interface PlanRung {
  index: number;
  limitPrice: number;
  /** Venue-step-rounded rung SIZE (base asset). Ruling #8 ADD1. */
  size: number;
  /** ACTUAL margin committed at this rung after size step-rounding. */
  marginUsd: number;
  /** ACTUAL notional (size * limitPrice) after step-rounding. */
  notionalUsd: number;
  /** INTENDED per-rung margin before step-rounding, for full transparency. */
  intendedMarginUsd: number;
}

export interface ManualLadderPlan {
  symbol: string;
  side: Side;
  leverage: number;
  rungCount: number;
  /** Owner target — the $60 cap. Never displayed as ACTUAL. */
  intendedTotalMargin: number;
  /** SUM of the per-rung ACTUAL committed margins. May be less than intended. */
  totalMargin: number;
  /** SUM of the per-rung ACTUAL committed notionals. */
  totalNotional: number;
  hardStopPrice: number;
  hardStopSide: Side;
  rungs: PlanRung[];
}

/** Normalize to venue RAW ("BTCUSDT"). Symbol comparisons for the ladder
 *  guard MUST route through here so "BTC-USDT" and "BTCUSDT" compare equal. */
function normalizeSymbol(s: string): string {
  return s.replace(/[-_/]/g, "").toUpperCase();
}

function clampRungs(n: number | undefined): number {
  const raw = n ?? LADDER.dca_rungs_default;
  return Math.max(LADDER.dca_rungs_min, Math.min(LADDER.dca_rungs_max, Math.floor(raw)));
}

function ladderSpanPct(leverage: number): number {
  const raw = LADDER.ladder_span_roi / Math.max(1, leverage);
  return Math.min(LADDER.ladder_span_pct_cap, raw);
}

function roundToTick(price: number, tick: number, dir: "UP" | "DOWN"): number {
  if (tick <= 0) return price;
  const n = price / tick;
  return (dir === "UP" ? Math.ceil(n) : Math.floor(n)) * tick;
}

/** Floor a base-asset size to the venue step. LIMIT rungs floor to prevent
 *  ladder-total overspend (mirror of signer's _round_down_to_step). */
function floorToStep(size: number, step: number): number {
  if (step <= 0) return size;
  return Math.floor(size / step) * step;
}

/** Max age (ms) for a mark price to be considered live for a real ladder. */
export const MARK_PRICE_MAX_AGE_MS = 30_000;

export class LadderGuardError extends Error {
  constructor(
    public code: "SYMBOL_MISMATCH" | "STALE_MARK_PRICE" | "INVALID_MARK_PRICE" | "LADDER_UNPRICEABLE",
    msg: string,
  ) {
    super(msg);
    this.name = "LadderGuardError";
  }
}

export function planManualLadder(args: {
  symbol: string;
  side: Side;
  markPrice: number;
  leverage: number;
  tickSize: number;
  /** Venue base-asset step. REQUIRED — Ruling #8 ADD1 forbids sizing without it. */
  stepSize: number;
  rungs?: number;
  markSymbol: string;
  markPriceAt: number;
  maxAgeMs?: number;
  nowMs?: number;
}): ManualLadderPlan {
  const { symbol, side, markPrice, leverage, tickSize, stepSize, markSymbol, markPriceAt } = args;

  // Hard guards — run BEFORE any arithmetic.
  const wanted = normalizeSymbol(symbol);
  const gotSym = normalizeSymbol(markSymbol);
  if (wanted !== gotSym) {
    throw new LadderGuardError(
      "SYMBOL_MISMATCH",
      `mark price belongs to ${gotSym}, not ${wanted}`,
    );
  }
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new LadderGuardError("INVALID_MARK_PRICE", `mark price ${markPrice} is not a positive finite number`);
  }
  if (!Number.isFinite(stepSize) || stepSize <= 0) {
    throw new LadderGuardError(
      "LADDER_UNPRICEABLE",
      `venue step size ${stepSize} is invalid — refusing to size ladder`,
    );
  }
  const maxAge = args.maxAgeMs ?? MARK_PRICE_MAX_AGE_MS;
  const now = args.nowMs ?? Date.now();
  if (!Number.isFinite(markPriceAt) || markPriceAt <= 0 || now - markPriceAt > maxAge) {
    throw new LadderGuardError(
      "STALE_MARK_PRICE",
      `mark price age ${now - markPriceAt}ms exceeds ${maxAge}ms`,
    );
  }

  const n = clampRungs(args.rungs);
  const intendedTotalMargin = LADDER.dca_total_margin_usd;
  const perRungRaw = intendedTotalMargin / n;
  const perRungIntended = Math.floor(perRungRaw * 1e8) / 1e8;
  const lastRungIntended = intendedTotalMargin - perRungIntended * (n - 1);

  const span = ladderSpanPct(leverage);
  const rungs: PlanRung[] = [];
  let totalNotional = 0;
  let totalMargin = 0;
  let deepestPrice = markPrice;

  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? (i / (n - 1)) * span : 0;
    const raw = side === "BUY" ? markPrice * (1 - frac) : markPrice * (1 + frac);
    const dir: "UP" | "DOWN" = side === "BUY" ? "DOWN" : "UP";
    const limitPrice = roundToTick(raw, tickSize, dir);
    const intendedMargin = i === n - 1 ? lastRungIntended : perRungIntended;
    // Ruling #8 ADD1 — size the rung on ACTUAL intended notional at the
    // rung's tick-rounded limit price, then FLOOR the base size to the
    // venue step. actual_notional and actual_margin are derived from the
    // rounded size, never from intended-margin arithmetic.
    const intendedNotional = intendedMargin * leverage;
    const rawSize = limitPrice > 0 ? intendedNotional / limitPrice : 0;
    const size = floorToStep(rawSize, stepSize);
    const actualNotional = size * limitPrice;
    const actualMargin = leverage > 0 ? actualNotional / leverage : 0;
    rungs.push({
      index: i + 1,
      limitPrice,
      size,
      marginUsd: actualMargin,
      notionalUsd: actualNotional,
      intendedMarginUsd: intendedMargin,
    });
    totalNotional += actualNotional;
    totalMargin += actualMargin;
    if (side === "BUY" ? limitPrice < deepestPrice : limitPrice > deepestPrice) {
      deepestPrice = limitPrice;
    }
  }

  // Ruling #5 mirror — the ACTUAL total must never exceed the cap.
  if (totalMargin - intendedTotalMargin > 1e-6) {
    throw new Error("LADDER_OVERSPEND");
  }

  const stopPct = LADDER.hard_stop_beyond_last_rung_pct;
  const hardStopPrice =
    side === "BUY"
      ? roundToTick(deepestPrice * (1 - stopPct), tickSize, "DOWN")
      : roundToTick(deepestPrice * (1 + stopPct), tickSize, "UP");
  const hardStopSide: Side = side === "BUY" ? "SELL" : "BUY";

  return {
    symbol,
    side,
    leverage,
    rungCount: n,
    intendedTotalMargin,
    totalMargin,
    totalNotional,
    hardStopPrice,
    hardStopSide,
    rungs,
  };
}
