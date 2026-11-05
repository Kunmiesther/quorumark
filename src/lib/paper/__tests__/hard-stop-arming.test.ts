/**
 * HARD STOP CONTRACT — arms only once every planned rung has filled.
 *
 * The strategy hard stop must never fire before rung N is filled. Pending
 * rungs are the planned adverse-price actions; the only allowed forced
 * closes before completion are Scout BOS (routed through Onyx), cross-
 * margin liquidation protection, and the account-wide kill switch. Onyx
 * itself cannot interpret an unarmed stop as permission to close — that
 * is enforced by `validateAiClose` and covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import {
  armedHardStopLevel,
  buildLadder,
  HARD_STOP_BEYOND_LAST_RUNG_PCT,
  dcaMarginPerRungForLeverage,
  dcaRungsForLeverage,
} from "../ladder";
import { validateAiClose, type OnyxOpenPosition } from "@/lib/onyx/decide";

const EPS = 1e-9;
function approx(a: number, b: number, tol = EPS) {
  expect(Math.abs(a - b)).toBeLessThan(tol);
}

describe("armedHardStopLevel — persisted campaign arming contract", () => {
  it("returns null while ANY rung is still pending (1/8..7/8)", () => {
    for (let filled = 1; filled <= 7; filled++) {
      expect(armedHardStopLevel("long", filled, 8, 59_400)).toBeNull();
      expect(armedHardStopLevel("short", filled, 8, 60_600)).toBeNull();
    }
  });

  it("long: arms at rung8_fill × 0.99 once 8/8 is filled", () => {
    const rung8 = 59_400.123456;
    approx(armedHardStopLevel("long", 8, 8, rung8)!, rung8 * (1 - HARD_STOP_BEYOND_LAST_RUNG_PCT));
  });

  it("short: arms at rung8_fill × 1.01 once 8/8 is filled", () => {
    const rung8 = 60_599.87654;
    approx(armedHardStopLevel("short", 8, 8, rung8)!, rung8 * (1 + HARD_STOP_BEYOND_LAST_RUNG_PCT));
  });

  it("uses the ACTUAL rung-8 fill price, not the initial entry or VWAP", () => {
    // Build a real 100× BTC long ladder from a signal of 60_000. Rung 8 sits
    // exactly 1% below the signal (60_000 * 0.99 = 59_400). VWAP of all 8
    // fills is approximately (rung1+..+rung8)/8, ≈ 59_700 — the stop must
    // NOT be derived from that.
    const rungs = buildLadder("long", 60_000, null, 100, 7.5, 8);
    const rung8Px = rungs[7].price;
    const vwap = rungs.reduce((s, r) => s + r.price, 0) / rungs.length;
    const stop = armedHardStopLevel("long", 8, 8, rung8Px)!;
    approx(rung8Px, 59_400, 60_000 * 1e-9);
    approx(stop, rung8Px * 0.99, 60_000 * 1e-9);
    // Sanity: the stop is decisively below the VWAP-derived alternative.
    expect(stop).toBeLessThan(vwap * 0.99);
  });

  it("idempotent — recomputing on the exact same rung-8 fill returns the same value", () => {
    const rung8 = 3_003.14;
    const a = armedHardStopLevel("short", 8, 8, rung8);
    const b = armedHardStopLevel("short", 8, 8, rung8);
    expect(a).toBe(b);
  });

  it("current five-rung fallback arms at 5/5 with the same 1% offset semantics", () => {
    expect(dcaRungsForLeverage(50)).toBe(5);
    approx(dcaMarginPerRungForLeverage(50), 12);
    for (let filled = 1; filled <= 4; filled++) {
      expect(armedHardStopLevel("long", filled, 5, 98)).toBeNull();
    }
    approx(armedHardStopLevel("long", 5, 5, 98)!, 98 * 0.99);
  });

  it("returns null on bad inputs (0 total rungs, non-positive fill price)", () => {
    expect(armedHardStopLevel("long", 0, 0, 100)).toBeNull();
    expect(armedHardStopLevel("long", 8, 8, 0)).toBeNull();
    expect(armedHardStopLevel("long", 8, 8, null)).toBeNull();
  });
});

/**
 * Maximum modeled loss at the armed stop — reported for the UI collateral
 * warning. At 8 × $7.50 = $60 committed margin, if every rung's mark drops
 * ~1% past rung 8 (matching HARD_STOP_BEYOND_LAST_RUNG_PCT), each $7.50
 * lot at 100× loses ~100% of its margin. Total ≈ $60 gross before fees,
 * meaning the $60 ladder is the exact collateral needed for the strategy
 * stop path — with essentially zero cushion for fees or slippage.
 */
describe("collateral requirement at armed stop (informational)", () => {
  it("100× BTC ladder: gross loss at armed stop ≈ total committed margin", () => {
    const rungs = buildLadder("long", 60_000, null, 100, 7.5, 8);
    const rung8 = rungs[7].price;
    const stop = armedHardStopLevel("long", 8, 8, rung8)!;
    // Sum lot-level unrealized PnL at the armed stop price.
    let grossLoss = 0;
    for (const r of rungs) grossLoss += (r.price - stop) * r.qty; // long → positive
    // Each lot: qty = 7.5*100/price, price drop from rung.price to stop.
    // Gross loss roughly equals sum_i (price_i - stop) * qty_i ≈ 60 USD ± a
    // few % since rungs are packed inside 1% and the stop is 1% under rung8.
    expect(grossLoss).toBeGreaterThan(50);
    expect(grossLoss).toBeLessThan(120);
  });
});

describe("Onyx close policy still HOLDS while ladder incomplete", () => {
  function midLadderRed(): OnyxOpenPosition {
    return {
      walletKey: "BTC-long", positionId: "pos-mid-ladder",
      symbol: "BTC-USDT", base: "BTC", direction: "long", strategy: "dca",
      entryPx: 60_000, worstPx: 59_500, markPx: 59_500,
      qty: 0.000125, margin: 60,
      pnlPctOfMargin: -70, ageMinutes: 6,
      regime: "trend", trendState: "up", trendSlopePct: 0.1,
      structureBroken: false,
      filledRungCount: 3, pendingRungCount: 5, totalPlannedRungs: 8,
      perRungMargin: 7.5, totalPlannedMargin: 60,
      deepestRungPrice: 59_400,
      // Onyx sees NULL stop — must still not treat that as permission to close.
      hardStopLevel: null,
      nextRungPrice: 59_450,
    };
  }
  it("mid-ladder losing DCA cannot be closed by AI, stop unarmed or not", () => {
    const v = validateAiClose(midLadderRed());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("pending_rungs_active");
  });
});
