import { describe, expect, it } from "vitest";
import { resolveCampaignHardStop } from "../ladder";

describe("campaign stop survives partial profit-taking", () => {
  const campaign = {
    direction: "short" as const,
    armedStopPrice: 99.51732,
    armedAt: "2026-09-16T18:00:00Z",
    finalRungFillPrice: 98.532,
    filledRungCount: 5,
    totalPlannedRungs: 5,
    deepestOpenFillPrice: 98.049,
  };
  it("retains the historical SOL stop after the deepest rung takes profit", () => {
    const stop = resolveCampaignHardStop(campaign);
    expect(stop).toBe(99.51732);
    expect(111.962388).toBeGreaterThan(stop!);
  });
  it("retains a long stop after multiple lots exit", () => {
    expect(resolveCampaignHardStop({ ...campaign, direction: "long", armedStopPrice: 97.54668,
      deepestOpenFillPrice: 100 })).toBe(97.54668);
  });
  it("reconstructs an armed legacy stop from the cumulative fills and final fill", () => {
    expect(resolveCampaignHardStop({ ...campaign, armedStopPrice: null, armedAt: null }))
      .toBeCloseTo(99.51732, 8);
  });
  it("honors a guardian-armed stop even with fewer than the original planned fills", () => {
    expect(resolveCampaignHardStop({ ...campaign, filledRungCount: 2 })).toBe(99.51732);
  });
  it("does not arm an incomplete ladder from a placeholder stop_level", () => {
    expect(resolveCampaignHardStop({ ...campaign, armedStopPrice: null, armedAt: null,
      finalRungFillPrice: null, filledRungCount: 4, stopLevel: 120 })).toBeNull();
  });
  it("accepts the legacy stop only with recorded arming", () => {
    expect(resolveCampaignHardStop({ ...campaign, armedStopPrice: null, stopLevel: 99.6 })).toBe(99.6);
  });
  it("ignores corrupt persisted prices", () => {
    expect(resolveCampaignHardStop({ ...campaign, armedStopPrice: Infinity, armedAt: null,
      finalRungFillPrice: null, filledRungCount: 4 })).toBeNull();
  });
});
