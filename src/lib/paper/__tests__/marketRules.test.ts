import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPaperQuantityRules, parsePaperQuantityRules } from "../marketRules";
const contract = { symbol: "SOL-USDT", symbolDisplayName: "SOLUSDT", stepSize: "0.1", minOrderSize: "0.1" };
const body = (row: unknown = contract) => ({ data: { contractConfig: { perpetualContract: [row] } } });
afterEach(() => vi.unstubAllGlobals());
describe("paper contract precision", () => {
  it("uses exact symbol metadata", () => {
    expect(parsePaperQuantityRules(body(), "SOL-USDT")).toEqual({ stepSize: 0.1, minOrderSize: 0.1 });
    expect(() => parsePaperQuantityRules(body(), "BTC-USDT")).toThrow("unavailable");
  });
  it.each([null, 0, "NaN", "Infinity", -1])("rejects invalid increments %s", (stepSize) => {
    expect(() => parsePaperQuantityRules(body({ ...contract, stepSize }), "SOL-USDT")).toThrow("unavailable");
  });
  it("rejects unavailable and malformed contracts", () => {
    for (const value of [body({ ...contract, enableTrade: false }), body({ ...contract, minOrderSize: null }), {}]) {
      expect(() => parsePaperQuantityRules(value, "SOL-USDT")).toThrow("unavailable");
    }
  });
  it("fetches only the public metadata endpoint and rejects HTTP failures", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => body() })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetch);
    expect(await fetchPaperQuantityRules("SOL-USDT")).toEqual({ stepSize: 0.1, minOrderSize: 0.1 });
    expect(fetch.mock.calls[0][0]).toBe("https://omni.apex.exchange/api/v3/symbols");
    await expect(fetchPaperQuantityRules("SOL-USDT")).rejects.toThrow("could not be loaded");
  });
});
