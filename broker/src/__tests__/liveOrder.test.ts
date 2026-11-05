import { describe, expect, it } from "vitest";
import {
  BROKER_CANARY_MAX_LEVERAGE,
  BROKER_CANARY_MAX_NOTIONAL_USD,
  INTERNAL_LIVE_SYMBOLS,
  LiveOrderSchema,
  liveOrderRiskRejection,
} from "../liveOrder";

const valid = {
  connection_id: "00000000-0000-4000-8000-000000000001",
  client_order_id: "canary-12345678",
  symbol: "ETH-USDT",
  side: "BUY",
  order_type: "MARKET",
  size: 0.01,
  leverage: 5,
  est_notional_usd: 24,
  reduce_only: false,
  environment: "mainnet",
  purpose: "internal_owner_canary",
};

describe("internal live-order contract", () => {
  it("accepts only the four internal canary markets", () => {
    expect(INTERNAL_LIVE_SYMBOLS).toEqual(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]);
    expect(LiveOrderSchema.safeParse(valid).success).toBe(true);
    expect(LiveOrderSchema.safeParse({ ...valid, symbol: "DOGE-USDT" }).success).toBe(false);
  });

  it("does not trust identity or venue fields from the caller", () => {
    expect(LiveOrderSchema.safeParse({ ...valid, user_id: "spoofed" }).success).toBe(false);
    expect(LiveOrderSchema.safeParse({ ...valid, venue: "other" }).success).toBe(false);
  });

  it("hard-caps the owner canary before signer forwarding", () => {
    expect(
      LiveOrderSchema.safeParse({ ...valid, leverage: BROKER_CANARY_MAX_LEVERAGE + 1 }).success,
    ).toBe(false);
    expect(
      LiveOrderSchema.safeParse({
        ...valid,
        est_notional_usd: BROKER_CANARY_MAX_NOTIONAL_USD + 0.01,
      }).success,
    ).toBe(false);
  });

  it("enforces configured exposure and loss boundaries", () => {
    const limits = {
      maxLeverage: 5,
      maxOrderSizeUsd: 25,
      maxTotalExposureUsd: 100,
      dailyLossLimitUsd: 10,
    };
    expect(liveOrderRiskRejection(valid, 70, -2, limits)).toBeNull();
    expect(liveOrderRiskRejection(valid, 90, 0, limits)).toBe("TOTAL_EXPOSURE_ABOVE_LIMIT_100");
    expect(liveOrderRiskRejection(valid, 0, -10, limits)).toBe("DAILY_LOSS_LIMIT_REACHED_10");
  });
});
