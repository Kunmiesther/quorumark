/**
 * H2 sweep-DCA — TS math contract tests.
 *
 * Covers:
 *   - Ladder geometry both directions (long/short)
 *   - Avg-entry recompute across partial fill sequences
 *   - Tier sequencing: 50/30/20 at 1.75/2.0/2.5R off recomputed avg entry
 *   - Remainder-at-stop and timeout guards
 *   - Fill/tier/stop trigger predicates
 *
 * Fixtures under tests/fixtures/parity/sweep_h2_*.json are asserted here AND
 * in tests/test_sweep_h2_parity.py — parity is the invariant.
 */
import { describe, it, expect } from "vitest";
import {
  computeH2Ladder,
  computeH2Tiers,
  recomputeAvgEntry,
  rungIsFilled,
  tierIsHit,
  stopIsHit,
  SWEEP_H2_FILL_WEIGHTS,
  SWEEP_H2_FILL_DEPTH_FRACS,
  SWEEP_H2_TP_TIERS,
  SWEEP_H2_TIMEOUT_BARS_1H,
  SWEEP_H2_MAX_CONCURRENT_LADDERS,
} from "../sweepH2";
import longFixture from "../../../../tests/fixtures/parity/sweep_h2_ladder_long.json";
import shortFixture from "../../../../tests/fixtures/parity/sweep_h2_ladder_short.json";

const EPS = 1e-12;

function approx(a: number, b: number, eps = EPS) {
  return Math.abs(a - b) <= eps + eps * Math.max(Math.abs(a), Math.abs(b));
}

describe("sweepH2 — constants sanity", () => {
  it("H2 spec: weights [1,3,2] sixths at depths [0.0,0.5,1.0]", () => {
    expect(SWEEP_H2_FILL_WEIGHTS).toEqual([1, 3, 2]);
    expect(SWEEP_H2_FILL_DEPTH_FRACS).toEqual([0.0, 0.5, 1.0]);
  });
  it("tier sequence 50/30/20 at 1.75/2.0/2.5R with SWEEP TP labels", () => {
    expect(SWEEP_H2_TP_TIERS.map(t => t.frac)).toEqual([0.5, 0.3, 0.2]);
    expect(SWEEP_H2_TP_TIERS.map(t => t.rr)).toEqual([1.75, 2.0, 2.5]);
    expect(SWEEP_H2_TP_TIERS.map(t => t.label)).toEqual([
      "SWEEP TP1", "SWEEP TP2", "SWEEP TP3",
    ]);
  });
  it("timeout 48×1h and concurrency cap 2", () => {
    expect(SWEEP_H2_TIMEOUT_BARS_1H).toBe(48);
    expect(SWEEP_H2_MAX_CONCURRENT_LADDERS).toBe(2);
  });
});

describe("sweepH2 — ladder geometry (LONG fixture)", () => {
  const { inputs, expected } = longFixture;
  const lad = computeH2Ladder({
    side: "long",
    level: inputs.level,
    atr1h: inputs.atr_1h,
    leverage: inputs.leverage,
    totalMarginUsd: inputs.total_margin_usd,
  });
  it("zone edge and stop match fixture", () => {
    expect(approx(lad.zoneEdgePrice, expected.zone_edge_price)).toBe(true);
    expect(approx(lad.stopPrice, expected.stop_price)).toBe(true);
  });
  it("three rungs match fixture bit-exactly", () => {
    expect(lad.rungs).toHaveLength(3);
    expected.rungs.forEach((exp: any, i: number) => {
      expect(approx(lad.rungs[i].price, exp.price)).toBe(true);
      expect(approx(lad.rungs[i].marginUsd, exp.margin_usd)).toBe(true);
      expect(approx(lad.rungs[i].qty, exp.qty)).toBe(true);
      expect(lad.rungs[i].weight).toBe(exp.weight);
      expect(lad.rungs[i].depthFrac).toBe(exp.depth_frac);
    });
  });
  it("all-filled avg entry and tiers match fixture", () => {
    const fills = lad.rungs.map(r => ({ price: r.price, qty: r.qty, marginUsd: r.marginUsd }));
    const agg = recomputeAvgEntry(fills, inputs.leverage);
    expect(approx(agg.totalQty, expected.all_filled.total_qty)).toBe(true);
    expect(approx(agg.avgEntry, expected.all_filled.avg_entry)).toBe(true);
    const { R, tiers } = computeH2Tiers({
      side: "long", avgEntry: agg.avgEntry, stopPrice: lad.stopPrice, totalQty: agg.totalQty,
    });
    expect(approx(R, expected.all_filled.R)).toBe(true);
    expected.all_filled.tiers.forEach((exp: any, i: number) => {
      expect(approx(tiers[i].price, exp.price)).toBe(true);
      expect(approx(tiers[i].qty, exp.qty)).toBe(true);
      expect(tiers[i].label).toBe(exp.label);
      expect(tiers[i].rr).toBe(exp.rr);
      expect(tiers[i].frac).toBe(exp.frac);
    });
  });
  it("partial fill (rungs 0+1 only) recomputes avg entry and re-tiers", () => {
    const fills = lad.rungs.slice(0, 2).map(r => ({ price: r.price, qty: r.qty, marginUsd: r.marginUsd }));
    const agg = recomputeAvgEntry(fills, inputs.leverage);
    expect(approx(agg.totalQty, expected.partial_first_two_filled.total_qty)).toBe(true);
    expect(approx(agg.avgEntry, expected.partial_first_two_filled.avg_entry)).toBe(true);
    const { R, tiers } = computeH2Tiers({
      side: "long", avgEntry: agg.avgEntry, stopPrice: lad.stopPrice, totalQty: agg.totalQty,
    });
    expect(approx(R, expected.partial_first_two_filled.R)).toBe(true);
    expected.partial_first_two_filled.tiers.forEach((exp: any, i: number) => {
      expect(approx(tiers[i].price, exp.price)).toBe(true);
      expect(approx(tiers[i].qty, exp.qty)).toBe(true);
    });
  });
});

describe("sweepH2 — ladder geometry (SHORT fixture)", () => {
  const { inputs, expected } = shortFixture;
  const lad = computeH2Ladder({
    side: "short",
    level: inputs.level,
    atr1h: inputs.atr_1h,
    leverage: inputs.leverage,
    totalMarginUsd: inputs.total_margin_usd,
  });
  it("zone extends ABOVE level for shorts", () => {
    expect(approx(lad.zoneEdgePrice, expected.zone_edge_price)).toBe(true);
    expect(approx(lad.stopPrice, expected.stop_price)).toBe(true);
    // Sanity: short zone edge > level, stop > edge
    expect(lad.zoneEdgePrice).toBeGreaterThan(inputs.level);
    expect(lad.stopPrice).toBeGreaterThan(lad.zoneEdgePrice);
  });
  it("all-filled tiers are BELOW avg entry (short direction)", () => {
    const fills = lad.rungs.map(r => ({ price: r.price, qty: r.qty, marginUsd: r.marginUsd }));
    const agg = recomputeAvgEntry(fills, inputs.leverage);
    const { R, tiers } = computeH2Tiers({
      side: "short", avgEntry: agg.avgEntry, stopPrice: lad.stopPrice, totalQty: agg.totalQty,
    });
    expect(approx(R, expected.all_filled.R)).toBe(true);
    tiers.forEach(t => expect(t.price).toBeLessThan(agg.avgEntry));
    expected.all_filled.tiers.forEach((exp: any, i: number) => {
      expect(approx(tiers[i].price, exp.price)).toBe(true);
      expect(approx(tiers[i].qty, exp.qty)).toBe(true);
    });
  });
});

describe("sweepH2 — fill / tier / stop predicates", () => {
  const lad = computeH2Ladder({
    side: "long", level: 100, atr1h: 2, leverage: 20, totalMarginUsd: 60,
  });
  it("rungIsFilled: long triggers on bar.low ≤ price", () => {
    expect(rungIsFilled("long", 99, { high: 101, low: 98 })).toBe(true);
    expect(rungIsFilled("long", 99, { high: 101, low: 99.5 })).toBe(false);
  });
  it("rungIsFilled: short triggers on bar.high ≥ price", () => {
    expect(rungIsFilled("short", 101, { high: 102, low: 100 })).toBe(true);
    expect(rungIsFilled("short", 101, { high: 100.5, low: 100 })).toBe(false);
  });
  it("tierIsHit: long tier reached when bar.high ≥ tier", () => {
    expect(tierIsHit("long", 102, { high: 102.5, low: 101 })).toBe(true);
    expect(tierIsHit("long", 102, { high: 101.9, low: 101 })).toBe(false);
  });
  it("stopIsHit: long stop breached when bar.low ≤ stop", () => {
    expect(stopIsHit("long", lad.stopPrice, { high: 99, low: 97.5 })).toBe(true);
    expect(stopIsHit("long", lad.stopPrice, { high: 99, low: 97.6 })).toBe(false);
  });
});

describe("sweepH2 — remainder / timeout / concurrency contract", () => {
  it("remainder qty after tiers 1+2 = totalQty × 0.2 (matches SWEEP TP3 frac)", () => {
    const lad = computeH2Ladder({ side: "long", level: 100, atr1h: 2, leverage: 20, totalMarginUsd: 60 });
    const fills = lad.rungs.map(r => ({ price: r.price, qty: r.qty, marginUsd: r.marginUsd }));
    const agg = recomputeAvgEntry(fills, 20);
    const { tiers } = computeH2Tiers({ side: "long", avgEntry: agg.avgEntry, stopPrice: lad.stopPrice, totalQty: agg.totalQty });
    const closed = tiers[0].qty + tiers[1].qty;
    const remainder = agg.totalQty - closed;
    expect(approx(remainder, agg.totalQty * 0.2)).toBe(true);
  });
  it("48×1h timeout constant matches spec", () => {
    expect(SWEEP_H2_TIMEOUT_BARS_1H).toBe(48);
  });
  it("concurrency cap = 2 (cross-portfolio ladders)", () => {
    expect(SWEEP_H2_MAX_CONCURRENT_LADDERS).toBe(2);
  });
});

describe("sweepH2 — input validation", () => {
  it("rejects atr_1h ≤ 0", () => {
    expect(() => computeH2Ladder({ side: "long", level: 100, atr1h: 0, leverage: 20, totalMarginUsd: 60 })).toThrow();
  });
  it("rejects leverage ≤ 0", () => {
    expect(() => computeH2Ladder({ side: "long", level: 100, atr1h: 2, leverage: 0, totalMarginUsd: 60 })).toThrow();
  });
  it("rejects total_margin ≤ 0", () => {
    expect(() => computeH2Ladder({ side: "long", level: 100, atr1h: 2, leverage: 20, totalMarginUsd: 0 })).toThrow();
  });
});
