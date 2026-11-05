import { describe, expect, it } from "vitest";
import { coverageBySource } from "../coverage";

describe("source-scoped Life Map coverage", () => {
  const allocations = [
    { bill_id: "rent", amount_usd: 30, source: "paper" },
    { bill_id: "rent", amount_usd: 12, source: "live" },
    { bill_id: "rent", amount_usd: -2, source: "reallocation_live" },
    { bill_id: "phone", amount_usd: 2, source: "reallocation_live" },
    { bill_id: "rent", amount_usd: 5, source: "reallocation" },
  ];

  it("keeps paper simulation out of live income", () => {
    expect(coverageBySource(allocations, "live").get("rent")).toBe(10);
    expect(coverageBySource(allocations, "live").get("phone")).toBe(2);
  });

  it("keeps live income out of paper and excludes historical unscoped moves", () => {
    expect(coverageBySource(allocations, "paper").get("rent")).toBe(30);
    expect(coverageBySource(allocations, "paper").has("phone")).toBe(false);
  });
});
