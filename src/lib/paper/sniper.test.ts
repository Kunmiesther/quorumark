import { describe, it, expect } from "vitest";
import {
  sessionVwapSeries, findZones, detectFakeoutEntry, zoneInvalidated,
  continuationConfirmed, DAY_MS, type Zone,
} from "./sniper";
import type { Candle } from "./signal";

function c(ts: number, o: number, h: number, l: number, cl: number, v = 1): Candle {
  return [ts, o, h, l, cl, v];
}

describe("session VWAP", () => {
  it("accumulates within a UTC day and resets at the boundary", () => {
    const candles: Candle[] = [
      c(0, 100, 100, 100, 100, 10), // tp 100
      c(300_000, 110, 110, 110, 110, 10), // same day, tp 110
      c(DAY_MS, 200, 200, 200, 200, 5), // next day → reset
    ];
    const v = sessionVwapSeries(candles);
    expect(v[0]).toBeCloseTo(100);
    expect(v[1]).toBeCloseTo(105); // (100*10 + 110*10)/20
    expect(v[2]).toBeCloseTo(200); // reset
  });

  it("is null while a session has zero volume", () => {
    const v = sessionVwapSeries([c(0, 100, 101, 99, 100, 0)]);
    expect(v[0]).toBeNull();
  });
});

describe("findZones", () => {
  it("marks a supply zone at a strict pivot high with an ATR band", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) candles.push(c(i * 300_000, 100, 100.5, 99.5, 100));
    // strict pivot high at index 14
    candles[14] = c(14 * 300_000, 100, 105, 99.5, 100);
    const zones = findZones(candles, 0.01);
    const supply = zones.find((z) => z.kind === "supply" && z.pivotIndex === 14);
    expect(supply).toBeDefined();
    expect((supply as Zone).level).toBeCloseTo(105);
    expect((supply as Zone).upper).toBeGreaterThan(105);
    expect((supply as Zone).lower).toBeLessThan(105);
  });
});

describe("detectFakeoutEntry", () => {
  const demand: Zone = { kind: "demand", pivotIndex: 0, pivotTs: 0, level: 100, lower: 99, upper: 101, atr: 1 };
  const supply: Zone = { kind: "supply", pivotIndex: 0, pivotTs: 0, level: 100, lower: 99, upper: 101, atr: 1 };

  it("longs a demand-zone fakeout (wick below, close reclaimed)", () => {
    const e = detectFakeoutEntry(c(0, 99.5, 100, 98.5, 99.5), demand, 0.1);
    expect(e).not.toBeNull();
    expect(e!.direction).toBe("long");
    expect(e!.entry).toBeCloseTo(99.5);
    expect(e!.stop).toBeCloseTo(98.5 - 0.1);
    expect(e!.filtered).toBe(true);
  });

  it("rejects a wick deeper than MAX_WICK_ATR_MULT × ATR (real breakout)", () => {
    // 99 - 97 = 2 > 1.5 × atr(1)
    expect(detectFakeoutEntry(c(0, 99, 100, 97, 99.5), demand, 0.1)).toBeNull();
  });

  it("shorts a supply-zone fakeout (wick above, close reclaimed)", () => {
    const e = detectFakeoutEntry(c(0, 100.5, 101.5, 100, 100.5), supply, 0.1);
    expect(e).not.toBeNull();
    expect(e!.direction).toBe("short");
    expect(e!.stop).toBeCloseTo(101.5 + 0.1);
  });

  it("does not fire without a reclaim (close stays outside)", () => {
    expect(detectFakeoutEntry(c(0, 99, 99.2, 98.5, 98.8), demand, 0.1)).toBeNull();
  });
});

describe("invalidation & continuation", () => {
  const demand: Zone = { kind: "demand", pivotIndex: 0, pivotTs: 0, level: 100, lower: 99, upper: 101, atr: 1 };

  it("invalidates a demand zone on a close below its lower edge", () => {
    expect(zoneInvalidated(c(0, 99, 99, 98, 98), demand)).toBe(true);
    expect(zoneInvalidated(c(0, 99, 100, 99, 99.5), demand)).toBe(false);
  });

  it("confirms continuation only on a decisive close through VWAP", () => {
    // long, vwap 100, close 101, range 1, atr5 2 → beyond 1 >= 0.4*1 and >= 0.15*2
    expect(continuationConfirmed(c(0, 100, 101, 100, 101), 100, "long", 2)).toBe(true);
    // doji touch: close barely beyond, tiny body vs range
    expect(continuationConfirmed(c(0, 99, 102, 98, 100.05), 100, "long", 2)).toBe(false);
  });
});
