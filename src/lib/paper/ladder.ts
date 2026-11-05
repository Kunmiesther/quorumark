/**
 * LADDERED LIMIT-MAKER ENTRY — pure math.
 *
 * Every entry becomes N=DCA_RUNGS limit-maker rungs stepping AGAINST the
 * position, but the full ladder spans only ~LADDER_SPAN_ROI worth of
 * MARGIN ROI, not per-rung. At 50–100× leverage a 2% adverse price move is
 * already ~100–200% of margin, so the entire ladder must fit inside ~2% of
 * price total — never more.
 *
 * SPAN MODEL (leverage-aware, total across the ladder):
 *   span_pct = min(0.02, LADDER_SPAN_ROI / leverage)    -- LADDER_SPAN_ROI=1.0
 *   rung k in 1..N fills at:
 *     long  : first × (1 − (k−1)/(N−1) × span_pct)
 *     short : first × (1 + (k−1)/(N−1) × span_pct)
 *
 * Example (short, first fill 100, 50× → span 2%): 100.00, 100.67, 101.33, 102.00.
 * Margin per rung is supplied by the caller (qty scales with rung price).
 *
 * Sim fill model: a pending rung fills when the candle LOW (long) / HIGH
 * (short) reaches the rung price, at the EXACT rung price with NO entry
 * slippage and a MAKER fee. Only MARKET EXITS keep taker fee + slippage.
 */
import type { Direction } from "./signal";

/** Legacy ladder fallback tunables (cross-margin paper only).
 *
 * New campaigns do not size here. `walletCampaignSizing.ts` owns the active
 * rule: 5% of the destination wallet's settled balance across five rungs.
 * These fixed-dollar helpers remain only for reconstructing older rows that
 * lack persisted rung margin data.
 */
import { LADDER as _L } from "./parityConstants";
export const DCA_TOTAL_MARGIN_USD = _L.dca_total_margin_usd;
export const DCA_RUNGS_MIN = _L.dca_rungs_min;
export const DCA_RUNGS_MAX = _L.dca_rungs_max;
export const DCA_RUNGS = _L.dca_rungs_default;
export const DCA_RUNG_MARGIN_USD = DCA_TOTAL_MARGIN_USD / DCA_RUNGS;

/** Legacy reconstruction rung count. Shared parity currently fixes it at 5. */
export function dcaRungsForLeverage(leverage: number): number {
  const lev = leverage > 0 ? leverage : 1;
  const raw = Math.round(lev / 12.5);
  return Math.min(DCA_RUNGS_MAX, Math.max(DCA_RUNGS_MIN, raw));
}

/** Legacy reconstruction margin. Never use for a new campaign. */
export function dcaMarginPerRungForLeverage(leverage: number): number {
  return DCA_TOTAL_MARGIN_USD / dcaRungsForLeverage(leverage);
}

/**
 * TOTAL adverse margin ROI the full ladder is allowed to span, before
 * being converted to a price % by dividing by leverage. 1.0 = 100% of one
 * rung's margin — the whole ladder sits inside a ~2% price move at 50×,
 * ~1% at 100×, and is CAPPED at 2% for anything below 50× so we never
 * ladder into a 6% expected drawdown.
 */
export const LADDER_SPAN_ROI = _L.ladder_span_roi;
export const LADDER_SPAN_PCT_CAP = _L.ladder_span_pct_cap;

/** Total ladder span as a fraction of price, leverage-aware and capped. */
export function ladderSpanPct(leverage: number): number {
  const lev = leverage > 0 ? leverage : 1;
  return Math.min(LADDER_SPAN_PCT_CAP, LADDER_SPAN_ROI / lev);
}

/**
 * PER-LOT take-profit offset. Every filled rung gets its OWN TP at this
 * percentage above (long) / below (short) its own fill price. Rungs scale
 * out INDEPENDENTLY as the market runs, locking in profit progressively.
 *
 * Default 0.01 = 1% price move. At TARGET_LEVERAGE=100x that ≈ 100% margin
 * ROI per rung — a solid partial bank. Tunable up to ~0.02 (2%) for a
 * larger per-rung swing target.
 */
export const DCA_RUNG_TP_PCT = _L.dca_rung_tp_pct;
export const MAKER_BPS = 0;
export const MAKER_FEE_RATE = MAKER_BPS / 10_000;

/**
 * STRATEGY HARD STOP CONTRACT (owner-ratified addendum).
 *
 * The strategy hard stop is NOT armed until every planned rung has filled.
 * While the ladder is incomplete the ONLY forced-close paths are (a) the
 * per-rung +1% take-profit on filled lots, (b) confirmed Scout BOS routed
 * through Onyx, (c) cross-margin liquidation protection, and (d) the
 * account-wide kill switch. Pending rungs themselves are the planned
 * adverse-price actions before the deepest rung.
 *
 * Once the LAST rung fills, arm the hard stop exactly
 * `HARD_STOP_BEYOND_LAST_RUNG_PCT` beyond that rung's ACTUAL fill price
 * (never the initial entry, never the VWAP). Long stops sit below,
 * short stops sit above.
 */
export const HARD_STOP_BEYOND_LAST_RUNG_PCT = _L.hard_stop_beyond_last_rung_pct;

/**
 * Compute the armed hard-stop price given the deepest (last) rung's fill
 * price. Returns `null` when the ladder is not yet fully filled — callers
 * MUST treat `null` as "no strategy hard stop", not as "close now".
 */
export function armedHardStopLevel(
  direction: Direction,
  filledRungCount: number,
  totalPlannedRungs: number,
  lastRungFillPx: number | null | undefined,
): number | null {
  if (!(totalPlannedRungs > 0)) return null;
  if (filledRungCount < totalPlannedRungs) return null;
  const px = Number(lastRungFillPx);
  if (!(px > 0)) return null;
  return direction === "long"
    ? px * (1 - HARD_STOP_BEYOND_LAST_RUNG_PCT)
    : px * (1 + HARD_STOP_BEYOND_LAST_RUNG_PCT);
}

/** Arming is a campaign event, not a count of lots still open after profit-taking. */
export function resolveCampaignHardStop(input: {
  direction: Direction;
  armedStopPrice?: number | string | null;
  armedAt?: string | null;
  stopLevel?: number | string | null;
  finalRungFillPrice?: number | string | null;
  filledRungCount: number;
  totalPlannedRungs: number;
  deepestOpenFillPrice: number | null;
}): number | null {
  const positive = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Persisted arming takes precedence; never re-anchor to a shallower lot.
  const saved = positive(input.armedStopPrice);
  if (saved != null) return saved;
  if (input.armedAt) {
    const legacyStop = positive(input.stopLevel);
    if (legacyStop != null) return legacyStop;
  }
  return armedHardStopLevel(
    input.direction,
    input.filledRungCount,
    input.totalPlannedRungs,
    positive(input.finalRungFillPrice) ?? input.deepestOpenFillPrice,
  );
}

/**
 * A ladder rung — both pending and filled. `margin` is the margin committed
 * to this rung. `tp` is the per-lot
 * take-profit price computed at build time: rung.price × (1 ± DCA_RUNG_TP_PCT).
 * Both fields are carried through the paper_positions.fills / pending_rungs
 * JSON so partial-reduce accounting works with no extra lookup.
 */
export interface Rung {
  price: number;
  qty: number;
  margin: number;
  tp: number;
}

/** Per-lot TP price given the fill price and direction. */
export function rungTpPrice(fillPx: number, direction: Direction): number {
  return direction === "long" ? fillPx * (1 + DCA_RUNG_TP_PCT) : fillPx * (1 - DCA_RUNG_TP_PCT);
}

/**
 * Build the full ladder for a signal using the leverage-aware TOTAL-SPAN
 * model. Rung 1 sits at `signalPx`; rungs 2..N step evenly against the
 * position so the deepest rung sits `ladderSpanPct(leverage)` away from
 * rung 1. qty per rung = (marginPerRung × leverage) / rung_price so each
 * rung commits the same margin. Each rung also carries its per-lot `tp`
 * at DCA_RUNG_TP_PCT above (long) / below (short) its own fill.
 * The `atr` param is retained for backward-compatible call sites but is
 * IGNORED under the span model.
 */
export function buildLadder(
  direction: Direction,
  signalPx: number,
  _atr: number | null | undefined,
  leverage: number,
  marginPerRung: number,
  rungs: number = DCA_RUNGS,
): Rung[] {
  void _atr;
  const n = Math.max(1, Math.floor(rungs));
  const span = ladderSpanPct(leverage);
  const denom = n > 1 ? n - 1 : 1;
  const out: Rung[] = [];
  for (let i = 0; i < n; i++) {
    const frac = (i / denom) * span; // 0 at rung 1, `span` at rung N
    const price = direction === "long" ? signalPx * (1 - frac) : signalPx * (1 + frac);
    if (!(price > 0)) break;
    const qty = (marginPerRung * leverage) / price;
    out.push({ price, qty, margin: marginPerRung, tp: rungTpPrice(price, direction) });
  }
  return out;
}

/** Deepest rung price = hard stop anchor. Long: min rung; short: max rung. */
export function deepestRungPrice(rungs: readonly Rung[], direction: Direction): number {
  if (rungs.length === 0) return 0;
  let x = rungs[0].price;
  for (const r of rungs) {
    if (direction === "long") {
      if (r.price < x) x = r.price;
    } else {
      if (r.price > x) x = r.price;
    }
  }
  return x;
}

/** Sum of qty × price across rungs — used for the entry-time heat check. */
export function ladderNotional(rungs: readonly Rung[]): number {
  let s = 0;
  for (const r of rungs) s += r.qty * r.price;
  return s;
}

/** Sum of qty across rungs. */
export function ladderQty(rungs: readonly Rung[]): number {
  let s = 0;
  for (const r of rungs) s += r.qty;
  return s;
}

/**
 * Given the newest candle high/low, return which pending rungs would fill.
 * Long: any rung with price >= low fills at rung.price. Short: any rung
 * with price <= high fills at rung.price. Order is preserved.
 */
export function pendingRungsHitByCandle(
  pending: readonly Rung[],
  direction: Direction,
  candleLow: number,
  candleHigh: number,
): { filled: Rung[]; stillPending: Rung[] } {
  const filled: Rung[] = [];
  const stillPending: Rung[] = [];
  for (const r of pending) {
    const touched = direction === "long" ? r.price >= candleLow : r.price <= candleHigh;
    if (touched) filled.push(r);
    else stillPending.push(r);
  }
  return { filled, stillPending };
}
