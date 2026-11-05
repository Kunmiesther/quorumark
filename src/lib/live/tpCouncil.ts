/**
 * DEFERRED TAKE-PROFIT — COUNCIL REVIEW AFTER 3 FULLY CLOSED CANDLES.
 *
 * Owner directive (2026-08-04): Turtle Bot NEVER attaches or submits a
 * take-profit at entry. The entry carries its protective STOP and nothing
 * else. Take-profit is a LATER, SEPARATE, reduce-only decision made by the
 * council once exactly three fully closed execution-timeframe candles have
 * printed after the fill.
 *
 * PURE MODULE. No IO, no Supabase, no venue calls — every rule here is
 * deterministic and unit-tested (`__tests__/tpCouncil.test.ts`). The server
 * orchestrator (`tpCouncil.server.ts`) owns all side effects.
 *
 * NON-NEGOTIABLE INVARIANTS ENCODED HERE
 *   * Candle counting is candle-close based, NEVER wall-clock elapsed time.
 *   * The partially formed candle containing the fill is never counted.
 *   * Every submitted TP/exit is reduce-only, direction-safe, tick/step
 *     aligned, and never larger than the reconciled venue position size.
 *   * A council failure/timeout degrades to HOLD_WITHOUT_TP with another
 *     scheduled review. Stop protection is not assumed by this module.
 */

export const TP_STATES = [
  "PENDING_COUNCIL_REVIEW",
  "REVIEW_IN_PROGRESS",
  "TP_SET",
  "PARTIAL_TP_SET",
  "HOLD_WITHOUT_TP",
  "TRAILING",
  "EXIT_SUBMITTED",
  "CLOSED",
] as const;
export type TpState = (typeof TP_STATES)[number];

export const COUNCIL_DECISIONS = [
  "SET_TP",
  "PARTIAL_TP",
  "HOLD_WITHOUT_TP",
  "TRAIL",
  "EXIT_NOW",
] as const;
export type CouncilDecision = (typeof COUNCIL_DECISIONS)[number];

/** Decisions that submit an order and therefore require price/size proof. */
export const ORDER_ACTIONS: ReadonlySet<CouncilDecision> = new Set<CouncilDecision>([
  "SET_TP",
  "PARTIAL_TP",
  "EXIT_NOW",
]);

/** Candles that must fully close before the FIRST council review. */
export const REQUIRED_CLOSED_CANDLES = 3;
/** Candles before the next review when the council holds without a TP. */
export const HOLD_RECHECK_CANDLES = 1;

export const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function timeframeMs(tf: string): number {
  const ms = TIMEFRAME_MS[tf];
  if (!ms) throw new Error(`UNSUPPORTED_TIMEFRAME:${tf}`);
  return ms;
}

/**
 * Number of FULLY CLOSED candles printed strictly after the fill.
 *
 * The candle in progress when the fill landed is partially formed relative
 * to the fill and is NEVER counted. If a fill lands at 10:02:30 on 5m, the
 * 10:00–10:05 candle does not count; the first counted close is 10:10.
 */
export function closedCandlesSince(fillMs: number, nowMs: number, tfMs: number): number {
  if (!Number.isFinite(fillMs) || !Number.isFinite(nowMs) || tfMs <= 0) return 0;
  const fillCandleClose = Math.floor(fillMs / tfMs) * tfMs + tfMs;
  const firstCountedClose = fillCandleClose + tfMs;
  if (nowMs < firstCountedClose) return 0;
  return Math.floor((nowMs - firstCountedClose) / tfMs) + 1;
}

/** Wall-clock instant at which the Nth counted candle close occurs. */
export function reviewDueAtMs(fillMs: number, tfMs: number, candles: number): number {
  const fillCandleClose = Math.floor(fillMs / tfMs) * tfMs + tfMs;
  return fillCandleClose + candles * tfMs;
}

export interface CandleProgress {
  closed: number;
  required: number;
  due: boolean;
  dueAtMs: number;
  label: string;
}

export function candleProgress(
  fillMs: number,
  nowMs: number,
  timeframe: string,
  required: number = REQUIRED_CLOSED_CANDLES,
): CandleProgress {
  const tfMs = timeframeMs(timeframe);
  const closedRaw = closedCandlesSince(fillMs, nowMs, tfMs);
  const closed = Math.min(closedRaw, required);
  return {
    closed,
    required,
    due: closedRaw >= required,
    dueAtMs: reviewDueAtMs(fillMs, tfMs, required),
    label: `${closed}/${required}`,
  };
}

/**
 * Idempotency key for one review of one position. The orchestrator inserts a
 * row keyed on this; a unique-violation means the review already ran (or is
 * running) and the caller must NOT re-run the council or re-submit a TP.
 * Restart-safe by construction: the key is derived only from durable facts.
 */
export function reviewKey(positionId: string, reviewSeq: number): string {
  return `tpc:${positionId}:${reviewSeq}`;
}

// --- Venue-safe TP / exit validation ------------------------------------

export interface TpValidationInput {
  /** Position direction. */
  side: "long" | "short";
  /** Requested limit price for the reduce-only order. */
  price: number;
  /** Current mark, used for direction sanity. */
  markPrice: number;
  /** Size reconciled from the VENUE, not from our database. */
  positionSize: number;
  /** Requested exit size (<= positionSize). */
  size: number;
  tickSize: number;
  stepSize: number;
  minOrderSize?: number;
  minNotional?: number;
}

export type TpValidation =
  | { ok: true; price: string; size: string; reduceOnly: true; side: "BUY" | "SELL" }
  | { ok: false; reason: TpRejectReason };

export type TpRejectReason =
  | "NO_POSITION"
  | "SIZE_NOT_POSITIVE"
  | "SIZE_EXCEEDS_POSITION"
  | "PRICE_NOT_POSITIVE"
  | "WRONG_DIRECTION"
  | "BELOW_MIN_SIZE"
  | "BELOW_MIN_NOTIONAL"
  | "BAD_VENUE_METADATA";

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function quantize(value: number, step: number, dir: "up" | "down"): number {
  const n = value / step;
  const q = dir === "up" ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return Number((q * step).toFixed(decimalsOf(step) + 8));
}

/**
 * Direction-safe, venue-safe reduce-only TP/exit validation.
 *
 * A LONG exits with SELL above mark; a SHORT exits with BUY below mark. A
 * price on the wrong side of mark would fill instantly as a loss-taking
 * market order — refused, not silently corrected. Price quantization rounds
 * AWAY from mark so a tick-aligned TP is never worse than the approved one;
 * size floors onto the step grid so the exit can never exceed the position.
 */
export function validateTpOrder(input: TpValidationInput): TpValidation {
  const { side, price, markPrice, positionSize, size, tickSize, stepSize } = input;
  if (!(tickSize > 0) || !(stepSize > 0)) return { ok: false, reason: "BAD_VENUE_METADATA" };
  if (!(positionSize > 0)) return { ok: false, reason: "NO_POSITION" };
  if (!(size > 0)) return { ok: false, reason: "SIZE_NOT_POSITIVE" };
  if (size > positionSize + 1e-12) return { ok: false, reason: "SIZE_EXCEEDS_POSITION" };
  if (!(price > 0) || !Number.isFinite(price)) return { ok: false, reason: "PRICE_NOT_POSITIVE" };
  if (!(markPrice > 0)) return { ok: false, reason: "BAD_VENUE_METADATA" };

  const exitSide: "BUY" | "SELL" = side === "long" ? "SELL" : "BUY";
  if (side === "long" && price <= markPrice) return { ok: false, reason: "WRONG_DIRECTION" };
  if (side === "short" && price >= markPrice) return { ok: false, reason: "WRONG_DIRECTION" };

  const qPrice = quantize(price, tickSize, side === "long" ? "up" : "down");
  if (side === "long" && qPrice <= markPrice) return { ok: false, reason: "WRONG_DIRECTION" };
  if (side === "short" && qPrice <= 0) return { ok: false, reason: "PRICE_NOT_POSITIVE" };
  if (side === "short" && qPrice >= markPrice) return { ok: false, reason: "WRONG_DIRECTION" };

  const qSize = Math.min(
    quantize(size, stepSize, "down"),
    quantize(positionSize, stepSize, "down"),
  );
  if (!(qSize > 0)) return { ok: false, reason: "SIZE_NOT_POSITIVE" };
  if (input.minOrderSize !== undefined && qSize < input.minOrderSize) {
    return { ok: false, reason: "BELOW_MIN_SIZE" };
  }
  if (input.minNotional !== undefined && qSize * qPrice < input.minNotional) {
    return { ok: false, reason: "BELOW_MIN_NOTIONAL" };
  }

  return {
    ok: true,
    price: qPrice.toFixed(decimalsOf(tickSize)),
    size: qSize.toFixed(decimalsOf(stepSize)),
    reduceOnly: true,
    side: exitSide,
  };
}

// --- Decision plumbing ---------------------------------------------------

export interface CouncilOutcome {
  decision: CouncilDecision;
  /** Absolute price for SET_TP / PARTIAL_TP / TRAIL activation. */
  price?: number;
  /** Fraction of the position to close for PARTIAL_TP (0 < f <= 1). */
  sizeFraction?: number;
  /** Trailing distance in percent for TRAIL. */
  trailPct?: number;
  rationale: string;
  degraded?: boolean;
}

/**
 * Deterministic fallback when the council times out, errors, or returns an
 * unparsable answer. HOLD is the only safe default: it submits no order and
 * guarantees another review after the next fully closed candle. Venue stop
 * protection must be verified separately and cannot be inferred from HOLD.
 */
export function fallbackOutcome(reason: string): CouncilOutcome {
  return {
    decision: "HOLD_WITHOUT_TP",
    rationale: `Council unavailable (${reason}); no order submitted. Re-review after the next closed candle. Verify protective stop status on the venue.`,
    degraded: true,
  };
}

/** Candles that must close before the next review, given a decision. */
export function nextReviewCandles(decision: CouncilDecision): number | null {
  switch (decision) {
    case "HOLD_WITHOUT_TP":
    case "TRAIL":
    case "PARTIAL_TP":
      return HOLD_RECHECK_CANDLES;
    case "SET_TP":
      return HOLD_RECHECK_CANDLES;
    case "EXIT_NOW":
      return null; // position is closing; nothing left to manage
  }
}

/** Terminal-ish TP state produced by a decision once its order is accepted. */
export function stateForDecision(decision: CouncilDecision): TpState {
  switch (decision) {
    case "SET_TP":
      return "TP_SET";
    case "PARTIAL_TP":
      return "PARTIAL_TP_SET";
    case "TRAIL":
      return "TRAILING";
    case "EXIT_NOW":
      return "EXIT_SUBMITTED";
    case "HOLD_WITHOUT_TP":
      return "HOLD_WITHOUT_TP";
  }
}

export function isCouncilDecision(v: unknown): v is CouncilDecision {
  return typeof v === "string" && (COUNCIL_DECISIONS as readonly string[]).includes(v);
}

/** Customer-facing banner copy for the Trade Desk. */
export function tpStatusLabel(state: TpState, progress: CandleProgress): string {
  switch (state) {
    case "PENDING_COUNCIL_REVIEW":
      return `TP/EXIT PENDING — COUNCIL REVIEW ${progress.label}`;

    case "REVIEW_IN_PROGRESS":
      return "COUNCIL REVIEW IN PROGRESS";
    case "TP_SET":
      return "TP SET — REDUCE-ONLY ORDER LIVE";
    case "PARTIAL_TP_SET":
      return "PARTIAL TP SET — REDUCE-ONLY ORDER LIVE";
    case "HOLD_WITHOUT_TP":
      return `HOLD WITHOUT TP — RE-REVIEW AFTER NEXT CLOSED CANDLE (${progress.label})`;
    case "TRAILING":
      return "TRAILING MANAGEMENT ACTIVE";
    case "EXIT_SUBMITTED":
      return "EXIT SUBMITTED — REDUCE-ONLY CLOSE";
    case "CLOSED":
      return "POSITION CLOSED";
  }
}
