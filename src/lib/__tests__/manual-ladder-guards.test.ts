/**
 * Ruling #6 — deploy path hard guards.
 *
 * Proves that planManualLadder REFUSES to build a plan when the mark price
 * did not originate from the requested symbol, or when it is stale, or when
 * it is not a positive finite number. These guards protect the live-money
 * path from the ghost-socket bug that surfaced the wrong asset's price
 * under the current header.
 */
import { describe, it, expect } from "vitest";
import { planManualLadder, LadderGuardError, MARK_PRICE_MAX_AGE_MS } from "@/lib/manualLadderPlan";

const now = 1_700_000_000_000;

function baseArgs() {
  return {
    symbol: "ETH-USDT",
    side: "BUY" as const,
    markPrice: 1871.46,
    leverage: 100,
    tickSize: 0.01,
    stepSize: 0.001,
    markSymbol: "ETHUSDT",
    markPriceAt: now - 1_000,
    nowMs: now,
  };
}

describe("planManualLadder — Ruling #6 guards", () => {
  it("refuses when markSymbol does not match requested symbol (the exact bug)", () => {
    // Deploy asks for ETH-USDT but the mark price payload carries BTC data.
    expect(() =>
      planManualLadder({ ...baseArgs(), markSymbol: "BTCUSDT", markPrice: 63146.2 }),
    ).toThrowError(LadderGuardError);
    try {
      planManualLadder({ ...baseArgs(), markSymbol: "BTCUSDT", markPrice: 63146.2 });
    } catch (e) {
      expect((e as LadderGuardError).code).toBe("SYMBOL_MISMATCH");
    }
  });

  it("accepts dashed vs raw symbol equivalence (BTC-USDT vs BTCUSDT)", () => {
    const p = planManualLadder({
      ...baseArgs(),
      symbol: "BTC-USDT",
      markSymbol: "BTCUSDT",
      markPrice: 63146.2,
      tickSize: 0.1,
    });
    expect(p.rungs.length).toBeGreaterThan(0);
  });

  it("refuses when markPriceAt is older than MARK_PRICE_MAX_AGE_MS", () => {
    try {
      planManualLadder({ ...baseArgs(), markPriceAt: now - (MARK_PRICE_MAX_AGE_MS + 1) });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as LadderGuardError).code).toBe("STALE_MARK_PRICE");
    }
  });

  it("refuses when markPrice is non-finite or non-positive", () => {
    for (const bad of [0, NaN, -1]) {
      try {
        planManualLadder({ ...baseArgs(), markPrice: bad });
        throw new Error(`expected throw for ${bad}`);
      } catch (e) {
        expect((e as LadderGuardError).code).toBe("INVALID_MARK_PRICE");
      }
    }
  });

  it("builds a plan when the symbol matches and the mark is fresh", () => {
    const p = planManualLadder(baseArgs());
    expect(p.symbol).toBe("ETH-USDT");
    expect(p.rungs.length).toBeGreaterThan(0);
    // Sanity: rung 1 sits at or below the mark for a BUY ladder.
    expect(p.rungs[0].limitPrice).toBeLessThanOrEqual(1871.46);
  });
});
