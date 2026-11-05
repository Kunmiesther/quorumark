import { describe, it, expect } from "vitest";
import {
  computeTrend, trendAllowsDirection,
  TREND_EMA_PERIOD, TREND_SLOPE_LOOKBACK,
  type Candle,
} from "./signal";

function mkCandle(ts: number, close: number): Candle {
  return [ts, close, close, close, close, 1];
}

/** Generate n synthetic 5m candles whose close follows f(i). */
function series(n: number, f: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(mkCandle(i * 300_000, f(i)));
  return out;
}

const N = TREND_EMA_PERIOD + TREND_SLOPE_LOOKBACK + 5;

describe("computeTrend (Scout filter)", () => {
  it("returns neutral during warmup", () => {
    const t = computeTrend(series(TREND_EMA_PERIOD - 1, () => 100));
    expect(t.state).toBe("neutral");
    expect(t.reason).toBe("warmup");
  });

  it("detects UP on a steadily rising series", () => {
    // +0.15% per candle -> EMA clearly rising, close well above EMA.
    const t = computeTrend(series(N, (i) => 100 * (1 + 0.0015 * i)));
    expect(t.state).toBe("up");
    expect(t.slopePct).not.toBeNull();
    expect((t.slopePct as number) > 0).toBe(true);
  });

  it("detects DOWN on a steadily falling series", () => {
    const t = computeTrend(series(N, (i) => 100 * (1 - 0.0015 * i)));
    expect(t.state).toBe("down");
    expect((t.slopePct as number) < 0).toBe(true);
  });

  it("returns NEUTRAL on flat prices", () => {
    const t = computeTrend(series(N, () => 100));
    expect(t.state).toBe("neutral");
  });

  it("gates directions correctly", () => {
    expect(trendAllowsDirection("up", "long")).toBe(true);
    expect(trendAllowsDirection("up", "short")).toBe(false);
    expect(trendAllowsDirection("down", "short")).toBe(true);
    expect(trendAllowsDirection("down", "long")).toBe(false);
    // Neutral default: allow both.
    expect(trendAllowsDirection("neutral", "long")).toBe(true);
    expect(trendAllowsDirection("neutral", "short")).toBe(true);
    // Neutral with block-on-neutral flag: block both.
    expect(trendAllowsDirection("neutral", "long", true)).toBe(false);
    expect(trendAllowsDirection("neutral", "short", true)).toBe(false);
  });
});
