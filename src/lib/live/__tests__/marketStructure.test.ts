import { describe, expect, it } from "vitest";
import { marketStructureEvidence, positionStructureRead, type MarketStructureEvidence } from "../marketStructure";
import type { Candle } from "@/lib/paper/signal";

describe("market structure evidence", () => {
  it("uses confirmed swings and reports a close beyond support without declaring a reversal", () => {
    const candles: Candle[] = Array.from({ length: 25 }, (_, index) => [
      index * 300_000,
      10,
      11,
      9,
      10,
      10,
    ]);
    candles[18] = [18 * 300_000, 10, 15, 9, 10, 10];
    candles[21] = [21 * 300_000, 10, 11, 7, 10, 10];
    candles[24] = [24 * 300_000, 10, 11, 5, 6, 20];

    const evidence = marketStructureEvidence(candles);
    expect(evidence?.confirmed_swing_high).toEqual({ price: 15, confirmed_at_ms: 20 * 300_000 });
    expect(evidence?.confirmed_swing_low).toEqual({ price: 7, confirmed_at_ms: 23 * 300_000 });
    expect(evidence?.close_below_swing_low_atr).toBeGreaterThan(0);
    expect(evidence?.last_volume_vs_prior_20).toBe(2);
    expect(evidence).not.toHaveProperty("verdict");
  });

  it("does not use an unconfirmed current-bar extreme as a swing", () => {
    const candles: Candle[] = Array.from({ length: 8 }, (_, index) => [
      index * 300_000,
      10,
      11,
      9,
      10,
      10,
    ]);
    candles[7][2] = 20;
    expect(marketStructureEvidence(candles)?.confirmed_swing_high).toBeNull();
  });

  it("returns null for an empty feed and avoids false ATR certainty on a short feed", () => {
    expect(marketStructureEvidence([])).toBeNull();
    expect(marketStructureEvidence([[0, 10, 11, 9, 10, 10]])?.atr_14).toBeNull();
  });

  it("separates a wick fakeout from a confirmed two-close breakout", () => {
    const base = (): Candle[] => {
      const candles: Candle[] = Array.from({ length: 30 }, (_, i) => [
        i * 300_000, 100, 101, 99, 100, 10,
      ]);
      candles[20] = [20 * 300_000, 100, 110, 90, 100, 10];
      return candles;
    };

    const fakeout = base();
    fakeout[29] = [29 * 300_000, 100, 112, 99, 102, 20];
    expect(marketStructureEvidence(fakeout)?.sweep_and_reclaim_high).toBe(true);
    expect(marketStructureEvidence(fakeout)?.confirmed_break_above).toBe(false);

    const breakout = base();
    breakout[28] = [28 * 300_000, 100, 112, 100, 111, 15];
    breakout[29] = [29 * 300_000, 111, 113, 110, 112, 15];
    expect(marketStructureEvidence(breakout)?.confirmed_break_above).toBe(true);
    expect(marketStructureEvidence(breakout)?.sweep_and_reclaim_high).toBe(false);

    const rejected = base();
    rejected[28] = [28 * 300_000, 100, 112, 100, 111, 15];
    rejected[29] = [29 * 300_000, 111, 112, 103, 105, 15];
    expect(marketStructureEvidence(rejected)?.rejected_breakout_high).toBe(true);
    expect(marketStructureEvidence(rejected)?.confirmed_break_above).toBe(false);
  });

  it("recognizes a rejected downside break without labeling it a confirmed reversal", () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => [
      i * 300_000, 100, 101, 99, 100, 10,
    ]);
    candles[20] = [20 * 300_000, 100, 110, 90, 100, 10];
    candles[28] = [28 * 300_000, 100, 101, 88, 89, 15];
    candles[29] = [29 * 300_000, 89, 101, 87, 100, 15];
    const evidence = marketStructureEvidence(candles);
    expect(evidence?.rejected_breakdown_low).toBe(true);
    expect(evidence?.sweep_and_reclaim_low).toBe(true);
    expect(evidence?.confirmed_break_below).toBe(false);
  });

  it("waits through a short-timeframe pullback and requires confirmation for reversal risk", () => {
    const evidence = marketStructureEvidence(Array.from({ length: 30 }, (_, i) => [
      i * 300_000, 100, 101, 99, 100, 10,
    ] as Candle));
    const fast = { ...evidence!, close_below_swing_low_atr: 0.4 } as MarketStructureEvidence;
    const base = { direction: "long" as const, fiveMinute: fast, fifteenMinute: evidence,
      hourlyTrend: "up" as const, fourHourTrend: "up" as const };
    expect(positionStructureRead(base).state).toBe("pullback");
    expect(positionStructureRead({
      ...base,
      fiveMinute: { ...fast, confirmed_break_below: true },
      fifteenMinute: { ...evidence!, confirmed_break_below: true },
    }).state).toBe("reversal_risk");
  });

  it("calls a reclaimed adverse sweep a fakeout but never grants order authority", () => {
    const fast = {
      ...marketStructureEvidence([[0, 100, 101, 99, 100, 10]] as Candle[])!,
      sweep_and_reclaim_low: true,
    };
    const read = positionStructureRead({ direction: "long", fiveMinute: fast,
      fifteenMinute: null, hourlyTrend: "flat", fourHourTrend: null });
    expect(read).toMatchObject({ state: "fakeout", posture: "patient" });
    expect(read).not.toHaveProperty("order");
  });
});
