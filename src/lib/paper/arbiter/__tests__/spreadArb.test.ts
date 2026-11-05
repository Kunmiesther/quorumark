import { describe, it, expect } from "vitest";
import { evaluateSpreadEntry, evaluateSpreadExit, SPREAD_ARB_ENABLED } from "@/lib/paper/arbiter/spreadArb";
import { buildDefaultRegistry, buildFallbackRegistry } from "@/lib/paper/venues";
import { SPREAD_ARB } from "@/lib/paper/parityConstants";
import type { ArbiterPair } from "@/lib/paper/arbiter/pair";

function withEnabled<T>(fn: () => T): T {
  const prev = SPREAD_ARB.enabled;
  (SPREAD_ARB as { enabled: boolean }).enabled = true;
  try {
    return fn();
  } finally {
    (SPREAD_ARB as { enabled: boolean }).enabled = prev;
  }
}

describe("spreadArb — entry gate", () => {
  it("disabled by default in the shared parity JSON", () => {
    expect(SPREAD_ARB_ENABLED).toBe(false);
  });

  it("returns null when disabled — no fires regardless of spread", () => {
    const reg = buildDefaultRegistry();
    const prices = new Map<string, number | null>([
      ["apex_perp", 60_000],
      ["kraken_spot", 61_000],
    ]);
    expect(evaluateSpreadEntry({ symbol: "BTC-USDT", registry: reg, prices, notionalUsd: 10_000 })).toBeNull();
  });

  it("registry with SyntheticSpotVenue is INELIGIBLE — module inert", () => {
    withEnabled(() => {
      const reg = buildFallbackRegistry();
      const prices = new Map<string, number | null>([
        ["apex_perp", 60_000],
        ["synthetic_spot", 65_000],
      ]);
      expect(evaluateSpreadEntry({ symbol: "BTC-USDT", registry: reg, prices, notionalUsd: 10_000 })).toBeNull();
    });
  });

  it("fires only on NET-of-fees spread (gross spread that fees swallow → null)", () => {
    withEnabled(() => {
      const reg = buildDefaultRegistry();
      // 20 bps gross vs default fees (5+26)*2 taker + slip → net negative → no fire
      const cheap = 60_000;
      const rich = cheap * 1.002; // 20 bps
      const prices = new Map<string, number | null>([
        ["apex_perp", rich],
        ["kraken_spot", cheap],
      ]);
      const v = evaluateSpreadEntry({ symbol: "BTC-USDT", registry: reg, prices, notionalUsd: 10_000 });
      expect(v).toBeNull();
    });
  });

  it("actually evaluates an enabled profitable pair and reserves round-trip costs", () => {
    withEnabled(() => {
      const registry = buildDefaultRegistry();
      const result = evaluateSpreadEntry({ symbol: "BTC-USDT", registry,
        prices: new Map([["apex_perp", 66_000], ["kraken_spot", 60_000]]), notionalUsd: 100 });
      expect(result).not.toBeNull();
      expect(result!.sellVenueId).toBe("apex_perp");
      const costs = registry.venues.reduce((sum, v) => sum + v.takerFeeBps + v.estSlippageBps(100), 0);
      expect(result!.netBps).toBeCloseTo(1000 - 2 * costs);
    });
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid prices and notionals: %s", (invalid) => {
    withEnabled(() => {
      const registry = buildDefaultRegistry();
      expect(evaluateSpreadEntry({ symbol: "BTC-USDT", registry,
        prices: new Map([["apex_perp", 66_000], ["kraken_spot", invalid]]), notionalUsd: 100 })).toBeNull();
      expect(evaluateSpreadEntry({ symbol: "BTC-USDT", registry,
        prices: new Map([["apex_perp", 66_000], ["kraken_spot", 60_000]]), notionalUsd: invalid })).toBeNull();
    });
  });
});

describe("spreadArb — exit", () => {
  const pair = {
    pairId: "s1",
    kind: "spread_arb",
    symbol: "BTC-USDT",
    openedAtMs: 0,
    receiver: { venueId: "apex_perp", symbol: "BTC-USDT", direction: "long", notional: 10_000, entryPrice: 60_000, entryFeesUsd: 5 },
    hedge: { venueId: "kraken_spot", symbol: "BTC-USDT", direction: "short", notional: 10_000, entryPrice: 60_600, entryFeesUsd: 26 },
  } as unknown as ArbiterPair;

  it("closes when spread converges below exit_bps", () => {
    const v = evaluateSpreadExit({ pair, currentBuyPrice: 60_000, currentSellPrice: 60_010, candlesHeld: 1 });
    expect(v.exit).toBe(true);
    if (v.exit) expect(v.reason).toBe("arbiter_spread_converged");
  });

  it("timeout after max_hold_candles", () => {
    const v = evaluateSpreadExit({ pair, currentBuyPrice: 60_000, currentSellPrice: 60_600, candlesHeld: 999 });
    expect(v.exit).toBe(true);
    if (v.exit) expect(v.reason).toBe("arbiter_spread_timeout");
  });
  it("closes when the spread crosses zero instead of holding the reversed spread", () => {
    expect(evaluateSpreadExit({ pair, currentBuyPrice: 60_000, currentSellPrice: 59_000, candlesHeld: 1 }))
      .toEqual({ exit: true, reason: "arbiter_spread_converged" });
  });
  it("does not fabricate convergence from invalid prices", () => {
    expect(evaluateSpreadExit({ pair, currentBuyPrice: 0, currentSellPrice: 0, candlesHeld: 1 }))
      .toEqual({ exit: false });
  });
});
