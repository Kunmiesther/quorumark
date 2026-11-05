import { describe, it, expect } from "vitest";
import {
  windowRecent,
  computeYDomain,
  clampTargetToDomain,
  capPoints,
  easeDomain,
} from "../window";

describe("windowRecent", () => {
  const now = 1_800_000_000_000;
  const series = Array.from({ length: 60 }, (_, i) => ({
    t: now - (59 - i) * 60_000, // one point per minute, ending at now
    close: 100 + i,
  }));

  it("keeps only the last N minutes of points", () => {
    const out = windowRecent(series, 8, now);
    expect(out.length).toBe(9); // 8 minutes back is inclusive → 9 points
    expect(out[out.length - 1].close).toBe(159);
  });

  it("returns [] on empty input", () => {
    expect(windowRecent([], 5)).toEqual([]);
  });

  it("never returns empty when input has data (fallback to last)", () => {
    const stale = [{ t: now - 10 * 60 * 60_000, close: 42 }];
    const out = windowRecent(stale, 5, now);
    expect(out).toEqual(stale);
  });
});

describe("computeYDomain", () => {
  it("returns padded [min,max] around visible values", () => {
    const [lo, hi] = computeYDomain([100, 101, 102], 0.1, 0);
    // range=2, pad=0.2 → [99.8, 102.2]
    expect(lo).toBeCloseTo(99.8, 6);
    expect(hi).toBeCloseTo(102.2, 6);
  });

  it("flat-range guard: returns a non-zero band around a single value", () => {
    const [lo, hi] = computeYDomain([100, 100, 100], 0.08, 0.001);
    expect(hi).toBeGreaterThan(lo);
    expect(hi - lo).toBeGreaterThan(0);
  });

  it("handles empty input safely", () => {
    expect(computeYDomain([])).toEqual([0, 1]);
  });
});

describe("clampTargetToDomain", () => {
  it("in-view target returns original with inView=true", () => {
    const r = clampTargetToDomain(100, [90, 110]);
    expect(r.inView).toBe(true);
    expect(r.side).toBeNull();
    expect(r.price).toBe(100);
  });
  it("above-view clamps to top edge with side=above", () => {
    const r = clampTargetToDomain(200, [90, 110]);
    expect(r.inView).toBe(false);
    expect(r.side).toBe("above");
    expect(r.price).toBe(110);
    expect(r.original).toBe(200);
  });
  it("below-view clamps to bottom edge with side=below", () => {
    const r = clampTargetToDomain(50, [90, 110]);
    expect(r.side).toBe("below");
    expect(r.price).toBe(90);
  });
});

describe("capPoints", () => {
  it("keeps the last point after downsampling", () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    const out = capPoints(arr, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out[out.length - 1]).toBe(999);
  });
});

describe("easeDomain", () => {
  it("returns target when prev is null", () => {
    expect(easeDomain(null, [1, 2])).toEqual([1, 2]);
  });
  it("moves partially toward target", () => {
    const [lo, hi] = easeDomain([0, 10], [10, 20], 0.5);
    expect(lo).toBe(5);
    expect(hi).toBe(15);
  });
});
