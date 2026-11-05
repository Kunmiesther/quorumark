import { describe, expect, it, vi } from "vitest";
import { createMarketCache } from "@/lib/scout/marketCache";
import { scoreTimeframe } from "@/lib/scout/intelligence";
import { computeConsensus } from "@/lib/scout/consensus";
import { TIMEFRAMES, type Timeframe } from "@/lib/scout/types";
import type { Candle } from "@/lib/paper/signal";

const TF_MS: Record<Timeframe, number> = {
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D: 24 * 60 * 60_000,
  W: 7 * 24 * 60 * 60_000,
  M: 30 * 24 * 60 * 60_000,
};

function trendingRows(sym: string, tfMs: number, count: number, endTs: number) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = endTs - i * tfMs;
    const base = 100 + (count - i) * 0.5; // steady uptrend
    rows.push({ t, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 10 });
  }
  return { data: { [sym]: rows } };
}

describe("scout data pipeline", () => {
  it("never requests more than 200 candles from ApeX (silent-empty guard)", async () => {
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const m = /limit=(\d+)/.exec(String(url));
      if (m) seen.push(Number(m[1]));
      return new Response(JSON.stringify({ data: { BTCUSDT: [] } }));
    }) as unknown as typeof fetch;
    const cache = createMarketCache({ fetchImpl });
    for (const tf of TIMEFRAMES) {
      await cache.getCandles("BTC-USDT", tf, 1_800_000_000_000).catch(() => {});
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) expect(n).toBeLessThanOrEqual(200);
  });

  it("full seven-TF trending BTC dataset produces a nonzero published bias", () => {
    const now = 1_800_000_000_000;
    const states = TIMEFRAMES.map((tf) => {
      const rows = trendingRows("BTCUSDT", TF_MS[tf], 120, now - TF_MS[tf]).data.BTCUSDT;
      const candles: Candle[] = rows.map((r) => [r.t, r.o, r.h, r.l, r.c, r.v]);
      return scoreTimeframe(tf, candles, now);
    });
    const consensus = computeConsensus(states);
    expect(states.every((s) => s.state !== "unavailable")).toBe(true);
    expect(consensus.bias).toBe("long-priority");
    expect(consensus.availability).toBeGreaterThan(0.95);
  });

  it("empty / stale candles yield no-signal (fail closed)", () => {
    const now = 1_800_000_000_000;
    const states = TIMEFRAMES.map((tf) => scoreTimeframe(tf, [], now));
    const consensus = computeConsensus(states);
    expect(consensus.bias).toBe("no-signal");
    expect(consensus.availability).toBe(0);
  });
});
