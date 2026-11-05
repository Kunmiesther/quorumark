import { describe, it, expect } from "vitest";
import { paperDeskTicket, validatePaperProtection } from "../manualDesk";
export const ticket = {
  requestId: "00000000-0000-4000-8000-000000000001", symbol: "BTC-USDT", side: "long",
  kind: "market", marginUsd: 50, leverage: 5, limitPrice: null, takeProfit: 110,
  stopLoss: 90, dcaEnabled: false, rungCount: 1, spacingPct: 0,
};
describe("paper manual server contract", () => {
  it("accepts a complete single-entry ticket", () => expect(paperDeskTicket.safeParse(ticket).success).toBe(true));
  it.each([{ marginUsd: -1 }, { leverage: Infinity }, { requestId: "bad" }, { kind: "limit" },
    { dcaEnabled: true }, { symbol: "DOGE-USDT" }, { rungCount: 5 }])("rejects unsupported or invalid input %j", (change) => {
    expect(paperDeskTicket.safeParse({ ...ticket, ...change }).success).toBe(false);
  });
  it("validates protection against the refreshed fill", () => {
    const parsed = paperDeskTicket.parse(ticket);
    expect(() => validatePaperProtection(parsed, 100)).not.toThrow();
    expect(() => validatePaperProtection(parsed, 112)).toThrow("Take profit");
    expect(() => validatePaperProtection({ ...parsed, side: "short", takeProfit: 90, stopLoss: 110 }, 100)).not.toThrow();
    expect(() => validatePaperProtection({ ...parsed, takeProfit: null }, 89)).toThrow("Stop loss");
  });
});
