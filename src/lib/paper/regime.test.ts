import { describe, it, expect } from "vitest";
import {
  adxSeries, efficiencyRatioSeries, classifyRegime, DEFAULT_REGIME_CONFIG,
} from "./regime";
import type { Candle } from "./signal";

function c(ts: number, h: number, l: number, cl: number): Candle {
  return [ts, cl, h, l, cl, 1];
}

/** Slow clean uptrend: +0.1/bar, tight range → low ATR%, high ADX, ER≈1. */
function uptrend(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.1;
    out.push(c(i * 300_000, close + 0.1, close - 0.1, close));
  }
  return out;
}

/** Two-bar oscillation around 100: net-zero → ER≈0, low ADX, low ATR%. */
function chop(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + (i % 2) * 0.1;
    out.push(c(i * 300_000, close + 0.05, close - 0.05, close));
  }
  return out;
}

/** Wide-range bars around 100 → high ATR% regardless of direction. */
function highVol(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + (i % 2) * 0.2;
    out.push(c(i * 300_000, close + 3, close - 3, close));
  }
  return out;
}

const N = 120;

describe("efficiency ratio", () => {
  it("≈1 for a clean trend and ≈0 for chop", () => {
    const up = efficiencyRatioSeries(uptrend(N), 20);
    const ch = efficiencyRatioSeries(chop(N), 20);
    expect(up[N - 1]).toBeCloseTo(1, 2);
    expect(ch[N - 1] as number).toBeLessThan(0.2);
  });
});

describe("ADX", () => {
  it("is higher in a trend than in chop", () => {
    const up = adxSeries(uptrend(N), 14);
    const ch = adxSeries(chop(N), 14);
    expect(up[N - 1]).not.toBeNull();
    expect(ch[N - 1]).not.toBeNull();
    expect(up[N - 1] as number).toBeGreaterThan(ch[N - 1] as number);
    expect(up[N - 1] as number).toBeGreaterThan(DEFAULT_REGIME_CONFIG.adxEnter);
  });
});

describe("classifyRegime", () => {
  it("labels a clean trend as 'trend'", () => {
    expect(classifyRegime(uptrend(N)).regime).toBe("trend");
  });

  it("labels chop as 'neutral'", () => {
    expect(classifyRegime(chop(N)).regime).toBe("neutral");
  });

  it("labels wide-range tape as 'high_vol' regardless of direction", () => {
    const r = classifyRegime(highVol(N));
    expect(r.regime).toBe("high_vol");
    expect(r.atrPct as number).toBeGreaterThan(DEFAULT_REGIME_CONFIG.volEnterAtrPct);
  });
});
