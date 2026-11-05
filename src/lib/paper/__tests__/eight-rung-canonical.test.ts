/**
 * CANONICAL 8-RUNG ALLOWLIST — negative regression suite.
 *
 * The legacy BTC 100× 8-rung DCA contract (8 × $7.50 = $60, 1 % span, per-rung
 * +1 % TP, delayed stop arming, mid-ladder Onyx close prohibition) is
 * gated exclusively by `EIGHT_RUNG_CANONICAL_SYMBOLS` / `isEightRungSymbol`.
 *
 * These tests LOCK the gate against configuration drift: every non-canonical
 * symbol (LINK-USDT, SOL-USDT, XRP-USDT, DOGE-USDT, AVAX-USDT, and every
 * near-miss like BTC-USDC / BTCUSDT / btc-usdt) must be rejected by the
 * allowlist, and the mid-ladder Onyx prohibition must NOT apply to them.
 *
 * If any of these tests fail, DO NOT relax the allowlist — investigate the
 * regression instead.
 */
import { describe, it, expect } from "vitest";
import {
  EIGHT_RUNG_CANONICAL_SYMBOLS,
  isEightRungSymbol,
  ONYX_BANK_PROFIT_MARGIN_ROI_PCT,
} from "../constants";
import { validateAiClose, type OnyxOpenPosition } from "@/lib/onyx/decide";

describe("EIGHT_RUNG_CANONICAL_SYMBOLS — allowlist membership", () => {
  it("contains exactly BTC-USDT; ETH is no longer locked to this DCA profile", () => {
    expect([...EIGHT_RUNG_CANONICAL_SYMBOLS]).toEqual(["BTC-USDT"]);
    expect(EIGHT_RUNG_CANONICAL_SYMBOLS.size).toBe(1);
  });

  it("isEightRungSymbol → true only for the legacy canonical symbol", () => {
    expect(isEightRungSymbol("BTC-USDT")).toBe(true);
    expect(isEightRungSymbol("ETH-USDT")).toBe(false);
  });

  it.each([
    "ETH-USDT",
    "LINK-USDT",
    "SOL-USDT",
    "XRP-USDT",
    "DOGE-USDT",
    "AVAX-USDT",
    "PENGU-USDT",
    "HOOD-USDT",
    "SUI-USDT",
    "APEX-USDT",
    // Near-misses that MUST fail closed:
    "BTC-USDC",   // wrong quote
    "ETH-USDC",   // wrong quote
    "BTCUSDT",    // missing dash
    "ETHUSDT",    // missing dash
    "btc-usdt",   // case-sensitive
    "eth-usdt",   // case-sensitive
    "BTC",        // base only
    "ETH",        // base only
    "",           // empty
  ])("isEightRungSymbol(%p) → false (no drift, no near-miss inclusion)", (sym) => {
    expect(isEightRungSymbol(sym)).toBe(false);
  });

  it("isEightRungSymbol tolerates null / undefined without throwing", () => {
    expect(isEightRungSymbol(null)).toBe(false);
    expect(isEightRungSymbol(undefined)).toBe(false);
  });
});

// ─── Mid-ladder Onyx close policy — canonical vs non-canonical ────────────

function midLadderRed(overrides: Partial<OnyxOpenPosition>): OnyxOpenPosition {
  return {
    walletKey: "X-long",
    positionId: "pos-mid",
    symbol: "BTC-USDT",
    base: "BTC",
    direction: "long",
    strategy: "dca",
    entryPx: 100,
    worstPx: 99,
    markPx: 99,
    qty: 1,
    margin: 60,
    pnlPctOfMargin: -40,
    ageMinutes: 5,
    regime: "trend",
    trendState: "up",
    trendSlopePct: 0.1,
    structureBroken: false,
    // Mid-ladder: rungs still pending.
    filledRungCount: 2,
    pendingRungCount: 6,
    totalPlannedRungs: 8,
    perRungMargin: 7.5,
    totalPlannedMargin: 60,
    deepestRungPrice: 99,
    hardStopLevel: null,
    nextRungPrice: 99.5,
    ...overrides,
  };
}

describe("validateAiClose — canonical vs non-canonical mid-ladder policy", () => {
  it("BTC-USDT mid-ladder red → rejected as pending_rungs_active (canonical)", () => {
    const v = validateAiClose(midLadderRed({ symbol: "BTC-USDT", base: "BTC" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("pending_rungs_active");
  });

  it("ETH-USDT mid-ladder red → uses the general policy, not the BTC-only rule", () => {
    const v = validateAiClose(midLadderRed({ symbol: "ETH-USDT", base: "ETH" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("not_profitable_enough");
  });

  it("LINK-USDT mid-ladder red → rejected as not_profitable_enough, NOT pending_rungs_active", () => {
    const v = validateAiClose(midLadderRed({
      symbol: "LINK-USDT", base: "LINK", walletKey: "LINK-long",
      filledRungCount: 2, pendingRungCount: 2, totalPlannedRungs: 4,
      perRungMargin: 15, totalPlannedMargin: 60,
    }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe("not_profitable_enough");
      expect(v.reason).not.toBe("pending_rungs_active");
    }
  });

  it("SOL-USDT mid-ladder red → rejected as not_profitable_enough, NOT pending_rungs_active", () => {
    const v = validateAiClose(midLadderRed({
      symbol: "SOL-USDT", base: "SOL", walletKey: "SOL-long",
      filledRungCount: 1, pendingRungCount: 3, totalPlannedRungs: 4,
      perRungMargin: 15, totalPlannedMargin: 60,
    }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe("not_profitable_enough");
      expect(v.reason).not.toBe("pending_rungs_active");
    }
  });

  it("BTC-USDC (near-miss quote) mid-ladder red → treated as non-canonical, NOT pending_rungs_active", () => {
    const v = validateAiClose(midLadderRed({ symbol: "BTC-USDC", base: "BTC" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).not.toBe("pending_rungs_active");
  });

  it("bank_profit path is symbol-agnostic (LINK/SOL at +threshold still close)", () => {
    for (const symbol of ["LINK-USDT", "SOL-USDT", "DOGE-USDT", "BTC-USDT", "ETH-USDT"]) {
      const v = validateAiClose(midLadderRed({
        symbol,
        base: symbol.split("-")[0],
        pnlPctOfMargin: ONYX_BANK_PROFIT_MARGIN_ROI_PCT + 5,
      }));
      expect(v.allowed).toBe(true);
      if (v.allowed) expect(v.reason).toBe("bank_profit");
    }
  });
});
