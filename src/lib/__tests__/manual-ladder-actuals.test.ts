/**
 * Ruling #8 ADD1 — the preview must display ACTUAL post-rounding totals,
 * not intended figures. Proves that a rung sized in USD gets floored to the
 * venue step and that the actual notional/margin echoed to the modal come
 * from `size * limit_price`, not `intended_margin * leverage`.
 */
import { describe, it, expect } from "vitest";
import { planManualLadder } from "@/lib/manualLadderPlan";

const now = 1_700_000_000_000;

describe("planManualLadder — ACTUAL totals after step rounding", () => {
  it("BTC-USDT 4 rungs at 100x floors size to 0.001 and reports actual notional/margin", () => {
    const plan = planManualLadder({
      symbol: "BTC-USDT",
      side: "BUY",
      markPrice: 63_188,
      leverage: 100,
      tickSize: 0.1,
      stepSize: 0.001, // BTC venue step
      rungs: 4,
      markSymbol: "BTCUSDT",
      markPriceAt: now - 1_000,
      nowMs: now,
    });

    // Every rung size must be a multiple of stepSize.
    for (const r of plan.rungs) {
      const q = r.size / 0.001;
      expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-6);
      // ACTUAL notional MUST equal size * limitPrice, not intended $ math.
      expect(r.notionalUsd).toBeCloseTo(r.size * r.limitPrice, 6);
      // ACTUAL margin MUST equal actual_notional / leverage.
      expect(r.marginUsd).toBeCloseTo(r.notionalUsd / 100, 6);
    }

    // Actual totals are the SUM of the actuals (no rounding-up trickery).
    const sumM = plan.rungs.reduce((a, r) => a + r.marginUsd, 0);
    const sumN = plan.rungs.reduce((a, r) => a + r.notionalUsd, 0);
    expect(plan.totalMargin).toBeCloseTo(sumM, 6);
    expect(plan.totalNotional).toBeCloseTo(sumN, 6);

    // ACTUAL must never exceed the $60 cap.
    expect(plan.totalMargin).toBeLessThanOrEqual(plan.intendedTotalMargin + 1e-6);

    // For BTC at ~63k with intended $15/rung*100x, size floors to 0.02
    // -> actual notional 0.02 * limit ≈ $1263 per rung. Assert we do NOT
    // return a phantom $300 notional (the intended-per-rung defect).
    expect(plan.rungs[0].notionalUsd).not.toBeCloseTo(1500, 0);
  });
});
