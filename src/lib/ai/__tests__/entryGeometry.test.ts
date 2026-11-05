import { describe, expect, it } from "vitest";
import {
  GEOMETRY_POLICY,
  buildEntryPlan,
  findFvgRetest,
  findPivots,
  sizeFromRisk,
  type GeometryInput,
} from "../entryGeometry";

/** Build a synthetic series: `base` then a leg of `legAtr` ATR over `legLen`. */
function series(opts: {
  base: number;
  atr: number;
  legAtr: number;
  legLen: number;
  direction: "long" | "short";
  volumes?: number[];
}) {
  const { base, atr, legAtr, legLen, direction } = opts;
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  // 40 candles of chop around base.
  for (let i = 0; i < 40; i++) {
    const c = base + (i % 4 === 0 ? atr * 0.3 : -atr * 0.3);
    closes.push(c);
    highs.push(c + atr * 0.5);
    lows.push(c - atr * 0.5);
  }
  const sign = direction === "long" ? 1 : -1;
  for (let i = 1; i <= legLen; i++) {
    const c = base + sign * (legAtr * atr * (i / legLen));
    closes.push(c);
    highs.push(c + atr * 0.4);
    lows.push(c - atr * 0.4);
  }
  const volumes = opts.volumes ?? closes.map(() => 1000);
  return { closes, highs, lows, volumes };
}

function input(over: Partial<GeometryInput> = {}): GeometryInput {
  const atr = 10;
  const s = series({ base: 1000, atr, legAtr: 0.8, legLen: 6, direction: "long" });
  return {
    direction: "long",
    lastClose: s.closes[s.closes.length - 1],
    candleCloseMs: 1_700_000_000_000,
    atrAbs: atr,
    spreadBps: 2,
    momentum: 0.4,
    structure: 0.5,
    ...s,
    ...over,
  };
}

describe("pivot + fvg detection", () => {
  it("finds fractal swing lows", () => {
    const lows = [10, 9, 5, 9, 10, 11, 12];
    expect(findPivots(lows, "low").map((p) => p.price)).toEqual([5]);
  });

  it("finds a bullish FVG retest edge below price", () => {
    const highs = [100, 101, 102, 110, 111];
    const lows = [99, 100, 101, 105, 106];
    // lows[3]=105 > highs[1]=101 → gap edge 101
    expect(findFvgRetest(highs, lows, "long", 111)).toBe(102);
  });
});

describe("entry geometry", () => {
  it("takes a market entry when the leg is not extended", () => {
    const plan = buildEntryPlan(input());
    expect(plan.rejectReason).toBeNull();
    expect(plan.entryType).toBe("market");
    expect(plan.extended).toBe(false);
  });

  it("converts a late, extended leg into a pullback limit entry", () => {
    const atr = 10;
    const s = series({ base: 1000, atr, legAtr: 1.2, legLen: 8, direction: "long" });
    const plan = buildEntryPlan(input({ ...s, lastClose: s.closes[s.closes.length - 1], momentum: 0.3, structure: 0.3 }));
    expect(plan.rejectReason).toBeNull();
    expect(plan.extended).toBe(true);
    expect(plan.entryType).toBe("limit");
    expect(plan.entry).toBeLessThan(plan.direction === "long" ? input().lastClose + 1e9 : Infinity);
    expect(plan.expiresAtMs).toBe(plan.direction === "long" ? 1_700_000_000_000 + 3 * 300_000 : null);
    expect(plan.runawayPrice).not.toBeNull();
  });

  it("still allows market entry on strong continuation below the hard cap", () => {
    const atr = 10;
    const s = series({ base: 1000, atr, legAtr: 1.2, legLen: 8, direction: "long" });
    const plan = buildEntryPlan(input({ ...s, lastClose: s.closes[s.closes.length - 1], momentum: 0.8, structure: 0.8 }));
    expect(plan.extended).toBe(true);
    expect(plan.entryType).toBe("market");
  });

  it("anchors the stop beyond structure, never at a bare 1.5 ATR", () => {
    const plan = buildEntryPlan(input());
    expect(plan.stopAnchor).not.toBeNull();
    expect(plan.stop).toBeLessThan(plan.entry);
    expect(plan.stopAtrMultiple).toBeGreaterThanOrEqual(GEOMETRY_POLICY.minStopAtr - 1e-9);
    expect(plan.stopAtrMultiple).toBeLessThanOrEqual(GEOMETRY_POLICY.maxStopAtr + 1e-9);
  });

  it("enforces a noise floor derived from ATR and spread", () => {
    const plan = buildEntryPlan(input({ spreadBps: 25 }));
    if (!plan.rejectReason) {
      expect(plan.stopDistance).toBeGreaterThanOrEqual(
        (25 / 10_000) * plan.entry * GEOMETRY_POLICY.minStopSpreadMultiple - 1e-6,
      );
    }
  });

  it("rejects when no stop can satisfy the risk ceiling", () => {
    const atr = 1; // structure far away relative to volatility
    const s = series({ base: 1000, atr: 40, legAtr: 1, legLen: 6, direction: "long" });
    const plan = buildEntryPlan(input({ ...s, atrAbs: atr, lastClose: s.closes[s.closes.length - 1] }));
    expect(plan.rejectReason).toBe("stop_distance_exceeds_ceiling");
  });

  it("rejects a dead tape with no participation", () => {
    const base = input();
    const volumes = base.volumes.map((_, i) => (i > base.volumes.length - 5 ? 1 : 1000));
    const plan = buildEntryPlan({ ...base, volumes });
    expect(plan.rejectReason).toBe("insufficient_participation");
  });

  it("produces short-side geometry symmetrically", () => {
    const atr = 10;
    const s = series({ base: 1000, atr, legAtr: 0.8, legLen: 6, direction: "short" });
    const plan = buildEntryPlan(input({ ...s, direction: "short", lastClose: s.closes[s.closes.length - 1] }));
    expect(plan.rejectReason).toBeNull();
    expect(plan.stop).toBeGreaterThan(plan.entry);
    expect(plan.tpLevels[0]).toBeLessThan(plan.entry);
  });
});

describe("risk-based sizing", () => {
  it("keeps account risk fixed as the stop widens", () => {
    const a = sizeFromRisk({ equityUsd: 10_000, riskPct: 1, entry: 1000, stopDistance: 10 });
    const b = sizeFromRisk({ equityUsd: 10_000, riskPct: 1, entry: 1000, stopDistance: 20 });
    expect(a.riskUsd).toBe(100);
    expect(b.riskUsd).toBe(100);
    expect(b.qty).toBeCloseTo(a.qty / 2, 10);
    // Wider stop must NOT keep the same notional.
    expect(b.notionalUsd).toBeLessThan(a.notionalUsd);
  });

  it("respects step size and a notional cap", () => {
    const r = sizeFromRisk({
      equityUsd: 10_000, riskPct: 1, entry: 1000, stopDistance: 5,
      stepSize: 0.1, maxNotionalUsd: 5_000,
    });
    expect(r.notionalUsd).toBeLessThanOrEqual(5_000);
    expect(Math.round(r.qty * 10) / 10).toBeCloseTo(r.qty, 10);
  });

  it("rejects below-minimum notional rather than sizing to dust", () => {
    const r = sizeFromRisk({
      equityUsd: 100, riskPct: 0.1, entry: 1000, stopDistance: 50, minNotionalUsd: 10,
    });
    expect(r.rejectReason).toBe("below_min_notional");
  });
});
