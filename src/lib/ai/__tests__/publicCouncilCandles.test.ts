import { afterEach, describe, expect, it, vi } from "vitest";
import { publicCouncilCandles } from "../publicCouncilCandles.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Council venue evidence", () => {
  it.each([
    [60, "1h"],
    [240, "4h"],
  ] as const)("requests native %i-minute Aster bars", async (minutes, token) => {
    const frame = minutes * 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(frame * 4 + 100);
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        [frame, "10", "12", "9", "11", "100"],
        [frame * 2, "11", "13", "10", "12", "110"],
        [frame * 4, "11", "13", "10", "12", "110"],
      ],
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await publicCouncilCandles("aster", "ETH-USDT", minutes, 200)).toHaveLength(2);
    expect(fetcher.mock.calls[0][0]).toContain(`interval=${token}&limit=200`);
  });
  it("reads Aster V3, excludes unclosed bars, and never requests ApeX", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(900_100);
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        [300_000, "10", "12", "9", "11", "100"],
        [600_000, "11", "13", "10", "12", "110"],
        [900_000, "12", "14", "11", "13", "120"],
      ],
    });
    vi.stubGlobal("fetch", fetcher);
    const candles = await publicCouncilCandles("Aster", "BTC-USDT");
    expect(candles).toHaveLength(2);
    expect(fetcher.mock.calls[0][0]).toContain(
      "https://fapi.asterdex.com/fapi/v3/klines?symbol=BTCUSDT",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports unsupported feeds rather than silently switching venue", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(publicCouncilCandles("SynFutures", "BTC-USDC")).rejects.toThrow(
      "not connected yet",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not turn an exchange failure into invented candle data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(publicCouncilCandles("Aster", "BTC-USDT")).rejects.toThrow("HTTP 503");
  });
});
