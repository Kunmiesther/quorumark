import { describe, it, expect } from "vitest";
import { shouldSkipOnVolatility, quantile } from "@/lib/paper/arbiter/volFilter";

describe("volFilter — quantile", () => {
  it("linear interpolation p50 on [1..9] = 5", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.5)).toBeCloseTo(5, 8);
  });
  it("p90 threshold picks the 90th percentile", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 8);
  });
});

describe("volFilter — shouldSkipOnVolatility", () => {
  it("skips when current ATR% >= 90th percentile of trailing series", () => {
    const trailing = Array.from({ length: 100 }, (_, i) => i / 100); // 0.00..0.99
    const v = shouldSkipOnVolatility({ currentAtrPct: 0.95, trailingAtrPct: trailing });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("arbiter_vol_skip");
  });

  it("does NOT skip when current below the 90th percentile", () => {
    const trailing = Array.from({ length: 100 }, (_, i) => i / 100);
    const v = shouldSkipOnVolatility({ currentAtrPct: 0.50, trailingAtrPct: trailing });
    expect(v.skip).toBe(false);
  });

  it("empty trailing sample never blocks (no data → no signal)", () => {
    const v = shouldSkipOnVolatility({ currentAtrPct: 0.9, trailingAtrPct: [] });
    expect(v.skip).toBe(false);
  });
});
