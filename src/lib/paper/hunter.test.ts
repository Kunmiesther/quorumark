import { describe, it, expect } from "vitest";
import { findFvgs, findSwings, smaOf, volatilityStats } from "./hunter";
import type { Candle } from "./signal";

/** Full-OHLC candle. */
function c(ts: number, o: number, h: number, l: number, close: number): Candle {
  return [ts, o, h, l, close, 1];
}

/**
 * Flat-but-nonzero-range baseline so ATR > 0 (a truly flat series gives
 * ATR 0, which the vol gate treats as "no data" and skips). Then inject a
 * single bullish 3-candle FVG around the middle index 33 (confirm 34), which
 * is past the point where SMA(ATR,20) becomes defined (index >= 32).
 */
function seriesWithBullishFvg(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 40; i++) out.push(c(i * 300_000, 100, 101, 99, 100));
  // middle = 33: prev(32).high = 101 must be < next(34).low = 102  → gap [101,102]
  out[33] = c(33 * 300_000, 101, 110, 101, 109); // big up candle (middle)
  out[34] = c(34 * 300_000, 110, 112, 102, 111); // opens above the gap (confirm)
  return out;
}

describe("hunter FVG detection", () => {
  it("finds the bullish FVG with the right gap zone and confirm index", () => {
    const candles = seriesWithBullishFvg();
    const fvgs = findFvgs(candles, 0); // K=0 → gate always open, isolate geometry
    // The injected spike at index 33 creates a bullish gap at middle=33
    // AND a mirrored bearish gap at middle=35 as the series returns to baseline.
    // This matches hunter_signal.py exactly.
    const bull = fvgs.find((f) => f.direction === "bullish" && f.middleIndex === 33);
    expect(bull).toBeDefined();
    expect(bull!.confirmIndex).toBe(34);
    expect(bull!.gapLower).toBeCloseTo(101);
    expect(bull!.gapUpper).toBeCloseTo(102);
    expect(bull!.confirmTs).toBe(34 * 300_000);
  });

  it("the volatility gate filters FVGs out when K is impossibly high", () => {
    const candles = seriesWithBullishFvg();
    expect(findFvgs(candles, 1e9)).toHaveLength(0);
  });

  it("detects a bearish FVG (prior low above next high)", () => {
    const out: Candle[] = [];
    for (let i = 0; i < 40; i++) out.push(c(i * 300_000, 100, 101, 99, 100));
    // middle = 33: prev(32).low = 99 must be > next(34).high = 98 → bearish gap [98,99]
    out[33] = c(33 * 300_000, 99, 99, 90, 91); // big down candle
    out[34] = c(34 * 300_000, 90, 98, 88, 89); // stays below the gap
    const fvgs = findFvgs(out, 0);
    // Injected down-spike also mirrors on the recovery side — assert the target bearish FVG exists.
    const bear = fvgs.find((f) => f.direction === "bearish" && f.middleIndex === 33);
    expect(bear).toBeDefined();
    expect(bear!.gapLower).toBeCloseTo(98);
    expect(bear!.gapUpper).toBeCloseTo(99);
  });
});

describe("smaOf", () => {
  it("is null until the inclusive window is full, then the moving average", () => {
    const s = smaOf([1, 2, 3, 4, 5], 3);
    expect(s[0]).toBeNull();
    expect(s[1]).toBeNull();
    expect(s[2]).toBeCloseTo((1 + 2 + 3) / 3);
    expect(s[3]).toBeCloseTo((2 + 3 + 4) / 3);
    expect(s[4]).toBeCloseTo((3 + 4 + 5) / 3);
  });

  it("stays null across any null in the window", () => {
    const s = smaOf([1, null, 3, 4], 2);
    expect(s[1]).toBeNull();
    expect(s[2]).toBeNull();
    expect(s[3]).toBeCloseTo((3 + 4) / 2);
  });
});

describe("volatilityStats", () => {
  it("reports the fraction of candles above the gate", () => {
    const candles = seriesWithBullishFvg();
    const lo = volatilityStats(candles, 0);
    expect(lo.hotFraction).toBe(1); // every eligible candle passes K=0
    const hi = volatilityStats(candles, 1e9);
    expect(hi.hotCandles).toBe(0);
    expect(hi.eligibleCandles).toBeGreaterThan(0);
  });
});

describe("findSwings", () => {
  it("finds a strict 5-candle pivot high", () => {
    // peak at index 4
    const heights = [100, 101, 102, 103, 110, 103, 102, 101, 100];
    const candles = heights.map((h, i) => c(i * 300_000, h, h, h - 5, h - 1));
    const swings = findSwings(candles);
    expect(swings.some((s) => s.kind === "high" && s.index === 4)).toBe(true);
  });
});
