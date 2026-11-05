/**
 * H2 MID-WEIGHTED PYRAMID SWEEP-DCA — deterministic sizing/exit math.
 *
 * PURE. No I/O. Constants sourced from shared/mainnet_parity_constants.json
 * ("sweep" block). Bit-identical companion: sweep_h2.py.
 *
 * GEOMETRY (owner-ratified 2026-07-27, backtested variant H2):
 *   - Flush zone extends `flush_zone_atr` × ATR(1h) beyond the swept level.
 *     For a LONG (sweep-low): zone extends BELOW the level (dip-buy).
 *     For a SHORT (sweep-high): zone extends ABOVE the level (rip-sell).
 *   - Three limit rungs at fill_depth_fracs of the zone: [0.0, 0.5, 1.0]
 *     (level-touch, mid-zone, zone-edge).
 *   - Margin split fill_weights (sixths): [1, 3, 2] = mid-weighted pyramid.
 *   - One hard stop at zone_edge + stop_beyond_edge_atr × ATR(1h) beyond edge.
 *   - Exits: scaled TP tiers at avg_entry ± rr × R where R = |avg_entry − stop|,
 *     with `frac` of CURRENT total qty closed at each tier. Tiers: 50% @ 1.75R,
 *     30% @ 2.0R, 20% @ 2.5R. Remainder at hard stop or timeout_bars_1h.
 *
 * ORDER OF OPERATIONS is fixed and mirrored in Python — do NOT reorder without
 * updating sweep_h2.py in lockstep, or parity fixtures break.
 *   q_i          = (margin_i × leverage) / price_i
 *   totalQty     = Σ q_i
 *   avg_entry    = (totalMargin × leverage) / totalQty      // == Σ(q_i·p_i)/Σq_i
 *   R            = |avg_entry − stop|
 *   tp_price     = avg_entry + tp_dir × rr × R
 */
import { PARITY } from "./parityConstants";

export type SweepSide = "long" | "short";

interface SweepH2Cfg {
  fill_depth_fracs: number[];
  fill_weights: number[];
  flush_zone_atr: number;
  stop_beyond_edge_atr: number;
  tp_tiers: Array<{ frac: number; rr: number; label: string }>;
  timeout_bars_1h: number;
  htf_alignment_required: boolean;
  max_concurrent_ladders: number;
}
const SWEEP_H2 = (PARITY as unknown as { sweep: SweepH2Cfg }).sweep;

export const SWEEP_H2_FILL_DEPTH_FRACS = SWEEP_H2.fill_depth_fracs;
export const SWEEP_H2_FILL_WEIGHTS = SWEEP_H2.fill_weights;
export const SWEEP_H2_FLUSH_ZONE_ATR = SWEEP_H2.flush_zone_atr;
export const SWEEP_H2_STOP_BEYOND_EDGE_ATR = SWEEP_H2.stop_beyond_edge_atr;
export const SWEEP_H2_TP_TIERS = SWEEP_H2.tp_tiers;
export const SWEEP_H2_TIMEOUT_BARS_1H = SWEEP_H2.timeout_bars_1h;
export const SWEEP_H2_HTF_ALIGNMENT_REQUIRED = SWEEP_H2.htf_alignment_required;
export const SWEEP_H2_MAX_CONCURRENT_LADDERS = SWEEP_H2.max_concurrent_ladders;

export interface H2Rung {
  index: number;         // 0-indexed rung id
  price: number;         // limit fill price
  marginUsd: number;     // margin allocated
  weight: number;        // raw weight (in sixths)
  qty: number;           // qty at this price given leverage
  depthFrac: number;     // 0.0 / 0.5 / 1.0
}

export interface H2Ladder {
  side: SweepSide;
  level: number;
  atr1h: number;
  leverage: number;
  totalMarginUsd: number;
  zoneEdgePrice: number;
  stopPrice: number;
  rungs: H2Rung[];
}

export interface H2Tier {
  index: number;
  label: string;
  frac: number;
  rr: number;
  price: number;
  qty: number;
}

export interface H2Fill {
  price: number;
  qty: number;
  marginUsd: number;
}

/** Directional sign: +1 = above level, −1 = below level. */
function edgeDir(side: SweepSide): 1 | -1 {
  return side === "long" ? -1 : 1;
}

/** Compute the three-rung H2 ladder plus its hard stop. Deterministic. */
export function computeH2Ladder(args: {
  side: SweepSide;
  level: number;
  atr1h: number;
  leverage: number;
  totalMarginUsd: number;
}): H2Ladder {
  const { side, level, atr1h, leverage, totalMarginUsd } = args;
  if (!(atr1h > 0)) throw new Error("computeH2Ladder: atr1h must be > 0");
  if (!(leverage > 0)) throw new Error("computeH2Ladder: leverage must be > 0");
  if (!(totalMarginUsd > 0)) throw new Error("computeH2Ladder: totalMarginUsd must be > 0");

  const fracs = SWEEP_H2_FILL_DEPTH_FRACS;
  const weights = SWEEP_H2_FILL_WEIGHTS;
  if (fracs.length !== weights.length) {
    throw new Error("computeH2Ladder: fill_depth_fracs and fill_weights must be same length");
  }
  const dir = edgeDir(side);
  const zoneEdgePrice = level + dir * SWEEP_H2_FLUSH_ZONE_ATR * atr1h;
  const stopPrice = zoneEdgePrice + dir * SWEEP_H2_STOP_BEYOND_EDGE_ATR * atr1h;

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const rungs: H2Rung[] = fracs.map((f, i) => {
    const w = weights[i];
    const marginUsd = totalMarginUsd * (w / totalWeight);
    const price = level + dir * f * SWEEP_H2_FLUSH_ZONE_ATR * atr1h;
    const qty = (marginUsd * leverage) / price;
    return { index: i, price, marginUsd, weight: w, qty, depthFrac: f };
  });

  return { side, level, atr1h, leverage, totalMarginUsd, zoneEdgePrice, stopPrice, rungs };
}

/**
 * VWAP over filled units. Order-of-operations pinned:
 *   avgEntry = totalNotional / totalQty
 * where totalNotional is Σ (margin_i × leverage), the sum-of-notionals, and
 * totalQty is Σ q_i. Passing raw fills instead of ladder rungs so partial
 * fills and rung-order variations are supported.
 */
export function recomputeAvgEntry(fills: H2Fill[], leverage: number): {
  totalQty: number;
  totalNotional: number;
  totalMarginUsd: number;
  avgEntry: number;
} {
  if (fills.length === 0) {
    return { totalQty: 0, totalNotional: 0, totalMarginUsd: 0, avgEntry: 0 };
  }
  let totalQty = 0;
  let totalMarginUsd = 0;
  for (const f of fills) {
    totalQty += f.qty;
    totalMarginUsd += f.marginUsd;
  }
  const totalNotional = totalMarginUsd * leverage;
  const avgEntry = totalQty > 0 ? totalNotional / totalQty : 0;
  return { totalQty, totalNotional, totalMarginUsd, avgEntry };
}

/**
 * Compute TP tiers off a given avg entry / stop. Tier qty = totalQty × frac
 * (frac is a fraction of CURRENT total qty at the time of tier arming; the
 * caller decides whether to recompute after a partial fill or after a partial
 * close). Direction-signed tier price.
 */
export function computeH2Tiers(args: {
  side: SweepSide;
  avgEntry: number;
  stopPrice: number;
  totalQty: number;
}): { R: number; tiers: H2Tier[] } {
  const { side, avgEntry, stopPrice, totalQty } = args;
  const R = Math.abs(avgEntry - stopPrice);
  const tpDir = side === "long" ? 1 : -1;
  const tiers: H2Tier[] = SWEEP_H2_TP_TIERS.map((t, i) => ({
    index: i,
    label: t.label,
    frac: t.frac,
    rr: t.rr,
    price: avgEntry + tpDir * t.rr * R,
    qty: totalQty * t.frac,
  }));
  return { R, tiers };
}

/**
 * True if a limit rung at `price` should be filled by the given bar
 * (touched-through semantics on 1h bars: qualifying bar low ≤ price for long,
 * bar high ≥ price for short). Rungs above/below the current bar's range are
 * considered untouched.
 */
export function rungIsFilled(
  side: SweepSide,
  price: number,
  bar: { high: number; low: number },
): boolean {
  return side === "long" ? bar.low <= price : bar.high >= price;
}

/**
 * True if a TP tier at `price` was reached by the given bar (touched-through).
 * Long tier is above avg entry — filled when high ≥ price. Short vice versa.
 */
export function tierIsHit(
  side: SweepSide,
  price: number,
  bar: { high: number; low: number },
): boolean {
  return side === "long" ? bar.high >= price : bar.low <= price;
}

/** True if hard stop was breached by the given bar. */
export function stopIsHit(
  side: SweepSide,
  stopPrice: number,
  bar: { high: number; low: number },
): boolean {
  return side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
}
