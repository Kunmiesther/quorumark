import { describe, it, expect } from "vitest";
import { aggregate1h, completed1h, hourStart, HOUR_MS, CANDLES_PER_HOUR } from "../htfCandles";
import type { Candle } from "../signal";

const FIVE_MIN = 5 * 60 * 1000;

function mkCandle(ts: number, o: number, h: number, l: number, c: number, v = 1): Candle {
  return [ts, o, h, l, c, v];
}

function build5mSeries(startHourMs: number, hours: number): Candle[] {
  const out: Candle[] = [];
  for (let h = 0; h < hours; h++) {
    for (let k = 0; k < CANDLES_PER_HOUR; k++) {
      const ts = startHourMs + h * HOUR_MS + k * FIVE_MIN;
      const price = 100 + h + k * 0.01;
      out.push(mkCandle(ts, price, price + 0.5, price - 0.5, price + 0.1));
    }
  }
  return out;
}

describe("htfCandles.aggregate1h", () => {
  const HOUR0 = hourStart(Date.UTC(2025, 0, 1, 0, 0, 0));

  it("returns [] on empty input", () => {
    expect(aggregate1h([])).toEqual([]);
  });

  it("aligns buckets to UTC hour boundary and folds OHLCV correctly", () => {
    const c1 = mkCandle(HOUR0 + 0 * FIVE_MIN, 10, 11, 9, 10.5, 1);
    const c2 = mkCandle(HOUR0 + 1 * FIVE_MIN, 10.5, 12, 10, 11, 2);
    const c3 = mkCandle(HOUR0 + 11 * FIVE_MIN, 11, 13, 8, 12, 3);
    // forming hour marker so the first bucket is treated as complete-past
    const forming = mkCandle(HOUR0 + HOUR_MS, 12, 12, 12, 12, 0);
    // Only 3 candles in bucket 0 => partial
    const out = aggregate1h([c1, c2, c3, forming]);
    expect(out.length).toBe(1);
    expect(out[0].partial).toBe(true);
    expect(out[0].count).toBe(3);
    expect(out[0].candle[0]).toBe(HOUR0);
    expect(out[0].candle[1]).toBe(10);     // first open
    expect(out[0].candle[2]).toBe(13);     // max high
    expect(out[0].candle[3]).toBe(8);      // min low
    expect(out[0].candle[4]).toBe(12);     // last close
    expect(out[0].candle[5]).toBe(6);      // sum volume
  });

  it("excludes the still-forming trailing hour", () => {
    // 2 full hours + 3 candles into hour 2
    const complete = build5mSeries(HOUR0, 2);
    const forming = [
      mkCandle(HOUR0 + 2 * HOUR_MS + 0 * FIVE_MIN, 200, 201, 199, 200),
      mkCandle(HOUR0 + 2 * HOUR_MS + 1 * FIVE_MIN, 200, 201, 199, 200),
    ];
    const out = aggregate1h([...complete, ...forming]);
    // hours 0 & 1 emitted; hour 2 excluded (forming)
    expect(out.length).toBe(2);
    expect(out.every((h) => !h.partial)).toBe(true);
    expect(out[0].candle[0]).toBe(HOUR0);
    expect(out[1].candle[0]).toBe(HOUR0 + HOUR_MS);
  });

  it("flags a bucket with <12 constituents as partial", () => {
    // 12 in hour 0, only 5 in hour 1, then forming candle in hour 2 to
    // exclude the trailing hour cleanly.
    const hour0 = build5mSeries(HOUR0, 1);
    const hour1: Candle[] = [];
    for (let k = 0; k < 5; k++) {
      hour1.push(mkCandle(HOUR0 + HOUR_MS + k * FIVE_MIN, 50, 51, 49, 50));
    }
    const forming = mkCandle(HOUR0 + 2 * HOUR_MS, 60, 60, 60, 60);
    const out = aggregate1h([...hour0, ...hour1, forming]);
    expect(out.length).toBe(2);
    expect(out[0].partial).toBe(false);
    expect(out[0].count).toBe(12);
    expect(out[1].partial).toBe(true);
    expect(out[1].count).toBe(5);
    expect(completed1h(out).length).toBe(1);
  });
});
