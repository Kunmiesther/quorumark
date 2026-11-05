import { describe, expect, it } from "vitest";
import { accountAssetTotals } from "./accountAssets";
const live = {
  totalUsd: 9000,
  available: 8000,
  allocated: 1000,
  isLoading: false,
  hasError: false,
};
const paper = { equity: 3600, available: 3500, isLoading: false, source: "paper_account" };
describe("buying power book isolation", () => {
  it("shows only paper equity and committed margin in paper mode", () => {
    expect(accountAssetTotals("paper", paper, live)).toEqual({
      equity: 3600,
      available: 3500,
      allocated: 100,
      isLoading: false,
      hasError: false,
    });
  });
  it("never falls back to live funds when the paper source fails", () => {
    expect(
      accountAssetTotals("paper", { ...paper, source: "unavailable", equity: null }, live),
    ).toMatchObject({ equity: null, available: null, allocated: null, hasError: true });
  });
  it("preserves live account totals", () => {
    expect(accountAssetTotals("live", paper, live)).toMatchObject({
      equity: 9000,
      available: 8000,
      allocated: 1000,
    });
  });
});
