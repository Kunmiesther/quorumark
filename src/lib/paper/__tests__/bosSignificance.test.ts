/**
 * BOS SIGNIFICANCE FILTER — unit tests for the shared primitive and its
 * two consumers (5m entry break in `signal.ts::detectBreak`, 5m adverse-BOS
 * in `pricing.ts::isAdverseBos`). The 1h HTF path shares the primitive
 * transitively through `htfBos.ts` → `evaluate()` and is covered by the
 * existing `htfBos.test.ts` suite.
 */
import { describe, it, expect } from "vitest";
import {
  meetsBosSignificance,
  BOS_MIN_DISPLACEMENT_ATR,
} from "../bosSignificance";
import { isAdverseBos } from "../pricing";
import { evaluate, type Candle } from "../signal";

describe("bosSignificance.meetsBosSignificance", () => {
  it("returns false when close exactly at level (zero displacement)", () => {
    expect(meetsBosSignificance("long", 100, 100, 1)).toBe(false);
    expect(meetsBosSignificance("short", 100, 100, 1)).toBe(false);
  });

  it("returns false at 0.24 × ATR beyond the level", () => {
    const atr = 1;
    const disp = 0.24 * atr;
    expect(meetsBosSignificance("long", 100 + disp, 100, atr)).toBe(false);
    expect(meetsBosSignificance("short", 100 - disp, 100, atr)).toBe(false);
  });

  it("returns true at 0.26 × ATR beyond the level", () => {
    const atr = 1;
    const disp = 0.26 * atr;
    expect(meetsBosSignificance("long", 100 + disp, 100, atr)).toBe(true);
    expect(meetsBosSignificance("short", 100 - disp, 100, atr)).toBe(true);
  });

  it("returns true exactly at threshold (0.25 × ATR)", () => {
    expect(BOS_MIN_DISPLACEMENT_ATR).toBe(0.25);
    expect(meetsBosSignificance("long", 100 + 0.25, 100, 1)).toBe(true);
  });

  it("returns false when ATR is null / non-positive / non-finite", () => {
    expect(meetsBosSignificance("long", 105, 100, null)).toBe(false);
    expect(meetsBosSignificance("long", 105, 100, undefined)).toBe(false);
    expect(meetsBosSignificance("long", 105, 100, 0)).toBe(false);
    expect(meetsBosSignificance("long", 105, 100, -1)).toBe(false);
    expect(meetsBosSignificance("long", 105, 100, Number.NaN)).toBe(false);
  });

  it("wrong-direction breach is never significant", () => {
    // Long "break" but close BELOW level → displacement negative.
    expect(meetsBosSignificance("long", 99, 100, 1)).toBe(false);
    expect(meetsBosSignificance("short", 101, 100, 1)).toBe(false);
  });
});

describe("pricing.isAdverseBos", () => {
  it("does NOT cut on a sub-threshold adverse poke (LTC/SOL regression)", () => {
    // LTC-SHORT observed: close 46.32 vs swing 46.3192; ATR ≈ 0.05 on a
    // 5m bar. Displacement = 0.0008. 0.25 × 0.05 = 0.0125 → floor NOT met.
    // The old code returned true and cut; the new code must return false.
    const level = 46.3192;
    const close = 46.32; // ~$0.0008 above the swing-high protective level
    const atr = 0.05;
    expect(isAdverseBos("short", close, level, atr)).toBe(false);
  });

  it("does confirm when adverse break clears the ATR floor", () => {
    const level = 46.3192;
    const atr = 0.05;
    const threshold = BOS_MIN_DISPLACEMENT_ATR * atr; // 0.0125
    const close = level + threshold + 0.001; // solidly beyond
    expect(isAdverseBos("short", close, level, atr)).toBe(true);
  });

  it("returns false when ATR is missing (ambiguous → no exit)", () => {
    expect(isAdverseBos("long", 90, 100, null)).toBe(false);
    expect(isAdverseBos("short", 110, 100, undefined)).toBe(false);
  });

  it("returns false when close is on the safe side of the swing", () => {
    // Long position, protective LOW at 100, mark 101 → not a breach.
    expect(isAdverseBos("long", 101, 100, 1)).toBe(false);
    expect(isAdverseBos("short", 99, 100, 1)).toBe(false);
  });
});

// ─── signal.ts::detectBreak significance parity ────────────────────────────
// A synthetic series that WOULD register a break under the old
// bare-close-vs-level rule but does not clear the ATR floor.

const FIVE_MIN = 5 * 60 * 1000;
function mk(i: number, o: number, h: number, l: number, c: number): Candle {
  return [i * FIVE_MIN, o, h, l, c, 1];
}

describe("signal.evaluate — BOS significance floor on entry breaks", () => {
  it("suppresses a sub-threshold long 'break' (close just barely above swing)", () => {
    // 30 flat candles then a strict pivot high; the 'break' candle closes
    // only 1 tick above the pivot — massively below 0.25 × ATR.
    const c: Candle[] = [];
    for (let i = 0; i < 20; i++) c.push(mk(i, 100, 100.5, 99.5, 100));
    // Pivot high at i=22
    c.push(mk(20, 100, 100.5, 99.5, 100));
    c.push(mk(21, 100, 100.5, 99.5, 100));
    c.push(mk(22, 100, 105, 99.5, 101));       // pivot high = 105
    c.push(mk(23, 100, 100.5, 99.5, 100));
    c.push(mk(24, 100, 100.5, 99.5, 100));
    for (let i = 25; i < 40; i++) c.push(mk(i, 104.9, 105.01, 104.8, 104.99));
    // "break" candle: close 105.01 vs level 105 → displacement 0.01,
    // ATR is ~O(0.5–1) → well below 0.25 × ATR floor.
    c.push(mk(40, 104.99, 105.02, 104.98, 105.01));
    const r = evaluate(c, "long", 0.01);
    expect(r.breaks.filter((b) => b.direction === "long")).toHaveLength(0);
  });
});
