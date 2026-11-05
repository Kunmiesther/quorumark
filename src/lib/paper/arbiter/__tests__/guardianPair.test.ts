import { describe, it, expect } from "vitest";
import { evaluateGuardianPair } from "@/lib/paper/arbiter/guardianPair";
import type { ArbiterPair } from "@/lib/paper/arbiter/pair";

const pair: ArbiterPair = {
  pairId: "g1",
  kind: "funding_harvest",
  symbol: "BTC-USDT",
  openedAtMs: 0,
  receiver: { venueId: "apex_perp", symbol: "BTC-USDT", direction: "short", notional: 10_000, entryPrice: 60_000, entryFeesUsd: 5 },
  hedge: { venueId: "kraken_spot", symbol: "BTC-USDT", direction: "long", notional: 10_000, entryPrice: 60_000, entryFeesUsd: 26 },
  triggerRate: 0.005,
};

describe("guardianPair", () => {
  it("directional 5m BOS is IGNORED on a pair — verdict returns close:false with note", () => {
    const v = evaluateGuardianPair({ pair, currentPerpPrice: 60_000, currentHedgePrice: 60_000 });
    expect(v.close).toBe(false);
    if (!v.close) expect((v as { note?: string }).note).toBe("directional_bos_ignored_on_pair");
  });

  it("leg-imbalance closes the pair", () => {
    const skewed: ArbiterPair = { ...pair, hedge: { ...pair.hedge, notional: 12_000 } }; // 16% imbalance
    const v = evaluateGuardianPair({ pair: skewed, currentPerpPrice: 60_000, currentHedgePrice: 60_000 });
    expect(v.close).toBe(true);
    if (v.close) expect(v.reason).toBe("arbiter_leg_imbalance");
  });

  it("basis stop closes the pair", () => {
    const v = evaluateGuardianPair({ pair, currentPerpPrice: 60_000, currentHedgePrice: 62_000 });
    expect(v.close).toBe(true);
    if (v.close) expect(v.reason).toBe("arbiter_basis_stop");
  });

  it("caller-supplied per-leg margin breach closes the pair", () => {
    const v = evaluateGuardianPair({ pair, currentPerpPrice: 60_000, currentHedgePrice: 60_000, legMarginBreached: true });
    expect(v.close).toBe(true);
  });
});
