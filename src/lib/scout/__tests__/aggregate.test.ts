import { describe, expect, it } from "vitest";
import { aggregateWeekly, aggregateMonthly } from "@/lib/scout/aggregate";
import type { Candle } from "@/lib/paper/signal";

const DAY = 24 * 60 * 60 * 1000;

function daily(startTs: number, n: number, opens: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = opens(i);
    out.push([startTs + i * DAY, o, o + 1, o - 1, o + 0.5, 100 + i]);
  }
  return out;
}

describe("aggregateWeekly", () => {
  it("drops the currently-forming week", () => {
    // Monday 2024-01-01 UTC
    const monday = Date.UTC(2024, 0, 1);
    const candles = daily(monday, 14, (i) => 100 + i);
    // "now" mid-week 2 → week 2 should be dropped, week 1 kept
    const now = monday + 10 * DAY;
    const weekly = aggregateWeekly(candles, now);
    expect(weekly.length).toBe(1);
    expect(weekly[0][0]).toBe(monday);
  });

  it("drops incomplete weeks", () => {
    const monday = Date.UTC(2024, 0, 1);
    // only 6 days of week 1
    const candles = daily(monday, 6, (i) => 100 + i);
    const now = monday + 14 * DAY;
    expect(aggregateWeekly(candles, now).length).toBe(0);
  });

  it("aggregates OHLCV correctly across a full week", () => {
    const monday = Date.UTC(2024, 0, 1);
    const candles = daily(monday, 7, (i) => 100 + i * 2);
    const now = monday + 14 * DAY;
    const [w] = aggregateWeekly(candles, now);
    expect(w[0]).toBe(monday);
    expect(w[1]).toBe(100); // first open
    expect(w[4]).toBe(112.5); // last close (100 + 12 + 0.5)
    expect(w[2]).toBeGreaterThan(w[1]);
  });

  it("rejects buckets with non-contiguous days", () => {
    const monday = Date.UTC(2024, 0, 1);
    const cs = daily(monday, 7, (i) => 100 + i);
    // Remove day 3 by shifting later candles — creates a gap
    const missing = [...cs.slice(0, 3), ...cs.slice(4)];
    // Pad back to 7 with a stray day OUTSIDE the week to keep count=7
    missing.push([monday + 20 * DAY, 200, 200, 200, 200, 1]);
    const weekly = aggregateWeekly(missing, monday + 30 * DAY);
    expect(weekly.length).toBe(0);
  });
});

describe("aggregateMonthly", () => {
  it("aggregates a full calendar month and drops forming month", () => {
    // January 2024 has 31 days
    const jan1 = Date.UTC(2024, 0, 1);
    const feb1 = Date.UTC(2024, 1, 1);
    const cs = daily(jan1, 31, (i) => 100 + i);
    // 5 days into Feb → Feb is forming and Jan is complete
    const now = feb1 + 5 * DAY;
    const monthly = aggregateMonthly(cs, now);
    expect(monthly.length).toBe(1);
    expect(monthly[0][0]).toBe(jan1);
  });

  it("drops months with the wrong day count", () => {
    const jan1 = Date.UTC(2024, 0, 1);
    const cs = daily(jan1, 30, (i) => 100 + i); // one day short
    const now = Date.UTC(2024, 2, 1);
    expect(aggregateMonthly(cs, now).length).toBe(0);
  });
});
