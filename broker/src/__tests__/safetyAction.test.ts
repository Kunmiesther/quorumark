import { describe, expect, it } from "vitest";

import {
  cancellableClientOrderIds,
  reduceOnlyCloseIntents,
  SafetyActionSchema,
} from "../safetyAction.js";

describe("safety actions", () => {
  it("accepts only an exact connection id", () => {
    expect(
      SafetyActionSchema.safeParse({ connection_id: "43f2c6e4-05d0-4cf2-9473-ae7fa6f95aae" })
        .success,
    ).toBe(true);
    expect(
      SafetyActionSchema.safeParse({
        connection_id: "43f2c6e4-05d0-4cf2-9473-ae7fa6f95aae",
        symbol: "BTC-USDT",
      }).success,
    ).toBe(false);
  });

  it("derives close side and size exclusively from venue positions", () => {
    expect(
      reduceOnlyCloseIntents([
        { symbol: "BTC-USDT", side: "LONG", size: "0.01", leverage: "5" },
        { symbol: "ETH-USDT", side: "SHORT", size: 0.2, leverage: null },
      ]),
    ).toEqual([
      { symbol: "BTC-USDT", side: "SELL", size: 0.01, leverage: 5 },
      { symbol: "ETH-USDT", side: "BUY", size: 0.2, leverage: 1 },
    ]);
  });

  it("drops malformed and unsupported venue rows", () => {
    expect(
      reduceOnlyCloseIntents([
        { symbol: "DOGE-USDT", side: "LONG", size: 1 },
        { symbol: "BTC-USDT", side: "UNKNOWN", size: 1 },
        { symbol: "SOL-USDT", side: "LONG", size: 0 },
      ]),
    ).toEqual([]);
  });

  it("deduplicates cancellable client order ids", () => {
    expect(
      cancellableClientOrderIds([
        { client_order_id: "alpha" },
        { client_order_id: "alpha" },
        { client_order_id: "" },
        {},
        { client_order_id: "beta" },
      ]),
    ).toEqual(["alpha", "beta"]);
  });
});
