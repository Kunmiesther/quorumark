import { describe, expect, it } from "vitest";
import { readPositionProtection } from "../positionProtection";

const order = {
  id: "tp",
  symbol: "BTC-USDT",
  side: "BUY",
  type: "TAKE_PROFIT_MARKET",
  price: "0",
  triggerPrice: "80000",
  reduceOnly: true,
  status: "NEW",
  size: "0.003",
};
describe("reconciled position protection", () => {
  it("reads actual Aster TP/SL even when bot TP fields are empty", () => {
    const protection = readPositionProtection(
      [order, { ...order, id: "sl", type: "STOP_MARKET", triggerPrice: "86000" }],
      "BTC-USDT",
      "short",
    );
    expect(protection.takeProfits[0]).toMatchObject({ price: 80000, quantity: 0.003 });
    expect(protection.stops[0].price).toBe(86000);
  });
  it("keeps multiple partial TPs and their quantities rather than picking just one", () => {
    const protection = readPositionProtection(
      [
        {
          ...order,
          id: "tp1",
          symbol: "TAKE-USDT",
          side: "SELL",
          triggerPrice: "0.07",
          size: "11000",
        },
        {
          ...order,
          id: "tp2",
          symbol: "TAKE-USDT",
          side: "SELL",
          triggerPrice: "0.06599",
          size: "5000",
        },
      ],
      "TAKE-USDT",
      "long",
    );
    expect(protection.takeProfits.map((p) => [p.price, p.quantity])).toEqual([
      [0.06599, 5000],
      [0.07, 11000],
    ]);
  });
  it("accepts normalized ApeX fields, string flags, and a valid trigger after a zero field", () => {
    const protection = readPositionProtection(
      [
        {
          symbol: "BTCUSDT",
          side: "BUY",
          order_type: "STOP_LIMIT",
          stop_price: "0",
          trigger_price: "86000",
          reduce_only: "true",
          quantity: "0.003",
        },
      ],
      "BTC-USDT",
      "short",
    );
    expect(protection.stops[0].price).toBe(86000);
  });
  it.each([
    { status: "CANCELED" },
    { status: "FILLED" },
    { status: "REJECTED" },
    { symbol: "ETH-USDT" },
    { side: "SELL" },
    { positionSide: "LONG" },
    { reduceOnly: false },
    { reduceOnly: "false" },
    { reduceOnly: undefined },
    { triggerPrice: "0" },
    { triggerPrice: "NaN" },
    { triggerPrice: "Infinity" },
  ])("rejects non-protective or unrelated orders %j", (patch) => {
    expect(
      readPositionProtection([{ ...order, ...patch }], "BTC-USDT", "short").takeProfits,
    ).toEqual([]);
  });
  it("recognizes close-position orders without treating missing flags as true", () => {
    const result = readPositionProtection(
      [{ ...order, reduceOnly: false, closePosition: "true", size: "0" }],
      "BTC-USDT",
      "short",
    );
    expect(result.takeProfits[0]).toMatchObject({ closePosition: true, quantity: null });
  });
  it("does not label an arbitrary reduce-only limit as TP without its recorded ID", () => {
    const limit = { ...order, type: "LIMIT", price: "80000", triggerPrice: "0" };
    expect(readPositionProtection([limit], "BTC-USDT", "short").takeProfits).toEqual([]);
    expect(readPositionProtection([limit], "BTC-USDT", "short", "tp").takeProfits[0].price).toBe(
      80000,
    );
  });
  it("does not present trailing activation as a fixed stop or duplicate levels", () => {
    const result = readPositionProtection(
      [order, order, { ...order, id: "trailing", type: "TRAILING_STOP_MARKET" }],
      "BTC-USDT",
      "short",
    );
    expect(result.takeProfits).toHaveLength(1);
    expect(result.stops).toEqual([]);
    expect(readPositionProtection(null, "BTC-USDT", "short")).toEqual({
      takeProfits: [],
      stops: [],
    });
  });
});
