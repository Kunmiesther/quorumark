import { describe, it, expect } from "vitest";
import {
  HTF_PROMOTION_ENABLED,
  HTF_PROMOTION_BANK_FRACTION,
  HTF_PROMOTION_BANK_ENABLED,
  HTF_PROMOTION_MIN_NET_PROFIT_MODE,
  shouldPromote,
  isAlignedHtfBos,
  isAdverseHtfBos,
  computeBreakevenStop,
  runnerBreakevenStopHit,
} from "../htfPromotion";
import { FEE_RATE, SLIP_RATE } from "../constants";

describe("htfPromotion — constants (owner ruling: no banking)", () => {
  it("mirror shared parity JSON", () => {
    expect(HTF_PROMOTION_ENABLED).toBe(true);
    expect(HTF_PROMOTION_MIN_NET_PROFIT_MODE).toBe("breakeven_plus_fees");
  });
  it("bank_fraction is 0 — no position reduction on promotion", () => {
    expect(HTF_PROMOTION_BANK_FRACTION).toBe(0);
    expect(HTF_PROMOTION_BANK_ENABLED).toBe(false);
  });
});

describe("htfPromotion — direction alignment", () => {
  it("long: bullish_bos aligned, bearish_bos adverse, none neither", () => {
    expect(isAlignedHtfBos("long", "bullish_bos")).toBe(true);
    expect(isAlignedHtfBos("long", "bearish_bos")).toBe(false);
    expect(isAlignedHtfBos("long", "none")).toBe(false);
    expect(isAdverseHtfBos("long", "bearish_bos")).toBe(true);
    expect(isAdverseHtfBos("long", "bullish_bos")).toBe(false);
    expect(isAdverseHtfBos("long", "none")).toBe(false);
  });
  it("short: bearish_bos aligned, bullish_bos adverse", () => {
    expect(isAlignedHtfBos("short", "bearish_bos")).toBe(true);
    expect(isAlignedHtfBos("short", "bullish_bos")).toBe(false);
    expect(isAdverseHtfBos("short", "bullish_bos")).toBe(true);
    expect(isAdverseHtfBos("short", "bearish_bos")).toBe(false);
  });
});

describe("htfPromotion — shouldPromote (three-condition gate)", () => {
  const base = {
    isOpen: true,
    alreadyPromoted: false,
    unrealizedNetPnl: 10,
    htfState: "bullish_bos" as const,
    direction: "long" as const,
  };

  it("fires when all three conditions hold (long + bullish_bos + profit)", () => {
    expect(shouldPromote(base)).toBe(true);
  });
  it("fires for short + bearish_bos + profit", () => {
    expect(shouldPromote({ ...base, direction: "short", htfState: "bearish_bos" })).toBe(true);
  });

  it("LOSING position + aligned 1h BOS: NOT promoted", () => {
    expect(shouldPromote({ ...base, unrealizedNetPnl: -0.01 })).toBe(false);
    expect(shouldPromote({ ...base, unrealizedNetPnl: -100 })).toBe(false);
  });
  it("exactly breakeven (net PnL == 0): NOT promoted", () => {
    expect(shouldPromote({ ...base, unrealizedNetPnl: 0 })).toBe(false);
  });

  it("profitable + NO 1h BOS: NOT promoted", () => {
    expect(shouldPromote({ ...base, htfState: "none" })).toBe(false);
  });
  it("profitable long + COUNTER-direction 1h BOS: NOT promoted", () => {
    expect(shouldPromote({ ...base, htfState: "bearish_bos" })).toBe(false);
  });
  it("profitable short + counter-direction 1h BOS: NOT promoted", () => {
    expect(shouldPromote({ ...base, direction: "short", htfState: "bullish_bos" })).toBe(false);
  });

  it("closed position: NOT promoted", () => {
    expect(shouldPromote({ ...base, isOpen: false })).toBe(false);
  });
  it("already promoted: NOT promoted again", () => {
    expect(shouldPromote({ ...base, alreadyPromoted: true })).toBe(false);
  });
});

describe("htfPromotion — full-size runner (no banking) contract", () => {
  it("bank fraction 0 → engine MUST NOT reduce the position on promotion", () => {
    // Regression guard for the owner amendment. If a future change flips
    // bank_fraction back to > 0 this test's twin assertion below fires.
    expect(HTF_PROMOTION_BANK_FRACTION).toBe(0);
    expect(HTF_PROMOTION_BANK_ENABLED).toBe(false);
  });

  it("HTF_PROMOTION_BANK_ENABLED === (HTF_PROMOTION_BANK_FRACTION > 0)", () => {
    // Structural invariant — the engine may branch on
    // HTF_PROMOTION_BANK_ENABLED to gate the partial-close path.
    expect(HTF_PROMOTION_BANK_ENABLED).toBe(HTF_PROMOTION_BANK_FRACTION > 0);
  });
});

describe("htfPromotion — computeBreakevenStop (full-size runner floor)", () => {
  const entry = 50_000;

  it("long stop is ABOVE entry (must recover exit-side round-trip)", () => {
    const s = computeBreakevenStop(entry, "long");
    expect(s).toBeGreaterThan(entry);
    expect(s).toBeCloseTo(entry / ((1 - SLIP_RATE) * (1 - FEE_RATE)), 6);
  });

  it("short stop is BELOW entry", () => {
    const s = computeBreakevenStop(entry, "short");
    expect(s).toBeLessThan(entry);
    expect(s).toBeCloseTo(entry / ((1 + SLIP_RATE) * (1 + FEE_RATE)), 6);
  });

  it("runner exit AT the breakeven stop yields net PnL ≥ 0 for a long (FULL size)", () => {
    // Mirrors the engine's per-lot exit math on the full — unreduced — size.
    const qty = 1;
    const stop = computeBreakevenStop(entry, "long");
    const exitFill = stop * (1 - SLIP_RATE);
    const exitFee = exitFill * qty * FEE_RATE;
    const grossPnl = (exitFill - entry) * qty;
    const netPnl = grossPnl - exitFee; // entry MAKER fee = 0
    expect(netPnl).toBeGreaterThanOrEqual(-1e-9);
  });

  it("runner exit AT the breakeven stop yields net PnL ≥ 0 for a short (FULL size)", () => {
    const qty = 1;
    const stop = computeBreakevenStop(entry, "short");
    const exitFill = stop * (1 + SLIP_RATE);
    const exitFee = exitFill * qty * FEE_RATE;
    const grossPnl = (entry - exitFill) * qty;
    const netPnl = grossPnl - exitFee;
    expect(netPnl).toBeGreaterThanOrEqual(-1e-9);
  });

  it("throws on non-positive entry", () => {
    expect(() => computeBreakevenStop(0, "long")).toThrow();
    expect(() => computeBreakevenStop(-1, "short")).toThrow();
  });
});

describe("htfPromotion — runnerBreakevenStopHit", () => {
  it("long: close AT or BELOW stop is a hit", () => {
    expect(runnerBreakevenStopHit("long", 100, 100)).toBe(true);
    expect(runnerBreakevenStopHit("long", 99, 100)).toBe(true);
    expect(runnerBreakevenStopHit("long", 101, 100)).toBe(false);
  });
  it("short: close AT or ABOVE stop is a hit", () => {
    expect(runnerBreakevenStopHit("short", 100, 100)).toBe(true);
    expect(runnerBreakevenStopHit("short", 101, 100)).toBe(true);
    expect(runnerBreakevenStopHit("short", 99, 100)).toBe(false);
  });
  it("guards against zero/negative inputs", () => {
    expect(runnerBreakevenStopHit("long", 100, 0)).toBe(false);
    expect(runnerBreakevenStopHit("long", 0, 100)).toBe(false);
  });
});
