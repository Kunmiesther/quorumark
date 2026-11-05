import { describe, expect, it } from "vitest";
import { manualLiveRiskRejection, validateManualLiveTestInput } from "../manualLiveTest.functions";

const valid = {
  symbol: "ETH-USDT",
  side: "BUY" as const,
  size: 0.01,
  leverage: 5,
  estNotionalUsd: 35,
};

describe("manual live test input", () => {
  it("keeps the user-selected leverage in the validated request", () => {
    expect(validateManualLiveTestInput(valid).leverage).toBe(5);
  });

  it.each([0, 1.5, 101, Number.NaN])("rejects invalid leverage %s", (leverage) => {
    expect(() => validateManualLiveTestInput({ ...valid, leverage })).toThrow("INVALID_LEVERAGE");
  });

  it("accepts only the four internal canary symbols", () => {
    for (const symbol of ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]) {
      expect(validateManualLiveTestInput({ ...valid, symbol }).symbol).toBe(symbol);
    }
    expect(() => validateManualLiveTestInput({ ...valid, symbol: "DOGE-USDT" })).toThrow(
      "INVALID_SYMBOL",
    );
  });
});

describe("manual live risk limits", () => {
  const limits = {
    maxLeverage: 5,
    maxOrderSizeUsd: 25,
    maxTotalExposureUsd: 100,
    dailyLossLimitUsd: 10,
  };

  it("allows an order inside every user boundary", () => {
    expect(manualLiveRiskRejection(20, 5, 50, -2, limits)).toBeNull();
  });

  it("blocks order, total exposure, and daily-loss breaches", () => {
    expect(manualLiveRiskRejection(26, 5, 0, 0, limits)).toBe("ORDER_ABOVE_USER_LIMIT_25");
    expect(manualLiveRiskRejection(20, 5, 90, 0, limits)).toBe(
      "TOTAL_EXPOSURE_ABOVE_USER_LIMIT_100",
    );
    expect(manualLiveRiskRejection(20, 5, 0, -10, limits)).toBe("DAILY_LOSS_LIMIT_REACHED_10");
  });

  it("blocks leverage above the owner's configured ceiling", () => {
    expect(manualLiveRiskRejection(20, 6, 0, 0, limits)).toBe("LEVERAGE_ABOVE_USER_LIMIT_5");
  });
});
