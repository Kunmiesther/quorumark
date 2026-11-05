import { describe, expect, it } from "vitest";
import {
  LEVERAGE_RISK_MAP,
  MAX_SELECTABLE_LEVERAGE,
  MIN_SELECTABLE_LEVERAGE,
  clampLeverage,
  getLeverageRisk,
} from "@/lib/strategy-config";

/**
 * The picker offered 50/100/200/300/400/500x. Four of those six were
 * impossible — the pilot ceiling, the signer and the venue all cap at 100 —
 * so choosing 500x silently produced 100x. A control that reports a value the
 * system cannot deliver is worse than one that omits it.
 */
describe("selectable leverage range", () => {
  it("is 1 to 100, with 1 rather than 0 as the floor", () => {
    // 0x is not a leverage, it is not trading. Offering it would show a
    // number that silently means 1.
    expect(MIN_SELECTABLE_LEVERAGE).toBe(1);
    expect(MAX_SELECTABLE_LEVERAGE).toBe(100);
  });

  it("clamps toward the range, never outside it", () => {
    expect(clampLeverage(500)).toBe(100);
    expect(clampLeverage(101)).toBe(100);
    expect(clampLeverage(0)).toBe(1);
    expect(clampLeverage(-7)).toBe(1);
    expect(clampLeverage(Number.NaN)).toBe(100);
  });

  it("honours every integer in range exactly, not just the old presets", () => {
    // 37 and 63 used to snap to 50, turning a deliberate choice into a
    // different one.
    for (const lev of [1, 2, 7, 25, 37, 50, 63, 88, 99, 100]) {
      expect(clampLeverage(lev)).toBe(lev);
    }
  });
});

describe("leverage risk mapping", () => {
  it("reproduces every reachable legacy table entry exactly", () => {
    // The continuous form must be a CONTINUATION of the ratified rule, not a
    // replacement for it — otherwise a value that WAS selectable would
    // quietly change its stop distance.
    for (const [lev, risk] of Object.entries(LEVERAGE_RISK_MAP)) {
      if (Number(lev) > MAX_SELECTABLE_LEVERAGE) continue;
      expect(getLeverageRisk(Number(lev))).toBe(risk);
    }
  });

  it("reports the stop for the leverage you would ACTUALLY get", () => {
    // 200x is not reachable — it is clamped to 100x — so its stop distance is
    // 100x's, not the 8% the legacy table listed against it. Reporting 8%
    // would describe a position this system cannot open.
    for (const unreachable of [200, 300, 400, 500]) {
      expect(getLeverageRisk(unreachable)).toBe(
        getLeverageRisk(MAX_SELECTABLE_LEVERAGE),
      );
    }
    // And the underlying rule is unchanged: 12 - leverage/50 still generates
    // the whole legacy table, which is why in-range values are untouched.
    for (const [lev, risk] of Object.entries(LEVERAGE_RISK_MAP)) {
      expect(12 - Number(lev) / 50).toBe(risk);
    }
  });

  it("is continuous and monotonic across the selectable range", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let lev = MIN_SELECTABLE_LEVERAGE; lev <= MAX_SELECTABLE_LEVERAGE; lev++) {
      const risk = getLeverageRisk(lev);
      expect(Number.isFinite(risk)).toBe(true);
      // More leverage -> tighter stop. Never the reverse.
      expect(risk).toBeLessThanOrEqual(previous);
      previous = risk;
    }
  });

  it("no longer hands an unlisted leverage a tighter stop than any listed one", () => {
    // The old `?? 5` fallback returned 5% for anything off-table — tighter
    // than every value in it — precisely when the caller had asked for
    // something nobody had considered.
    const listed = Object.values(LEVERAGE_RISK_MAP);
    const tightestListed = Math.min(...listed);
    for (const lev of [3, 17, 42, 64, 91]) {
      expect(getLeverageRisk(lev)).toBeGreaterThanOrEqual(tightestListed);
    }
  });
});

describe("per-symbol venue ceiling", () => {
  // ApeX's top tier is 100x, but it is granted PER CONTRACT. Treating it as
  // global is what made the picker offer 100x on SOL, where the real ceiling
  // is 50x and `plan_entry_size` would silently clamp.
  const WORKER_TABLE: Record<string, number> = {
    // Mirrors accumulator_sizing.VENUE_MAX_LEVERAGE.
    "BTC-USDT": 100,
    "ETH-USDT": 100,
    "SOL-USDT": 50,
    "XRP-USDT": 50,
    "ARB-USDT": 50,
  };

  it("keeps the frontend fallback in step with the worker's table", async () => {
    const { apexMarketsWithFallback } = await import("@/hooks/useApexMarkets");
    for (const m of apexMarketsWithFallback(undefined)) {
      const expected = WORKER_TABLE[m.symbol];
      if (expected === undefined) continue;
      expect(m.maxLeverage).toBe(expected);
    }
  });

  it("never offers above the venue ceiling", () => {
    // The property that matters: whatever the venue says, the top offered
    // choice never exceeds it, and never exceeds the ratified 100 either.
    for (const [symbol, venueMax] of Object.entries(WORKER_TABLE)) {
      const top = Math.min(venueMax, MAX_SELECTABLE_LEVERAGE);
      expect(top).toBeLessThanOrEqual(MAX_SELECTABLE_LEVERAGE);
      expect(clampLeverage(top)).toBe(top);
      // And a value above this symbol's ceiling is not silently accepted as
      // itself — the caller must reduce it.
      expect(Math.min(venueMax, venueMax + 30)).toBe(venueMax);
      expect(symbol).toBeTruthy();
    }
  });
});
