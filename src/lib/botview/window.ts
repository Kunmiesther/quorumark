/**
 * Pure helpers for the Bot View "live" window: recency slice, auto-scaled
 * y-domain with flat-range guard, and target-line clamping so out-of-view
 * targets render as edge indicators.
 *
 * NO React, NO I/O — deterministic transforms, unit-tested.
 */

export type PricePoint = { t: number; close: number };

/**
 * Keep only points inside the trailing `minutes` window relative to `now`
 * (defaults to the timestamp of the last point). Always returns at least
 * the last point if the input is non-empty so the chart never blanks.
 */
export function windowRecent<T extends { t: number }>(
  series: T[],
  minutes: number,
  now?: number,
): T[] {
  if (series.length === 0) return [];
  const last = series[series.length - 1].t;
  const anchor = now ?? last;
  const cutoff = anchor - minutes * 60_000;
  const out = series.filter((p) => p.t >= cutoff);
  return out.length ? out : [series[series.length - 1]];
}

/**
 * Downsample uniformly to at most `maxPoints`, always keeping the last
 * (leading-edge live) point.
 */
export function capPoints<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const stride = arr.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * stride)]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/**
 * Auto-scaled Y domain for the visible window.
 *  - pad = max(padPct * range, minBandPct * mid) so a flat range still
 *    yields a visible band and small % moves fill the vertical space.
 *  - When all values are equal (or empty), returns a symmetric band
 *    around the value (or [0,1] if empty) — never NaN, never zero-height.
 */
export function computeYDomain(
  values: number[],
  padPct = 0.08,
  minBandPct = 0.0015,
): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  const mid = (min + max) / 2 || finite[0];
  const range = max - min;
  const pad = Math.max(range * padPct, Math.abs(mid) * minBandPct);
  min = min - pad;
  max = max + pad;
  if (min === max) {
    const eps = Math.max(Math.abs(mid) * minBandPct, 1e-8);
    return [min - eps, max + eps];
  }
  return [min, max];
}

/**
 * Exponential ease of a numeric domain toward `target`. Returns the new
 * eased domain; caller stores it. `alpha` in (0..1] — higher snaps faster.
 */
export function easeDomain(
  prev: [number, number] | null,
  target: [number, number],
  alpha = 0.35,
): [number, number] {
  if (!prev) return target;
  return [
    prev[0] + (target[0] - prev[0]) * alpha,
    prev[1] + (target[1] - prev[1]) * alpha,
  ];
}

export type ClampedTarget = {
  price: number;      // clamped-to-edge y for rendering
  original: number;
  inView: boolean;
  side: "above" | "below" | null; // set when clamped
};

/** Clamp a target price to the visible y-domain. */
export function clampTargetToDomain(
  price: number,
  domain: [number, number],
): ClampedTarget {
  const [lo, hi] = domain;
  if (!Number.isFinite(price)) return { price: lo, original: price, inView: false, side: null };
  if (price > hi) return { price: hi, original: price, inView: false, side: "above" };
  if (price < lo) return { price: lo, original: price, inView: false, side: "below" };
  return { price, original: price, inView: true, side: null };
}
