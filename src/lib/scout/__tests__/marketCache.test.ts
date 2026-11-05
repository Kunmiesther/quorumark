import { describe, expect, it, vi } from "vitest";
import { createMarketCache } from "@/lib/scout/marketCache";

function fakeApexBody(sym: string, intervalMs: number, count: number, endTs: number) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = endTs - i * intervalMs;
    rows.push({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 });
  }
  return { data: { [sym]: rows } };
}

describe("marketCache", () => {
  it("caches within TTL and coalesces in-flight fetches", async () => {
    const now = 1_700_000_000_000;
    const sym = "BTCUSDT";
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls++;
      return new Response(JSON.stringify(fakeApexBody(sym, 5 * 60_000, 200, now - 5 * 60_000)));
    }) as unknown as typeof fetch;

    const cache = createMarketCache({ fetchImpl });
    // Two concurrent callers → one fetch.
    const [a, b] = await Promise.all([
      cache.getCandles("BTC-USDT", "M5", now),
      cache.getCandles("BTC-USDT", "M5", now),
    ]);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    expect(calls).toBe(1);

    // Second call within TTL → cache hit.
    await cache.getCandles("BTC-USDT", "M5", now + 10_000);
    expect(calls).toBe(1);
  });

  it("refetches after TTL expires", async () => {
    const now = 1_700_000_000_000;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify(fakeApexBody("BTCUSDT", 60 * 60_000, 200, now)));
    }) as unknown as typeof fetch;
    const cache = createMarketCache({ fetchImpl, ttls: { H1: 1000 } });
    await cache.getCandles("BTC-USDT", "H1", now);
    await cache.getCandles("BTC-USDT", "H1", now + 2000);
    expect(calls).toBe(2);
  });

  it("drops the currently forming candle", async () => {
    const now = 1_700_000_000_000;
    const intervalMs = 5 * 60_000;
    // One "closed" candle at now - 5m and one still-forming at now
    const body = {
      data: {
        BTCUSDT: [
          { t: now - intervalMs, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
          { t: now, o: 1.5, h: 2, l: 1, c: 1.8, v: 1 }, // forming
        ],
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const cache = createMarketCache({ fetchImpl });
    const c = await cache.getCandles("BTC-USDT", "M5", now);
    expect(c.length).toBe(1);
    expect(c[0][0]).toBe(now - intervalMs);
  });
});
