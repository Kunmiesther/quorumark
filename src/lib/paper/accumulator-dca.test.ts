import { describe, it, expect } from "vitest";
import {
  MAX_RUNGS, canAddRung, addRung, dcaTakeProfitPrice, dcaStopHit,
} from "./accumulator-dca";

describe("accumulator-dca v1", () => {
  it("caps rungs at MAX_RUNGS", () => {
    expect(canAddRung("long", MAX_RUNGS, 100, [110, 105, 102])).toBe(false);
  });

  it("gates rung adds by 'beyond last level'", () => {
    // Long: need retest BELOW last level.
    expect(canAddRung("long", 1, 99, [100])).toBe(true);
    expect(canAddRung("long", 1, 101, [100])).toBe(false);
    // Short: need retest ABOVE last level.
    expect(canAddRung("short", 1, 101, [100])).toBe(true);
    expect(canAddRung("short", 1, 99, [100])).toBe(false);
  });

  it("re-anchors the average when adding a rung (VWAP of fills)", () => {
    const s0 = [{ price: 100, qty: 1 }];
    const s1 = addRung(s0, { price: 90, qty: 3 });
    // (100 + 270) / 4 = 92.5
    expect(s1.avgEntry).toBeCloseTo(92.5);
    expect(s1.totalQty).toBeCloseTo(4);
    const s2 = addRung(s1.fills, { price: 80, qty: 4 });
    // (100 + 270 + 320) / 8 = 86.25
    expect(s2.avgEntry).toBeCloseTo(86.25);
  });

  it("TP price is 200% margin ROI on the current avg entry", () => {
    // 200% margin @ 100x = 2% price move
    expect(dcaTakeProfitPrice(1000, "long", 100)).toBeCloseTo(1020);
    expect(dcaTakeProfitPrice(1000, "short", 100)).toBeCloseTo(980);
  });

  it("trailing stop is DISABLED before first rebalance and armed after", () => {
    // rung_count = 1 → no stop
    expect(dcaStopHit(50, 1, [100], "long")).toBe(false);
    // rung_count = 2 → armed, uses last resize level
    expect(dcaStopHit(89, 2, [100, 90], "long")).toBe(true);
    expect(dcaStopHit(91, 2, [100, 90], "long")).toBe(false);
    expect(dcaStopHit(111, 2, [100, 110], "short")).toBe(true);
    expect(dcaStopHit(109, 2, [100, 110], "short")).toBe(false);
  });
});
