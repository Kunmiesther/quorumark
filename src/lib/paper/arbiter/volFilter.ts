/**
 * Module 4 — Volatility filter.
 *
 * Skip NEW pair entries on a symbol when its 5m ATR% is in the top decile
 * of trailing 24 hours. Existing pairs are not force-closed by this filter
 * — Module 1's exit logic manages them.
 *
 * "Top decile" = 90th percentile threshold (config: vol_filter_atr_pct_decile).
 * ATR% supplied by the caller (engine already computes 5m ATR per symbol).
 */
import { ARBITER } from "../parityConstants";

export const VOL_FILTER_DECILE: number = ARBITER.vol_filter_atr_pct_decile;

/**
 * Deterministic quantile: sort ascending, linear interpolation. Returns
 * NaN when the sample is empty.
 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface VolFilterInputs {
  currentAtrPct: number;
  /** trailing 24h series of ATR%. Length may be <= 288 (24h × 12 buckets). */
  trailingAtrPct: number[];
  decile?: number;
}

export interface VolFilterVerdict {
  skip: boolean;
  threshold: number;
  reason?: "arbiter_vol_skip";
}

export function shouldSkipOnVolatility(inp: VolFilterInputs): VolFilterVerdict {
  const decile = inp.decile ?? VOL_FILTER_DECILE;
  if (inp.trailingAtrPct.length === 0 || !Number.isFinite(inp.currentAtrPct)) {
    return { skip: false, threshold: NaN };
  }
  const threshold = quantile(inp.trailingAtrPct, decile);
  if (inp.currentAtrPct >= threshold) {
    return { skip: true, threshold, reason: "arbiter_vol_skip" };
  }
  return { skip: false, threshold };
}
