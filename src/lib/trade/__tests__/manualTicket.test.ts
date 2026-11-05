import { describe, expect, it } from "vitest";
import {
  MANUAL_DCA_DEFAULTS,
  MAX_TICKET_LEVERAGE,
  buildRungPrices,
  clampLeverage,
  estimateLiquidation,
  leverageCeiling,
  leverageRiskTone,
  summarizeTicket,
  validateTicket,
} from "@/lib/trade/manualTicket";

const base = {
  side: "long" as const,
  entry: 100,
  marginUsd: 100,
  leverage: 10,
  tickSize: 0.1,
  stepSize: 0.001,
  dcaEnabled: false,
};

describe("leverage bounds and symbol clamp", () => {
  it("clamps to 1..100 by default", () => {
    expect(clampLeverage(0, null)).toBe(1);
    expect(clampLeverage(250, null)).toBe(MAX_TICKET_LEVERAGE);
    expect(clampLeverage(37.9, null)).toBe(37);
  });
  it("clamps to the venue ceiling for the symbol", () => {
    expect(leverageCeiling(50)).toBe(50);
    expect(clampLeverage(80, 50)).toBe(50);
    expect(clampLeverage(20, 50)).toBe(20);
  });
  it("progresses risk tone with the ceiling", () => {
    expect(leverageRiskTone(2, 100)).toBe("safe");
    expect(leverageRiskTone(30, 100)).toBe("elevated");
    expect(leverageRiskTone(60, 100)).toBe("high");
    expect(leverageRiskTone(95, 100)).toBe("extreme");
  });
});

describe("long / short and market / limit", () => {
  it("liquidation sits below entry for long, above for short", () => {
    expect(estimateLiquidation(100, 10, "long")!).toBeLessThan(100);
    expect(estimateLiquidation(100, 10, "short")!).toBeGreaterThan(100);
  });
  it("rung prices walk down for long and up for short", () => {
    const l = buildRungPrices({ entry: 100, side: "long", rungCount: 3, spacingPct: 1, tickSize: 0.1 });
    const s = buildRungPrices({ entry: 100, side: "short", rungCount: 3, spacingPct: 1, tickSize: 0.1 });
    expect(l).toEqual([100, 99, 98]);
    expect(s).toEqual([100, 101, 102]);
  });
  it("limit orders require an entry price", () => {
    const summary = summarizeTicket(base);
    const reasons = validateTicket({
      symbol: "BTC-USDT",
      side: "long",
      kind: "limit",
      marginUsd: 100,
      leverage: 10,
      venueMaxLeverage: 100,
      limitPrice: null,
      markPrice: 100,
      markPriceAt: Date.now(),
      availableBalance: 1000,
      takeProfit: null,
      stopLoss: null,
      summary,
      book: "paper",
    });
    expect(reasons).toContain("Limit orders need an entry price");
  });
});

describe("DCA create / edit / remove and totals", () => {
  it("single entry when DCA is off", () => {
    const s = summarizeTicket(base);
    expect(s.rungs).toHaveLength(1);
    expect(s.weightedEntry).toBeCloseTo(100, 6);
  });
  it("splits margin across rungs without overspending", () => {
    const s = summarizeTicket({ ...base, dcaEnabled: true, rungCount: 4, spacingPct: 1 });
    expect(s.rungs).toHaveLength(4);
    expect(s.totalMargin).toBeLessThanOrEqual(base.marginUsd + 1e-6);
    expect(s.totalNotional).toBeCloseTo(
      s.rungs.reduce((a, r) => a + r.notionalUsd, 0),
      6,
    );
    // Weighted entry lands between best and worst rung price.
    expect(s.weightedEntry).toBeLessThanOrEqual(100);
    expect(s.weightedEntry).toBeGreaterThan(s.rungs[3].price - 1);
  });
  it("honours client-edited per-rung margins", () => {
    const s = summarizeTicket({
      ...base,
      dcaEnabled: true,
      rungCount: 2,
      spacingPct: 1,
      rungMargins: [20, 80],
    });
    expect(s.rungs[1].notionalUsd).toBeGreaterThan(s.rungs[0].notionalUsd);
  });
  it("removing rungs recalculates totals", () => {
    const a = summarizeTicket({ ...base, dcaEnabled: true, rungCount: 4, spacingPct: 1 });
    const b = summarizeTicket({ ...base, dcaEnabled: true, rungCount: 2, spacingPct: 1 });
    expect(b.rungs).toHaveLength(2);
    expect(b.totalMargin).toBeCloseTo(a.totalMargin, 1);
  });
  it("manual defaults are not the automated 8-rung strategy", () => {
    expect(MANUAL_DCA_DEFAULTS.rungCount).toBe(3);
    expect(MANUAL_DCA_DEFAULTS.maxRungs).toBe(12);
  });
});

describe("validation reasons and paper vs live confirmation", () => {
  const summary = summarizeTicket(base);
  const common = {
    symbol: "BTC-USDT",
    side: "long" as const,
    kind: "market" as const,
    marginUsd: 100,
    leverage: 10,
    venueMaxLeverage: 100,
    limitPrice: null,
    markPrice: 100,
    markPriceAt: Date.now(),
    availableBalance: 1000,
    takeProfit: null,
    stopLoss: null,
    summary,
  };
  it("paper is submittable without a hold-to-confirm", () => {
    expect(validateTicket({ ...common, book: "paper" })).toEqual([]);
  });
  it("live blocks until the confirmation control completes", () => {
    expect(validateTicket({ ...common, book: "live" })).toContain(
      "Hold the live confirmation control to submit",
    );
    expect(validateTicket({ ...common, book: "live", liveConfirmed: true })).toEqual([]);
  });
  it("blocks with precise reasons — never silently", () => {
    const r = validateTicket({
      ...common,
      book: "paper",
      marginUsd: 5000,
      markPriceAt: Date.now() - 120_000,
      takeProfit: 90,
      stopLoss: 110,
      minNotionalUsd: 10_000,
    });
    expect(r).toContain("Order amount exceeds available balance");
    expect(r).toContain("Price feed is stale — refusing to size an order");
    expect(r).toContain("Take profit is on the wrong side of entry");
    expect(r).toContain("Stop loss is on the wrong side of entry");
    expect(r.some((x) => x.startsWith("Below the exchange minimum"))).toBe(true);
  });
  it("blocks when size rounds to zero at the venue step", () => {
    const tiny = summarizeTicket({ ...base, marginUsd: 0.0001, stepSize: 1 });
    const r = validateTicket({ ...common, book: "paper", marginUsd: 0.0001, summary: tiny });
    expect(r.some((x) => x.includes("rounds to zero"))).toBe(true);
  });
  it("worst-case loss includes fees when a stop is set", () => {
    const s = summarizeTicket({ ...base, stopLoss: 95 });
    expect(s.worstCaseLossUsd).toBeGreaterThan(0);
  });
});
