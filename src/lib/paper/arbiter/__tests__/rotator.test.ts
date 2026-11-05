import { describe, it, expect } from "vitest";
import { planRotation } from "@/lib/paper/arbiter/rotator";

describe("rotator — planRotation", () => {
  it("deterministic ranking with symbol tiebreak", () => {
    const plan = planRotation(
      [
        { symbol: "XRP-USDT", netApr: 0.10, fundingRate: 0.001 },
        { symbol: "BTC-USDT", netApr: 0.10, fundingRate: 0.001 },
      ],
      [],
      2,
      0.25,
    );
    expect(plan.ranking.map((r) => r.symbol)).toEqual(["BTC-USDT", "XRP-USDT"]);
  });

  it("respects max_concurrent_pairs", () => {
    const plan = planRotation(
      [
        { symbol: "A", netApr: 0.5, fundingRate: 0 },
        { symbol: "B", netApr: 0.4, fundingRate: 0 },
        { symbol: "C", netApr: 0.3, fundingRate: 0 },
      ],
      [],
      2,
    );
    expect(plan.target).toEqual(["A", "B"]);
    expect(plan.toOpen).toEqual(["A", "B"]);
    expect(plan.toClose).toEqual([]);
  });

  it("hysteresis prevents churn — challenger must beat weakest held by >= 25%", () => {
    // Weakest held has APR 0.20; challenger 0.24 → 20% gain, below 25% → NO churn.
    const plan = planRotation(
      [
        { symbol: "HELD1", netApr: 0.30, fundingRate: 0 },
        { symbol: "HELD2", netApr: 0.20, fundingRate: 0 },
        { symbol: "CHAL", netApr: 0.24, fundingRate: 0 },
      ],
      [
        { symbol: "HELD1", netApr: 0.30 },
        { symbol: "HELD2", netApr: 0.20 },
      ],
      2,
      0.25,
    );
    expect(plan.target.sort()).toEqual(["HELD1", "HELD2"]);
    expect(plan.toClose).toEqual([]);
    expect(plan.toOpen).toEqual([]);
  });

  it("hysteresis allows rotation when challenger beats weakest by margin", () => {
    // Weakest 0.20; challenger 0.30 → 50% gain > 25% → rotate.
    const plan = planRotation(
      [
        { symbol: "HELD1", netApr: 0.40, fundingRate: 0 },
        { symbol: "HELD2", netApr: 0.20, fundingRate: 0 },
        { symbol: "CHAL", netApr: 0.30, fundingRate: 0 },
      ],
      [
        { symbol: "HELD1", netApr: 0.40 },
        { symbol: "HELD2", netApr: 0.20 },
      ],
      2,
      0.25,
    );
    expect(plan.target.sort()).toEqual(["CHAL", "HELD1"]);
    expect(plan.toClose).toEqual(["HELD2"]);
    expect(plan.toOpen).toEqual(["CHAL"]);
  });
});
