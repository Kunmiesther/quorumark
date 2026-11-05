import { describe, expect, it } from "vitest";
import { tradeMovePct, tradeShareText } from "./shareTrade";

describe("privacy-safe trade sharing", () => {
  it("calculates long and short movement", () => {
    expect(tradeMovePct({ symbol: "BTC-USDT", direction: "long", entry: 100, exit: 110, book: "paper" })).toBe(10);
    expect(tradeMovePct({ symbol: "BTC-USDT", direction: "short", entry: 100, exit: 90, book: "live" })).toBe(10);
  });

  it("labels paper activity and excludes sensitive financial fields", () => {
    const text = tradeShareText({ symbol: "ETH-USDT", direction: "long", entry: 100, exit: 105, book: "paper" });
    expect(text).toContain("PAPER TRADE");
    expect(text).toContain("+5.00%");
    expect(text).not.toMatch(/balance|wallet|api|position size|fees/i);
  });
});
