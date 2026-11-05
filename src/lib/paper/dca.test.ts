import { describe, it, expect } from "vitest";
import {
  tp1Target, tp2Target, tp3Target, reanchoredAverage,
  trailingStopActive, trailingStopLevel, stopTriggered, DcaExitError,
} from "./dca";

describe("DCA take-profit ladder (margin basis)", () => {
  it("prices TP1/TP2/TP3 as (pct/100)/leverage price moves", () => {
    const entry = 1650, lev = 100;
    // 200% margin ROI @ 100x = 2% price move
    expect(tp1Target(entry, "long", lev)).toBeCloseTo(1650 * 1.02);
    expect(tp2Target(entry, "long", lev)).toBeCloseTo(1650 * 1.03);
    expect(tp3Target(entry, "long", lev)).toBeCloseTo(1650 * 1.04);
    // short mirrors below entry
    expect(tp1Target(entry, "short", lev)).toBeCloseTo(1650 * 0.98);
  });

  it("TP3 anchors to the frozen first-fill VWAP, independent of the current average", () => {
    // current avg has drifted down to 1600, but TP3 still uses the first fill 1650
    expect(tp3Target(1650, "long", 100)).toBeCloseTo(1650 * 1.04);
  });

  it("fails closed on an impossible target (short 400% at leverage <= 4)", () => {
    expect(() => tp3Target(100, "short", 4)).toThrow(DcaExitError); // move = 1.0 -> target 0
    expect(() => tp1Target(100, "long", 0)).toThrow(DcaExitError);
  });
});

describe("re-anchored average", () => {
  it("is the qty-weighted VWAP of all filled rungs", () => {
    expect(reanchoredAverage([{ price: 1650, qty: 1 }, { price: 1600, qty: 1 }])).toBeCloseTo(1625);
    expect(reanchoredAverage([{ price: 100, qty: 1 }, { price: 90, qty: 3 }])).toBeCloseTo((100 + 270) / 4);
  });
  it("throws with no fills or a bad rung", () => {
    expect(() => reanchoredAverage([])).toThrow(DcaExitError);
    expect(() => reanchoredAverage([{ price: 0, qty: 1 }])).toThrow(DcaExitError);
  });
});

describe("trailing stop (armed only after first rebalance)", () => {
  it("is inactive before the first rebalance", () => {
    expect(trailingStopActive(0)).toBe(false);
    expect(trailingStopLevel(0, [100, 95])).toBeNull();
    expect(stopTriggered(90, 0, [100, 95], "long")).toBe(false); // no stop yet
  });

  it("tracks the most recent resize/retest level once armed", () => {
    expect(trailingStopActive(1)).toBe(true);
    expect(trailingStopLevel(1, [100, 95, 92])).toBe(92);
  });

  it("triggers on a confirmed close beyond the level", () => {
    // long: close below the level
    expect(stopTriggered(91, 1, [100, 95, 92], "long")).toBe(true);
    expect(stopTriggered(93, 1, [100, 95, 92], "long")).toBe(false);
    // short: close above the level
    expect(stopTriggered(101, 1, [90, 95, 98], "short")).toBe(true);
    expect(stopTriggered(97, 1, [90, 95, 98], "short")).toBe(false);
  });

  it("never invents a stop when no level exists", () => {
    expect(trailingStopLevel(1, [])).toBeNull();
    expect(stopTriggered(50, 1, [], "long")).toBe(false);
  });
});
