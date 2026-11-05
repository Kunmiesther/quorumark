/**
 * Rate-limit-aware backoff test for the shared MarketCache retry path.
 *
 * A 429 response must trigger an escalated backoff (base ≥ 1s) before the
 * second attempt, so a wide-universe MTF fan-out does not hammer ApeX.
 */
import { describe, it, expect, vi } from "vitest";
import { createMarketCache } from "../marketCache";

describe("marketCache — rate-limit backoff", () => {
  it("waits noticeably longer after HTTP 429 than after a plain error", async () => {
    // Two consecutive scenarios: (a) generic failure, (b) 429.
    async function measure(status: number) {
      const times: number[] = [];
      const start = Date.now();
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        times.push(Date.now() - start);
        call++;
        if (call === 1) {
          // First call fails with the given HTTP status.
          return new Response("nope", { status });
        }
        // Second call returns a valid empty klines body so we exit fast.
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      const cache = createMarketCache({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await cache.getCandles("BTC-USDT", "M5", Date.now());
      // Gap between the two attempts is the backoff.
      return (times[1] ?? 0) - (times[0] ?? 0);
    }

    const genericGap = await measure(418); // teapot — treated as generic
    const rateGap = await measure(429);    // rate-limited
    // 429 base is 1000ms + jitter 0..600; generic base is 200ms + jitter 0..600.
    // So rate-limited gap must clearly exceed the generic gap floor of 200ms.
    expect(rateGap).toBeGreaterThanOrEqual(900);
    expect(rateGap).toBeGreaterThan(genericGap);
  }, 10_000);
});
