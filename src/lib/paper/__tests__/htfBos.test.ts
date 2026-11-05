import { describe, it, expect } from "vitest";
import { detectHtfBos, MIN_HTF_CANDLES_FOR_BOS } from "../htfBos";
import type { Candle } from "../signal";

const HOUR = 60 * 60 * 1000;
const TICK = 0.01;

function mk(i: number, o: number, h: number, l: number, c: number): Candle {
  return [i * HOUR, o, h, l, c, 1];
}

/** Flat baseline, then a strict pivot high, then a decisive close-above break. */
function bullishSeries(): Candle[] {
  const out: Candle[] = [];
  // 20 boring flat candles around 100
  for (let i = 0; i < 20; i++) out.push(mk(i, 100, 100.5, 99.5, 100));
  // strict pivot high at i=22 (neighbours i=20,21,23,24 all lower)
  out.push(mk(20, 100, 100.5, 99.5, 100));
  out.push(mk(21, 100, 100.5, 99.5, 100));
  out.push(mk(22, 100, 105, 99.5, 101));      // pivot high = 105
  out.push(mk(23, 100, 100.5, 99.5, 100));
  out.push(mk(24, 100, 100.5, 99.5, 100));
  // slow rise so EMA moves under price
  for (let i = 25; i < 40; i++) out.push(mk(i, 100 + (i - 25) * 0.2, 100 + (i - 25) * 0.2 + 0.3, 100 + (i - 25) * 0.2 - 0.3, 100 + (i - 25) * 0.2));
  // decisive break candle: close well above 105 AND above EMA
  out.push(mk(40, 103, 108, 102.5, 107));
  // follow-through
  for (let i = 41; i < 45; i++) out.push(mk(i, 107, 108, 106, 107));
  return out;
}

function bearishSeries(): Candle[] {
  return bullishSeries().map((c, i): Candle => [c[0], 200 - c[1], 200 - c[3], 200 - c[2], 200 - c[4], c[5]]);
}

function chopSeries(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const p = 100 + Math.sin(i / 3) * 0.3;
    out.push(mk(i, p, p + 0.2, p - 0.2, p));
  }
  return out;
}

describe("htfBos.detectHtfBos", () => {
  it("returns none when candles < MIN_HTF_CANDLES_FOR_BOS", () => {
    const tiny: Candle[] = [];
    for (let i = 0; i < MIN_HTF_CANDLES_FOR_BOS - 1; i++) {
      tiny.push(mk(i, 100, 101, 99, 100));
    }
    const r = detectHtfBos(tiny, TICK);
    expect(r.state).toBe("none");
    expect(r.confirmedAtTs).toBeNull();
    expect(r.brokenLevel).toBeNull();
    expect(r.barsSinceConfirm).toBeNull();
  });

  it("does not throw on very small (<13) input", () => {
    const tiny: Candle[] = [mk(0, 1, 1, 1, 1), mk(1, 1, 1, 1, 1)];
    expect(() => detectHtfBos(tiny, TICK)).not.toThrow();
    expect(detectHtfBos(tiny, TICK).state).toBe("none");
  });

  it("detects a bullish BOS on a synthetic upside-break series", () => {
    const r = detectHtfBos(bullishSeries(), TICK);
    expect(r.state).toBe("bullish_bos");
    expect(r.confirmedAtTs).not.toBeNull();
    expect(r.brokenLevel).not.toBeNull();
    expect(r.barsSinceConfirm).not.toBeNull();
    expect(r.barsSinceConfirm!).toBeGreaterThanOrEqual(0);
  });

  it("detects a bearish BOS on the mirrored downside-break series", () => {
    const r = detectHtfBos(bearishSeries(), TICK);
    expect(r.state).toBe("bearish_bos");
    expect(r.confirmedAtTs).not.toBeNull();
  });

  it("returns none on a chop series with no strict pivots + break", () => {
    const r = detectHtfBos(chopSeries(), TICK);
    expect(r.state).toBe("none");
  });

  it("supersedes prior state when an opposite break confirms later", () => {
    // bullish followed by a mirrored downside break at the end
    const bull = bullishSeries();
    const tailStartIdx = bull.length;
    const tail: Candle[] = [];
    // stage a strict pivot LOW then a decisive close-below break
    for (let k = 0; k < 3; k++) tail.push(mk(tailStartIdx + k, 107, 107.5, 106.5, 107));
    tail.push(mk(tailStartIdx + 3, 107, 107.5, 90, 100));     // pivot low 90
    for (let k = 4; k < 6; k++) tail.push(mk(tailStartIdx + k, 100, 100.5, 99.5, 100));
    // decisive break: close well below 90 and below EMA
    tail.push(mk(tailStartIdx + 6, 95, 96, 80, 82));
    tail.push(mk(tailStartIdx + 7, 82, 83, 80, 82));
    const combined = [...bull, ...tail];
    const r = detectHtfBos(combined, TICK);
    expect(r.state).toBe("bearish_bos");
  });
});
