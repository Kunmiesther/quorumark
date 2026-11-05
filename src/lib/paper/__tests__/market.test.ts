import { describe, expect, it } from "vitest";
import { fetchCandlesBounded } from "../market";
import type { FetchedFeed } from "../feed";

const goodFeed: FetchedFeed = {
  symbol: "BTC-USDT",
  raw_symbol: "BTCUSDT",
  interval_min: 5,
  candles: [[0, 1, 1, 1, 1, 1]],
  tick: 0.1,
  fetched_at_ms: 0,
};

describe("fetchCandlesBounded", () => {
  it("returns ok with feed unchanged when provider succeeds", async () => {
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      fetcher: async () => goodFeed,
    });
    expect(res).toEqual({ ok: true, feed: goodFeed });
  });

  it("returns timeout when provider exceeds the wall-clock bound", async () => {
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      timeoutMs: 10,
      fetcher: () =>
        new Promise<FetchedFeed>((resolve) => setTimeout(() => resolve(goodFeed), 200)),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("timeout");
  });

  it("classifies bad envelope errors distinctly from network errors", async () => {
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      fetcher: async () => {
        throw new Error("ApeX klines: bad envelope");
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_envelope");
  });

  it("classifies HTTP errors as network", async () => {
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      fetcher: async () => {
        throw new Error("ApeX klines HTTP 503");
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("network");
  });

  it("returns empty when provider returns zero candles", async () => {
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      fetcher: async () => ({ ...goodFeed, candles: [] }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");
  });

  it("returns aborted when an already-aborted signal is passed", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await fetchCandlesBounded("BTC-USDT", 5, 10, 0.1, {
      signal: ctrl.signal,
      fetcher: async () => goodFeed,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("aborted");
  });
});
