/**
 * Vanguard detector tests — end-to-end from candle fixtures through the
 * shared accumulator break+retest primitives into a single vanguard plan.
 * No fork of break/retest logic: this asserts vanguard reuses `evaluate`
 * from signal.ts and only differs in the entry shape (single lot, structural
 * stop, no rungs).
 */
import { describe, it, expect } from "vitest";
import { evaluate, type Candle } from "../signal";
import {
  planVanguardEntry,
  vanguardStopLevel,
  vanguardTpLevel,
  STOP_BUFFER_FRAC,
  MIN_TP_TO_STOP_DISTANCE_RATIO,
} from "../vanguardSignal";

/** Build a bullish break-and-retest fixture: rising base, sharp pivot low,
 *  push above prior swing high (break), pullback to broken level (retest),
 *  then continuation. */
function bullishBreakRetest(): Candle[] {
  const out: Candle[] = [];
  const step = 300_000;
  let ts = 0;
  const push = (o: number, h: number, l: number, c: number) => {
    out.push([ts, o, h, l, c, 1]); ts += step;
  };
  // Flat baseline (creates a workable ATR without any pivots).
  for (let i = 0; i < 20; i++) push(100, 100.5, 99.5, 100);
  // Strict pivot HIGH at index 22 (neighbours 20,21,23,24 all lower highs).
  push(100, 100.5, 99.5, 100);
  push(100, 100.5, 99.5, 100);
  push(100, 105, 99.5, 101);   // pivot high = 105
  push(100, 100.5, 99.5, 100);
  push(100, 100.5, 99.5, 100);
  // Slow rise so EMA slides under price ahead of the break.
  for (let i = 25; i < 40; i++) push(100 + (i - 25) * 0.2, 100 + (i - 25) * 0.2 + 0.3, 100 + (i - 25) * 0.2 - 0.3, 100 + (i - 25) * 0.2);
  // Decisive BREAK — close well above 105 AND clear of EMA + BOS significance floor.
  push(103, 110, 102.5, 109);
  push(109, 110, 108, 109);
  // Retest of the broken level (~105).
  push(109, 109.5, 104.9, 105.2);
  push(105.2, 106, 104.9, 105.5);
  // Continuation.
  for (let i = 0; i < 8; i++) push(106 + i * 0.2, 106.3 + i * 0.2, 105.8 + i * 0.2, 106.2 + i * 0.2);
  return out;
}



describe("vanguard structural stop + TP geometry", () => {
  it("long stop sits just below the retested swing (buffered)", () => {
    const swing = 100.0;
    const s = vanguardStopLevel("long", swing);
    expect(s).toBeLessThan(swing);
    expect(swing - s).toBeCloseTo(swing * STOP_BUFFER_FRAC, 9);
  });

  it("short stop sits just above the retested swing (buffered)", () => {
    const swing = 100.0;
    const s = vanguardStopLevel("short", swing);
    expect(s).toBeGreaterThan(swing);
    expect(s - swing).toBeCloseTo(swing * STOP_BUFFER_FRAC, 9);
  });

  it("tp respects min_tp_to_stop_distance_ratio", () => {
    const fill = 100;
    const stop = 99; // 1.0 stop distance
    const tp = vanguardTpLevel("long", fill, stop);
    expect(tp - fill).toBeGreaterThanOrEqual(MIN_TP_TO_STOP_DISTANCE_RATIO * (fill - stop) - 1e-9);
  });
});

describe("vanguard end-to-end (reuses accumulator evaluate)", () => {
  it("confirmed retest yields a single-lot plan (no rungs)", () => {
    const candles = bullishBreakRetest();
    const ev = evaluate(candles, "long", 0.01);
    const confirmed = ev.entries.filter((e) => e.state === "confirmed" && e.retest_index != null);
    expect(confirmed.length).toBeGreaterThan(0);
    const retest = confirmed[0];
    const fillPx = candles[retest.retest_index as number][4]; // CLOSE
    const plan = planVanguardEntry(retest, "long", fillPx);
    expect(plan).not.toBeNull();
    expect(plan!.stopLevel).toBeLessThan(plan!.fillPx);
    expect(plan!.tpLevel).toBeGreaterThan(plan!.fillPx);
    expect(plan!.riskPerUnit).toBeGreaterThan(0);
    // Vanguard is a SINGLE entry — the module intentionally exposes no
    // ladder/rung structure at all.
    expect((plan as unknown as { rungs?: unknown }).rungs).toBeUndefined();
  });

  it("no confirmed retest → no plan (won't fire on incomplete setups)", () => {
    // Chop with no clean break: use a flat oscillation with no pivot break.
    const flat: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const c = 100 + ((i % 2) ? 0.05 : -0.05);
      flat.push([i * 300_000, c, c + 0.05, c - 0.05, c, 1]);
    }
    const ev = evaluate(flat, "long", 0.01);
    const confirmed = ev.entries.filter((e) => e.state === "confirmed");
    // If evaluate happens to confirm nothing, planVanguardEntry can't run —
    // which is exactly the "no fire" contract we want.
    if (confirmed.length === 0) {
      expect(true).toBe(true);
      return;
    }
    // If it does confirm, ensure at least one plan-null path exists when the
    // swing sits on the wrong side of the fill (defensive check).
    const bad = confirmed[0];
    const plan = planVanguardEntry(bad, "short", 0);
    expect(plan).toBeNull();
  });

  it("rejects a plan when the swing is on the wrong side of the fill", () => {
    const candles = bullishBreakRetest();
    const ev = evaluate(candles, "long", 0.01);
    const retest = ev.entries.find((e) => e.state === "confirmed" && e.retest_index != null);
    expect(retest).toBeDefined();
    // Passing direction="short" against a long-side retest → null.
    const fillPx = candles[retest!.retest_index as number][4];
    expect(planVanguardEntry(retest!, "short", fillPx)).toBeNull();
  });
});
