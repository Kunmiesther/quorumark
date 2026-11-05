/**
 * Entry-guard tests — prove that WAIT regimes are fail-closed for BOTH
 * long and short intents, on canonical (BTC/ETH) and non-canonical
 * symbols, at every supported leverage tier. The engine's three
 * sizeLadder call sites all invoke evaluateEntryAuthorization first,
 * so these unit tests plus the throw-on-wait defense inside sizeLadder
 * are the proof chain that WAIT creates ZERO intents/orders/rungs.
 */
import { describe, it, expect } from "vitest";
import { evaluateEntryAuthorization } from "../entryGuard";

const WAIT_REGIMES = ["reversal_forming", "opposing_to_open_position"] as const;
const NON_WAIT_REGIMES = [
  "strong_uptrend", "strong_downtrend", "developing_trend",
  "ranging", "volatile", "unknown",
] as const;
const SYMBOLS = ["BTC-USDT", "ETH-USDT", "LINK-USDT", "SOL-USDT", "XRP-USDT"];
const LEVERAGES = [25, 50, 100];

describe("evaluateEntryAuthorization — WAIT regimes fail closed", () => {
  for (const regime of WAIT_REGIMES) {
    for (const symbol of SYMBOLS) {
      for (const leverage of LEVERAGES) {
        it(`${regime} @${leverage}x on ${symbol} — blocks entry, zero rungs`, () => {
          const g = evaluateEntryAuthorization({ regime, leverage, symbol });
          expect(g.authorized).toBe(false);
          expect(g.blockCode).toBe("wait_regime");
          expect(g.blockDetail).toContain(regime);
          expect(g.plan.mode).toBe("wait");
          expect(g.plan.rungs).toBe(0);
          expect(g.plan.marginPerRung).toBe(0);
          expect(g.plan.totalMargin).toBe(0);
        });
      }
    }
  }
});

describe("evaluateEntryAuthorization — non-WAIT regimes authorize", () => {
  for (const regime of NON_WAIT_REGIMES) {
    it(`${regime} authorizes and produces >0 rungs @100x BTC`, () => {
      const g = evaluateEntryAuthorization({ regime, leverage: 100, symbol: "BTC-USDT" });
      expect(g.authorized).toBe(true);
      expect(g.blockCode).toBeNull();
      expect(g.plan.mode).not.toBe("wait");
      expect(g.plan.rungs).toBeGreaterThan(0);
    });
  }
});

describe("evaluateEntryAuthorization — direction-independent (regime-only)", () => {
  // The guard doesn't take direction as input — proving BOTH long and short
  // intents are blocked by definition when a WAIT regime is active. The
  // engine's three sizeLadder call sites each iterate `dir` in {"long","short"}
  // and hit the same guard.
  it("blocks regardless of which direction the caller was planning", () => {
    const both = ["long", "short"].map(() =>
      evaluateEntryAuthorization({
        regime: "reversal_forming", leverage: 100, symbol: "BTC-USDT",
      }),
    );
    expect(both.every((g) => g.authorized === false)).toBe(true);
    expect(both.every((g) => g.plan.rungs === 0)).toBe(true);
  });
});
