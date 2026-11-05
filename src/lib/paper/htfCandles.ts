/**
 * Higher-timeframe (1h) candle aggregation from the 5m OHLCV array the paper
 * engine already holds per symbol.
 *
 * PURE — no I/O, no fetches. Input is the same `Candle[]` produced by
 * `feed.candles` in `runPaperTick`. Twelve 5m candles per 1h bucket, aligned
 * to the UTC hour boundary. Incomplete trailing hour is EXCLUDED. Gaps: if a
 * bucket has 1..11 candles it is still emitted with `partial: true`; consumers
 * (e.g. htfBos) MUST drop partial candles before applying signal logic.
 *
 * Phase 1: telemetry-only. Promotion/trailing logic lands in Phase 3.
 */
import type { Candle } from "./signal";
import { TS, OPEN, HIGH, LOW, CLOSE, VOLUME } from "./signal";

/** Milliseconds in one hour. */
export const HOUR_MS = 60 * 60 * 1000;
/** Milliseconds in one 15m bucket. */
export const FIFTEEN_MIN_MS = 15 * 60 * 1000;
/** Milliseconds in one 4h bucket. */
export const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
/** Expected number of 5m candles inside one complete 1h bucket. */
export const CANDLES_PER_HOUR = 12;
/** Expected number of 5m candles inside one complete 15m bucket. */
export const CANDLES_PER_15M = 3;
/** Expected number of 5m candles inside one complete 4h bucket. */
export const CANDLES_PER_4H = 48;


export interface HtfCandle {
  /** Base OHLCV tuple — same shape as `Candle` (ts_ms = bucket start). */
  candle: Candle;
  /** True if the bucket has fewer than 12 constituent 5m candles. */
  partial: boolean;
  /** Actual number of 5m candles folded into this bucket (1..12). */
  count: number;
}

/** Floor an epoch-ms timestamp to its UTC hour boundary. */
export function hourStart(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS) * HOUR_MS;
}

/**
 * Aggregate 5m candles into 1h buckets aligned to the UTC hour boundary.
 *
 * - OHLC: first-open, max-high, min-low, last-close by ts order inside bucket.
 * - Volume: summed.
 * - The currently-forming (incomplete trailing) hour is EXCLUDED. A bucket is
 *   considered "currently forming" when its start >= hourStart(newestTs)
 *   (the newest 5m candle still falls inside it).
 * - Buckets with fewer than CANDLES_PER_HOUR constituents are emitted with
 *   `partial: true` (gap surfacing); consumers must drop partials before
 *   applying detection.
 * - Output is sorted ascending by bucket start.
 */
export function aggregate1h(candles: Candle[]): HtfCandle[] {
  if (!candles.length) return [];
  // Group by hour bucket start
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const bucket = hourStart(c[TS]);
    let arr = buckets.get(bucket);
    if (!arr) { arr = []; buckets.set(bucket, arr); }
    arr.push(c);
  }
  // Exclude the still-forming trailing hour (contains newest 5m candle).
  const newestTs = candles[candles.length - 1][TS];
  const formingBucket = hourStart(newestTs);
  buckets.delete(formingBucket);

  const out: HtfCandle[] = [];
  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);
  for (const start of sortedStarts) {
    const group = buckets.get(start)!;
    group.sort((x, y) => x[TS] - y[TS]);
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of group) {
      if (c[HIGH] > hi) hi = c[HIGH];
      if (c[LOW] < lo) lo = c[LOW];
      vol += c[VOLUME];
    }
    const first = group[0];
    const last = group[group.length - 1];
    const folded: Candle = [start, first[OPEN], hi, lo, last[CLOSE], vol];
    out.push({
      candle: folded,
      partial: group.length < CANDLES_PER_HOUR,
      count: group.length,
    });
  }
  return out;
}

/** Convenience: drop partial buckets and return the raw Candle array. */
export function completed1h(htf: HtfCandle[]): Candle[] {
  return htf.filter((h) => !h.partial).map((h) => h.candle);
}

/** Floor an epoch-ms timestamp to its 15m boundary. */
export function fifteenMinStart(tsMs: number): number {
  return Math.floor(tsMs / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
}

/**
 * Aggregate 5m candles into 15m buckets aligned to the UTC 15m boundary.
 * Same rules as `aggregate1h`. Used by the Sweep leg (entry TF = 15m).
 */
export function aggregate15m(candles: Candle[]): HtfCandle[] {
  if (!candles.length) return [];
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const b = fifteenMinStart(c[TS]);
    let arr = buckets.get(b);
    if (!arr) { arr = []; buckets.set(b, arr); }
    arr.push(c);
  }
  const newestTs = candles[candles.length - 1][TS];
  const forming = fifteenMinStart(newestTs);
  buckets.delete(forming);

  const out: HtfCandle[] = [];
  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);
  for (const start of sortedStarts) {
    const group = buckets.get(start)!;
    group.sort((x, y) => x[TS] - y[TS]);
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of group) {
      if (c[HIGH] > hi) hi = c[HIGH];
      if (c[LOW] < lo) lo = c[LOW];
      vol += c[VOLUME];
    }
    const first = group[0];
    const last = group[group.length - 1];
    const folded: Candle = [start, first[OPEN], hi, lo, last[CLOSE], vol];
    out.push({
      candle: folded,
      partial: group.length < CANDLES_PER_15M,
      count: group.length,
    });
  }
  return out;
}

/** Convenience: drop partial 15m buckets and return raw Candle[] . */
export function completed15m(htf: HtfCandle[]): Candle[] {
  return htf.filter((h) => !h.partial).map((h) => h.candle);
}

/** Floor an epoch-ms timestamp to its 4h boundary (UTC). */
export function fourHourStart(tsMs: number): number {
  return Math.floor(tsMs / FOUR_HOUR_MS) * FOUR_HOUR_MS;
}

/**
 * Aggregate 5m candles into 4h buckets aligned to the UTC 4h boundary.
 * Same rules as `aggregate1h`. Used by the Sweep leg (HTF filter TF = 4h,
 * owner directive 2026-07-26).
 */
export function aggregate4h(candles: Candle[]): HtfCandle[] {
  if (!candles.length) return [];
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const b = fourHourStart(c[TS]);
    let arr = buckets.get(b);
    if (!arr) { arr = []; buckets.set(b, arr); }
    arr.push(c);
  }
  const newestTs = candles[candles.length - 1][TS];
  const forming = fourHourStart(newestTs);
  buckets.delete(forming);

  const out: HtfCandle[] = [];
  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);
  for (const start of sortedStarts) {
    const group = buckets.get(start)!;
    group.sort((x, y) => x[TS] - y[TS]);
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of group) {
      if (c[HIGH] > hi) hi = c[HIGH];
      if (c[LOW] < lo) lo = c[LOW];
      vol += c[VOLUME];
    }
    const first = group[0];
    const last = group[group.length - 1];
    const folded: Candle = [start, first[OPEN], hi, lo, last[CLOSE], vol];
    out.push({
      candle: folded,
      partial: group.length < CANDLES_PER_4H,
      count: group.length,
    });
  }
  return out;
}

/** Convenience: drop partial 4h buckets and return raw Candle[] . */
export function completed4h(htf: HtfCandle[]): Candle[] {
  return htf.filter((h) => !h.partial).map((h) => h.candle);
}

