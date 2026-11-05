/**
 * Legacy reconstruction ladder geometry.
 *
 * New campaign dollars are tested in walletCampaignSizing.test.ts. These
 * tests keep the fallback geometry deterministic for historical rows that
 * do not contain persisted rung data:
 *   - 5 rungs × $12 margin = $60 legacy planned total
 *   - 1.0 % adverse price span between rung 1 and rung 5, inclusive
 *   - 4 equal intervals
 *   - Long ladder descends, short ladder ascends
 *   - Per-rung TP is EXACTLY 1 % favorable from its OWN fill price
 *   - rung count remains five at every leverage
 */
import { describe, it, expect } from "vitest";
import {
  buildLadder,
  ladderSpanPct,
  dcaRungsForLeverage,
  dcaMarginPerRungForLeverage,
  DCA_TOTAL_MARGIN_USD,
  DCA_RUNG_TP_PCT,
} from "../ladder";

const EPS = 1e-9;
function approx(a: number, b: number, tol = EPS) { expect(Math.abs(a - b)).toBeLessThan(tol); }

describe("100× legacy reconstruction ladder — 5 × $12 = $60", () => {
  it("has the mandated rung count and per-rung margin", () => {
    expect(dcaRungsForLeverage(100)).toBe(5);
    approx(dcaMarginPerRungForLeverage(100), 12);
  });

  for (const [dir, first] of [["long", 60_000], ["short", 3_000]] as const) {
    it(`${dir} @ ${first}: 5 rungs span exactly 1.0 % across 4 equal intervals`, () => {
      const rungs = buildLadder(dir, first, null, 100, 12, 5);
      expect(rungs).toHaveLength(5);
      // First rung sits at the signal.
      approx(rungs[0].price, first);
      // Ladder span is 1 % at 100×.
      approx(ladderSpanPct(100), 0.01);
      const deepest = dir === "long" ? first * 0.99 : first * 1.01;
      approx(rungs[4].price, deepest, first * 1e-9);
      // Every step is exactly span / 4.
      const step = first * 0.01 / 4;
      for (let i = 1; i < 5; i++) {
        const expected = dir === "long" ? first - i * step : first + i * step;
        approx(rungs[i].price, expected, first * 1e-9);
      }
    });

    it(`${dir} @ ${first}: every fallback rung margin is $12 and total planned = $60`, () => {
      const rungs = buildLadder(dir, first, null, 100, 12, 5);
      for (const r of rungs) approx(r.margin, 12);
      approx(rungs.reduce((s, r) => s + r.margin, 0), DCA_TOTAL_MARGIN_USD);
    });

    it(`${dir} @ ${first}: per-rung TP is exactly 1 % from its OWN fill`, () => {
      const rungs = buildLadder(dir, first, null, 100, 12, 5);
      for (const r of rungs) {
        const expected = dir === "long" ? r.price * (1 + DCA_RUNG_TP_PCT) : r.price * (1 - DCA_RUNG_TP_PCT);
        approx(r.tp, expected, first * 1e-9);
      }
    });
  }
});

describe("50× legacy reconstruction ladder remains five rungs", () => {
  it("has 5 rungs, $12 each, 2 % span", () => {
    expect(dcaRungsForLeverage(50)).toBe(5);
    approx(dcaMarginPerRungForLeverage(50), 12);
    approx(ladderSpanPct(50), 0.02);
    const rungs = buildLadder("long", 100, null, 50, 12, 5);
    expect(rungs).toHaveLength(5);
    for (const r of rungs) approx(r.margin, 12);
    approx(rungs.reduce((s, r) => s + r.margin, 0), DCA_TOTAL_MARGIN_USD);
    approx(rungs[4].price, 98);
  });
});
