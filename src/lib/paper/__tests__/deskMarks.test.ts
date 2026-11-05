import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPaperQuote, paperValuation } from "../deskMarks";
const now = 1_000_000;
const position = { pair: "BTC-USDT", side: "long" as const, entry: 100, size: 2, estimatedMargin: 20 };
const quote = { symbol: "BTCUSDT", price: 105, fetchedAt: now };
afterEach(() => vi.unstubAllGlobals());
describe("paper position valuation", () => {
  it("values long and short independently and uses margin for ROI", () => {
    expect(paperValuation(position, quote, now)).toEqual({ mark: 105, pnl: 10, pnlPct: 50 });
    expect(paperValuation({ ...position, side: "short" }, quote, now).pnl).toBe(-10);
  });
  it("allows a fresh unchanged price and real zero PnL", () => {
    expect(paperValuation(position, { ...quote, price: 100 }, now)).toEqual({ mark: 100, pnl: 0, pnlPct: 0 });
  });
  it.each([null, { ...quote, symbol: "ETHUSDT" }, { ...quote, fetchedAt: now - 30_001 },
    { ...quote, fetchedAt: now + 5_001 }, { ...quote, price: NaN }, { ...quote, price: 0 }])("does not fabricate unavailable prices %j", (bad) => {
    expect(paperValuation(position, bad, now)).toEqual({ mark: null, pnl: null, pnlPct: null });
  });
  it("does not invent missing size or margin", () => {
    expect(paperValuation({ ...position, size: null }, quote, now).pnl).toBeNull();
    expect(paperValuation({ ...position, estimatedMargin: null }, quote, now).pnlPct).toBeNull();
  });
  it("uses the matching response symbol, not the first returned ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { symbol: "ETHUSDT", markPrice: "2" }, { symbol: "BTCUSDT", markPrice: "105" },
    ] }) }));
    expect((await fetchPaperQuote("BTC-USDT")).price).toBe(105);
  });
  it("rejects wrong-symbol responses and unavailable feeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ symbol: "ETHUSDT", lastPrice: 2 }] }) }));
    await expect(fetchPaperQuote("BTC-USDT")).rejects.toThrow("No verified price");
  });
});
