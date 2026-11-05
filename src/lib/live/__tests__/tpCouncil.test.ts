import { describe, expect, it } from "vitest";
import {
  candleProgress,
  closedCandlesSince,
  fallbackOutcome,
  nextReviewCandles,
  reviewDueAtMs,
  reviewKey,
  stateForDecision,
  timeframeMs,
  validateTpOrder,
} from "../tpCouncil";

const FIVE_M = 300_000;

describe("candle counting (never wall-clock)", () => {
  const fill = Date.UTC(2026, 7, 4, 10, 2, 30); // mid-candle fill

  it("does not count the partially formed candle containing the fill", () => {
    // 10:05 close belongs to the fill's own candle → not counted.
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 5, 0), FIVE_M)).toBe(0);
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 9, 59), FIVE_M)).toBe(0);
  });

  it("counts each fully closed candle after that", () => {
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 10, 0), FIVE_M)).toBe(1);
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 15, 0), FIVE_M)).toBe(2);
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 20, 0), FIVE_M)).toBe(3);
  });

  it("15 minutes of wall clock is not 3 closed candles when the fill is mid-candle", () => {
    const fifteenMinutesLater = fill + 15 * 60_000; // 10:17:30
    expect(closedCandlesSince(fill, fifteenMinutesLater, FIVE_M)).toBe(2);
  });

  it("treats a fill exactly on a boundary the same way", () => {
    const onBoundary = Date.UTC(2026, 7, 4, 10, 0, 0);
    expect(closedCandlesSince(onBoundary, Date.UTC(2026, 7, 4, 10, 5, 0), FIVE_M)).toBe(0);
    expect(closedCandlesSince(onBoundary, Date.UTC(2026, 7, 4, 10, 15, 0), FIVE_M)).toBe(2);
  });

  it("reports progress 0/3 through 3/3 and the due instant", () => {
    expect(candleProgress(fill, Date.UTC(2026, 7, 4, 10, 6, 0), "5m").label).toBe("0/3");
    expect(candleProgress(fill, Date.UTC(2026, 7, 4, 10, 15, 0), "5m").label).toBe("2/3");
    const due = candleProgress(fill, Date.UTC(2026, 7, 4, 10, 20, 0), "5m");
    expect(due.label).toBe("3/3");
    expect(due.due).toBe(true);
    expect(due.dueAtMs).toBe(reviewDueAtMs(fill, FIVE_M, 3));
    // Over-run stays clamped at 3/3 and still due.
    const later = candleProgress(fill, Date.UTC(2026, 7, 4, 11, 0, 0), "5m");
    expect(later.label).toBe("3/3");
    expect(later.due).toBe(true);
  });

  it("uses the execution timeframe of the accepted trade", () => {
    expect(timeframeMs("15m")).toBe(900_000);
    // 15m fill candle closes 10:15; counted closes are 10:30, 10:45, 11:00.
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 11, 0, 0), timeframeMs("15m"))).toBe(3);
    expect(closedCandlesSince(fill, Date.UTC(2026, 7, 4, 10, 46, 0), timeframeMs("15m"))).toBe(2);

    expect(() => timeframeMs("7m")).toThrow(/UNSUPPORTED_TIMEFRAME/);
  });
});

describe("restart idempotency", () => {
  it("derives the review key only from durable facts", () => {
    expect(reviewKey("pos-1", 1)).toBe("tpc:pos-1:1");
    expect(reviewKey("pos-1", 1)).toBe(reviewKey("pos-1", 1));
    expect(reviewKey("pos-1", 2)).not.toBe(reviewKey("pos-1", 1));
    expect(reviewKey("pos-2", 1)).not.toBe(reviewKey("pos-1", 1));
  });
});

describe("direction-safe TP validation", () => {
  const base = {
    markPrice: 3000,
    positionSize: 0.05,
    size: 0.05,
    tickSize: 0.1,
    stepSize: 0.01,
  };

  it("accepts a long TP above mark and quantizes away from mark", () => {
    const v = validateTpOrder({ ...base, side: "long", price: 3123.456 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.side).toBe("SELL");
      expect(v.reduceOnly).toBe(true);
      expect(Number(v.price)).toBeCloseTo(3123.5, 6);
      expect(Number(v.size)).toBeCloseTo(0.05, 8);
    }
  });

  it("accepts a short TP below mark and rounds down", () => {
    const v = validateTpOrder({ ...base, side: "short", price: 2876.44 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.side).toBe("BUY");
      expect(Number(v.price)).toBeCloseTo(2876.4, 6);
    }
  });

  it("refuses a TP on the wrong side of mark instead of correcting it", () => {
    expect(validateTpOrder({ ...base, side: "long", price: 2900 })).toEqual({
      ok: false,
      reason: "WRONG_DIRECTION",
    });
    expect(validateTpOrder({ ...base, side: "short", price: 3100 })).toEqual({
      ok: false,
      reason: "WRONG_DIRECTION",
    });
  });

  it("never exceeds the reconciled venue position size", () => {
    expect(validateTpOrder({ ...base, side: "long", price: 3100, size: 0.09 })).toEqual({
      ok: false,
      reason: "SIZE_EXCEEDS_POSITION",
    });
  });

  it("clamps a partial-fill shrunken position", () => {
    // Council approved 0.05 while the venue only shows 0.02 left.
    const v = validateTpOrder({ ...base, side: "long", price: 3100, positionSize: 0.02, size: 0.02 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(Number(v.size)).toBeCloseTo(0.02, 8);
  });

  it("refuses when the venue reports no position", () => {
    expect(validateTpOrder({ ...base, side: "long", price: 3100, positionSize: 0 })).toEqual({
      ok: false,
      reason: "NO_POSITION",
    });
  });

  it("enforces venue minimum size and notional", () => {
    expect(
      validateTpOrder({ ...base, side: "long", price: 3100, size: 0.01, minOrderSize: 0.02 }),
    ).toEqual({ ok: false, reason: "BELOW_MIN_SIZE" });
    expect(
      validateTpOrder({ ...base, side: "long", price: 3100, size: 0.01, minNotional: 100 }),
    ).toEqual({ ok: false, reason: "BELOW_MIN_NOTIONAL" });
  });

  it("refuses broken venue metadata rather than guessing", () => {
    expect(validateTpOrder({ ...base, side: "long", price: 3100, tickSize: 0 })).toEqual({
      ok: false,
      reason: "BAD_VENUE_METADATA",
    });
  });
});

describe("council failure fallback", () => {
  it("degrades to HOLD_WITHOUT_TP and schedules another review", () => {
    const out = fallbackOutcome("timeout");
    expect(out.decision).toBe("HOLD_WITHOUT_TP");
    expect(out.degraded).toBe(true);
    expect(nextReviewCandles(out.decision)).toBe(1);
    expect(stateForDecision(out.decision)).toBe("HOLD_WITHOUT_TP");
  });

  it("stops scheduling only when the position is being closed", () => {
    expect(nextReviewCandles("EXIT_NOW")).toBeNull();
    expect(nextReviewCandles("SET_TP")).toBe(1);
    expect(nextReviewCandles("TRAIL")).toBe(1);
  });
});
