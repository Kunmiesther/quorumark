import { describe, it, expect } from "vitest";
import { workingAllocationFrac, BASE_ALLOCATION_FRAC, MAX_ALLOCATION_FRAC } from "@/lib/paper/arbiter/compounding";

describe("compounding — workingAllocationFrac", () => {
  it("starts at base when cumulative pnl is 0", () => {
    expect(workingAllocationFrac(10_000, 0)).toBeCloseTo(BASE_ALLOCATION_FRAC, 8);
  });

  it("grows with positive cumulative pnl", () => {
    // +500 on 10_000 equity = +5% → 10% + 5% = 15%
    expect(workingAllocationFrac(10_000, 500)).toBeCloseTo(0.15, 8);
  });

  it("capped at MAX_ALLOCATION_FRAC", () => {
    expect(workingAllocationFrac(10_000, 100_000)).toBeCloseTo(MAX_ALLOCATION_FRAC, 8);
  });

  it("floored at BASE_ALLOCATION_FRAC on negative pnl (base is the floor)", () => {
    expect(workingAllocationFrac(10_000, -5_000)).toBeCloseTo(BASE_ALLOCATION_FRAC, 8);
  });

  it("safe on zero/invalid equity", () => {
    expect(workingAllocationFrac(0, 500)).toBeCloseTo(BASE_ALLOCATION_FRAC, 8);
  });
});
