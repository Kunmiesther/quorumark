import { describe, it, expect } from "vitest";
import { suggestReallocations, type BillCoverage } from "../reallocate";

const C = (id: string, amount: number, covered: number): BillCoverage => ({
  id,
  amount_usd: amount,
  covered_usd: covered,
});

describe("suggestReallocations", () => {
  it("no suggestion when nothing is over cap", () => {
    const r = suggestReallocations([C("rent", 1500, 1500), C("phone", 100, 50)]);
    expect(r).toEqual([]);
  });

  it("matches the example: modest surplus covers the smallest gaps first", () => {
    const bills = [
      C("rent", 1000, 1150), // $150 surplus
      C("light", 60, 0),
      C("water", 40, 0),
      C("car", 500, 500), // already fully covered — not a target
    ];
    const r = suggestReallocations(bills);
    expect(r).toHaveLength(1);
    expect(r[0].source_bill_id).toBe("rent");
    // Only $100 of the $150 surplus has anywhere to go — car is already
    // covered and there's nothing else, so the remaining $50 stays put
    // rather than being claimed by a suggestion with nowhere to send it.
    expect(r[0].surplus_usd).toBe(100);
    expect(r[0].targets).toEqual([
      { bill_id: "water", amount_usd: 40 },
      { bill_id: "light", amount_usd: 60 },
    ]);
  });

  it("keeps spilling leftover surplus into the next-smallest gap rather than stranding it", () => {
    const bills = [C("rent", 1000, 1150), C("light", 60, 0), C("water", 40, 0), C("car", 500, 0)];
    const r = suggestReallocations(bills);
    expect(r[0].surplus_usd).toBe(150);
    expect(r[0].targets).toEqual([
      { bill_id: "water", amount_usd: 40 },
      { bill_id: "light", amount_usd: 60 },
      { bill_id: "car", amount_usd: 50 },
    ]);
  });

  it("surplus that doesn't fully cover the smallest gap still partially fills it", () => {
    const bills = [C("rent", 1000, 1030), C("water", 40, 0)];
    const r = suggestReallocations(bills);
    expect(r[0].surplus_usd).toBe(30);
    expect(r[0].targets).toEqual([{ bill_id: "water", amount_usd: 30 }]);
  });

  it("a bill already at or over cap is never a target", () => {
    const bills = [C("rent", 1000, 1050), C("phone", 100, 100), C("water", 40, 0)];
    const r = suggestReallocations(bills);
    expect(r[0].targets).toEqual([{ bill_id: "water", amount_usd: 40 }]);
  });

  it("multiple over-cap bills each produce their own suggestion", () => {
    const bills = [C("rent", 1000, 1020), C("phone", 100, 120), C("water", 40, 0)];
    const r = suggestReallocations(bills);
    expect(r).toHaveLength(2);
    const bySource = Object.fromEntries(r.map((s) => [s.source_bill_id, s]));
    expect(bySource.rent.surplus_usd).toBe(20);
    expect(bySource.phone.surplus_usd).toBe(20);
  });

  it("no target bills at all means no suggestion even with surplus", () => {
    const r = suggestReallocations([C("rent", 1000, 1050)]);
    expect(r).toEqual([]);
  });
});
