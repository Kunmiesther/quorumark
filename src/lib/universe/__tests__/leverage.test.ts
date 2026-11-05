import { describe, it, expect } from "vitest";
import { sizePosition } from "../leverage";

const FRESH = { metadataAgeMs: 0, maxMetadataAgeMs: 60_000 };

describe("leverage & inverse-margin sizer", () => {
  it("rejects when leverage metadata is missing (fail-closed)", () => {
    const r = sizePosition({
      approvedNotionalUsd: 100,
      availableMarginUsd: 100,
      bounds: { ...FRESH, exchangeMaxLeverage: null, minLiquidationDistancePct: 0.02, adverseMovePct: 0.005 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("leverage_metadata_missing");
  });

  it("rejects when leverage metadata is stale", () => {
    const r = sizePosition({
      approvedNotionalUsd: 100,
      availableMarginUsd: 100,
      bounds: { exchangeMaxLeverage: 100, metadataAgeMs: 999_999, maxMetadataAgeMs: 60_000, minLiquidationDistancePct: 0.02, adverseMovePct: 0.005 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("leverage_metadata_stale");
  });

  it("caps to exchange max when exchange < safe", () => {
    // safe cap = floor(1 / (0.001 + 0.001)) = 500 → exchange 25 wins
    const r = sizePosition({
      approvedNotionalUsd: 1000,
      availableMarginUsd: 1000,
      bounds: { ...FRESH, exchangeMaxLeverage: 25, minLiquidationDistancePct: 0.001, adverseMovePct: 0.001 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.approvedLeverage).toBe(25);
      expect(r.decision.limitingReason).toBe("exchange_max");
      // inverse margin: 1000 / 25 = 40
      expect(r.decision.requiredMarginUsd).toBeCloseTo(40, 5);
      expect(r.decision.approvedNotionalUsd).toBe(1000); // never inflated
    }
  });

  it("caps below exchange max when liquidation distance requires it", () => {
    // safe cap = floor(1 / (0.05 + 0.02)) = floor(14.28) = 14 → wins over exchange 100
    const r = sizePosition({
      approvedNotionalUsd: 1000,
      availableMarginUsd: 1000,
      bounds: { ...FRESH, exchangeMaxLeverage: 100, minLiquidationDistancePct: 0.05, adverseMovePct: 0.02 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.approvedLeverage).toBe(14);
      expect(r.decision.limitingReason).toBe("liquidation_distance");
      expect(r.decision.requiredMarginUsd).toBeGreaterThanOrEqual(1000 / 14);
    }
  });

  it("rejects when required margin exceeds available margin", () => {
    // 1000 notional at 5x = 200 margin required, only 50 available
    const r = sizePosition({
      approvedNotionalUsd: 1000,
      availableMarginUsd: 50,
      bounds: { ...FRESH, exchangeMaxLeverage: 5, minLiquidationDistancePct: 0.02, adverseMovePct: 0.005 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_margin");
  });

  it("higher approved leverage never inflates approved notional or risk", () => {
    const lowLev = sizePosition({
      approvedNotionalUsd: 500,
      availableMarginUsd: 500,
      bounds: { ...FRESH, exchangeMaxLeverage: 10, minLiquidationDistancePct: 0.001, adverseMovePct: 0.001 },
    });
    const highLev = sizePosition({
      approvedNotionalUsd: 500,
      availableMarginUsd: 500,
      bounds: { ...FRESH, exchangeMaxLeverage: 100, minLiquidationDistancePct: 0.001, adverseMovePct: 0.001 },
    });
    expect(lowLev.ok && highLev.ok).toBe(true);
    if (lowLev.ok && highLev.ok) {
      expect(lowLev.decision.approvedNotionalUsd).toBe(500);
      expect(highLev.decision.approvedNotionalUsd).toBe(500);
      expect(highLev.decision.requiredMarginUsd).toBeLessThan(lowLev.decision.requiredMarginUsd);
    }
  });

  it("treats 100x as a ceiling and honors a lower user choice", () => {
    const r = sizePosition({
      approvedNotionalUsd: 100,
      availableMarginUsd: 100,
      bounds: {
        exchangeMaxLeverage: 100,
        requestedLeverage: 37,
        strategyMaxLeverage: 100,
        accountMaxLeverage: 75,
        riskMaxLeverage: 60,
        metadataAgeMs: 0,
        maxMetadataAgeMs: 60_000,
        minLiquidationDistancePct: 0,
        adverseMovePct: 0,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.approvedLeverage).toBe(37);
      expect(r.decision.limitingReason).toBe("requested");
    }
  });

  it("uses the lowest verified ceiling across venue, account, strategy, and risk", () => {
    const r = sizePosition({
      approvedNotionalUsd: 100,
      availableMarginUsd: 100,
      bounds: {
        exchangeMaxLeverage: 100,
        requestedLeverage: 90,
        strategyMaxLeverage: 80,
        accountMaxLeverage: 50,
        riskMaxLeverage: 60,
        metadataAgeMs: 0,
        maxMetadataAgeMs: 60_000,
        minLiquidationDistancePct: 0,
        adverseMovePct: 0,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.approvedLeverage).toBe(50);
      expect(r.decision.limitingReason).toBe("account_max");
    }
  });

});
