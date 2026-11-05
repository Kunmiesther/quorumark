import { describe, expect, it } from "vitest";
import {
  computeTpProximity,
  formatTpDistance,
  normalizeTpLevels,
  TP_APPROACH_REMAINING,
  TP_IMMINENT_REMAINING,
} from "@/lib/trade/tpProximity";

const fmt = (n: number) => n.toFixed(2);

describe("computeTpProximity — long geometry", () => {
  const base = { side: "long" as const, entry: 100, tps: [110, 120] };

  it("is idle far from TP1", () => {
    const r = computeTpProximity({ ...base, price: 101 });
    expect(r.phase).toBe("idle");
    expect(r.goldMix).toBe(0);
    expect(r.nextTp?.index).toBe(1);
    expect(r.priceDistance).toBeCloseTo(9);
  });

  it("enters approach at exactly 15% remaining", () => {
    // remaining 15% of a 10-wide span => price 108.5
    const r = computeTpProximity({ ...base, price: 108.5 });
    expect(r.phase).toBe("approach");
    expect(r.pulse).toBe(false);
    expect(r.goldMix).toBeCloseTo(0, 5);
  });

  it("ramps gold across the approach band without snapping", () => {
    const mid = computeTpProximity({ ...base, price: 109 }); // 10% remaining
    expect(mid.phase).toBe("approach");
    expect(mid.goldMix).toBeGreaterThan(0);
    expect(mid.goldMix).toBeLessThan(1);
  });

  it("pulses at 5% remaining or closer", () => {
    const r = computeTpProximity({ ...base, price: 109.5 });
    expect(r.phase).toBe("imminent");
    expect(r.pulse).toBe(true);
    expect(r.goldMix).toBe(1);
  });

  it("shows a stable, non-pulsing gold marker once TP is reached", () => {
    const r = computeTpProximity({ ...base, price: 110 });
    expect(r.phase).toBe("hit");
    expect(r.pulse).toBe(false);
    expect(r.goldMix).toBe(1);
  });

  it("does not go gold when price moves against the position", () => {
    const r = computeTpProximity({ ...base, price: 92 });
    expect(r.phase).toBe("idle");
    expect(r.progress).toBe(0);
  });
});

describe("computeTpProximity — short geometry mirrors long", () => {
  const base = { side: "short" as const, entry: 100, tps: [90, 80] };

  it("is idle far from TP1", () => {
    expect(computeTpProximity({ ...base, price: 99 }).phase).toBe("idle");
  });

  it("pulses at 5% remaining", () => {
    const r = computeTpProximity({ ...base, price: 90.5 });
    expect(r.phase).toBe("imminent");
    expect(r.nextTp?.price).toBe(90);
    expect(r.priceDistance).toBeCloseTo(0.5);
  });

  it("marks hit when price trades through the TP", () => {
    expect(computeTpProximity({ ...base, price: 89 }).phase).toBe("hit");
  });

  it("treats an upward move as offside", () => {
    const r = computeTpProximity({ ...base, price: 105 });
    expect(r.phase).toBe("idle");
    expect(r.progress).toBe(0);
  });

  it("uses identical thresholds for both sides", () => {
    const longR = computeTpProximity({ side: "long", entry: 100, tps: [110], price: 109 });
    const shortR = computeTpProximity({ side: "short", entry: 100, tps: [90], price: 91 });
    expect(shortR.phase).toBe(longR.phase);
    expect(shortR.goldMix).toBeCloseTo(longR.goldMix, 6);
  });
});

describe("multi-TP progression and partial fills", () => {
  it("advances to TP2 once TP1 is recorded as hit", () => {
    const r = computeTpProximity({
      side: "long",
      entry: 100,
      tps: [110, 120],
      hitIndices: [1],
      price: 112,
    });
    expect(r.nextTp?.index).toBe(2);
    expect(r.nextTp?.price).toBe(120);
    expect(r.phase).toBe("idle");
  });

  it("keeps TP labels stable across partial fills", () => {
    const r = computeTpProximity({
      side: "long",
      entry: 100,
      tps: [110, 120, 130],
      hitIndices: [1, 2],
      price: 128,
    });
    expect(r.nextTp?.index).toBe(3);
    expect(r.levels.filter((l) => l.hit).map((l) => l.index)).toEqual([1, 2]);
  });

  it("reports all_tps_hit when nothing is pending", () => {
    const r = computeTpProximity({
      side: "long",
      entry: 100,
      tps: [110],
      hitIndices: [1],
      price: 115,
    });
    expect(r.reason).toBe("all_tps_hit");
    expect(r.phase).toBe("idle");
  });
});

describe("safety: missing, stale, and malformed data", () => {
  it("returns no_position without a side", () => {
    expect(computeTpProximity({ side: null, entry: 100, tps: [110], price: 105 }).reason).toBe(
      "no_position",
    );
  });

  it("returns no_position without an entry", () => {
    expect(
      computeTpProximity({ side: "long", entry: null, tps: [110], price: 105 }).reason,
    ).toBe("no_position");
  });

  it("returns no_tp_data with an empty or null TP list", () => {
    expect(computeTpProximity({ side: "long", entry: 100, tps: null, price: 105 }).reason).toBe(
      "no_tp_data",
    );
    expect(computeTpProximity({ side: "long", entry: 100, tps: [], price: 105 }).reason).toBe(
      "no_tp_data",
    );
  });

  it("never claims proximity on a stale price", () => {
    const now = 1_000_000;
    const r = computeTpProximity({
      side: "long",
      entry: 100,
      tps: [110],
      price: 109.9,
      priceAt: now - 60_000,
      nowMs: now,
    });
    expect(r.reason).toBe("stale_price");
    expect(r.goldMix).toBe(0);
    expect(r.pulse).toBe(false);
  });

  it("accepts a fresh price inside the staleness window", () => {
    const now = 1_000_000;
    const r = computeTpProximity({
      side: "long",
      entry: 100,
      tps: [110],
      price: 109.9,
      priceAt: now - 2_000,
      nowMs: now,
    });
    expect(r.phase).toBe("imminent");
  });

  it("drops non-finite TP values instead of throwing", () => {
    const levels = normalizeTpLevels([110, NaN, null, undefined, 120] as any);
    expect(levels.map((l) => l.price)).toEqual([110, 120]);
  });

  it("flags degenerate geometry when entry equals TP", () => {
    expect(computeTpProximity({ side: "long", entry: 100, tps: [100], price: 100 }).reason).toBe(
      "invalid_geometry",
    );
  });

  it("never throws on fully empty input", () => {
    expect(() =>
      computeTpProximity({ side: undefined, entry: undefined, price: undefined, tps: undefined }),
    ).not.toThrow();
  });
});

describe("distance label", () => {
  it("renders percentage and price distance", () => {
    const r = computeTpProximity({ side: "long", entry: 100, tps: [110], price: 108 });
    expect(formatTpDistance(r, fmt)).toBe("TP1 · 1.85% · 2.00");
  });

  it("renders a reached label at TP", () => {
    const r = computeTpProximity({ side: "long", entry: 100, tps: [110], price: 110 });
    expect(formatTpDistance(r, fmt)).toBe("TP1 REACHED");
  });

  it("renders nothing when there is no tracked TP", () => {
    const r = computeTpProximity({ side: null, entry: null, tps: null, price: null });
    expect(formatTpDistance(r, fmt)).toBeNull();
  });
});

describe("threshold constants are the single source of truth", () => {
  it("approach band is wider than the imminent band", () => {
    expect(TP_APPROACH_REMAINING).toBeGreaterThan(TP_IMMINENT_REMAINING);
  });
});
