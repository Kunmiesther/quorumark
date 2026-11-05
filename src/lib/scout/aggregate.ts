/**
 * Deterministic aggregation of completed lower-timeframe candles into
 * higher-timeframe buckets. Weekly buckets are Monday-anchored (UTC).
 * Monthly buckets are calendar-month-aligned (UTC).
 *
 * Partial (non-full) buckets are DROPPED. Missing intermediate days force a
 * gap marker in the caller (we simply skip the bucket).
 *
 * Pure — no I/O.
 */
import type { Candle } from "@/lib/paper/signal";
import { TS, OPEN, HIGH, LOW, CLOSE, VOLUME } from "@/lib/paper/signal";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days-per-bucket for weekly: exactly 7 completed daily candles. */
export const WEEKLY_DAYS = 7;

function utcMondayStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0 = Sunday..6 = Saturday. Monday-anchored.
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - diffToMon);
  return d.getTime();
}

function utcMonthStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function utcNextMonthStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

interface Bucket {
  start: number;
  candles: Candle[];
}

function fold(bucket: Bucket): Candle {
  const first = bucket.candles[0];
  const last = bucket.candles[bucket.candles.length - 1];
  let hi = -Infinity;
  let lo = Infinity;
  let vol = 0;
  for (const c of bucket.candles) {
    if (c[HIGH] > hi) hi = c[HIGH];
    if (c[LOW] < lo) lo = c[LOW];
    vol += c[VOLUME];
  }
  return [bucket.start, first[OPEN], hi, lo, last[CLOSE], vol];
}

/**
 * Aggregate daily candles into weekly (Mon-anchored) OHLCV.
 * Drops the currently forming week and any week that does not contain
 * exactly `WEEKLY_DAYS` contiguous daily candles.
 */
export function aggregateWeekly(daily: Candle[], now = Date.now()): Candle[] {
  if (daily.length === 0) return [];
  const buckets = new Map<number, Bucket>();
  for (const c of daily) {
    const wk = utcMondayStart(c[TS]);
    let b = buckets.get(wk);
    if (!b) {
      b = { start: wk, candles: [] };
      buckets.set(wk, b);
    }
    b.candles.push(c);
  }
  const out: Candle[] = [];
  const currentWeek = utcMondayStart(now);
  const sorted = [...buckets.values()].sort((a, b) => a.start - b.start);
  for (const b of sorted) {
    if (b.start >= currentWeek) continue; // forming week: drop
    if (b.candles.length !== WEEKLY_DAYS) continue; // incomplete: drop
    // Ensure contiguous days
    b.candles.sort((x, y) => x[TS] - y[TS]);
    let contiguous = true;
    for (let i = 1; i < b.candles.length; i++) {
      if (b.candles[i][TS] - b.candles[i - 1][TS] !== DAY_MS) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    out.push(fold(b));
  }
  return out;
}

/**
 * Aggregate daily candles into calendar-month OHLCV (UTC).
 * Drops the currently forming month and any month that does not contain
 * the exact number of daily candles between its month-start and next month-start.
 */
export function aggregateMonthly(daily: Candle[], now = Date.now()): Candle[] {
  if (daily.length === 0) return [];
  const buckets = new Map<number, Bucket>();
  for (const c of daily) {
    const mo = utcMonthStart(c[TS]);
    let b = buckets.get(mo);
    if (!b) {
      b = { start: mo, candles: [] };
      buckets.set(mo, b);
    }
    b.candles.push(c);
  }
  const out: Candle[] = [];
  const currentMonth = utcMonthStart(now);
  const sorted = [...buckets.values()].sort((a, b) => a.start - b.start);
  for (const b of sorted) {
    if (b.start >= currentMonth) continue;
    const next = utcNextMonthStart(b.start);
    const expected = Math.round((next - b.start) / DAY_MS);
    if (b.candles.length !== expected) continue;
    b.candles.sort((x, y) => x[TS] - y[TS]);
    let contiguous = true;
    for (let i = 1; i < b.candles.length; i++) {
      if (b.candles[i][TS] - b.candles[i - 1][TS] !== DAY_MS) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    out.push(fold(b));
  }
  return out;
}

export const __test = { utcMondayStart, utcMonthStart };
