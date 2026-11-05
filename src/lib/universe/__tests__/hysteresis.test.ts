import { describe, it, expect } from "vitest";
import { applyRankHysteresis, DEFAULT_HYSTERESIS, type PriorRankState } from "../hysteresis";
import type { RankedSymbol } from "../types";

function ranked(symbol: string, bucket: RankedSymbol["bucket"], rank: number | null, adjusted: number): RankedSymbol {
  return {
    symbol, bucket, rank,
    rawScore: adjusted, adjustedScore: adjusted, direction: "long",
    components: { regime: 0, alignment: 0, readiness: 0, confidence: 0, liquidity: 0, freshness: 0, volatility: 0 },
    rejectionReasons: [],
    instrument: {
      symbol, venueSymbol: symbol.replace("-", ""), base: symbol.split("-")[0], quote: "USDT",
      tradable: true, maxLeverage: 100, tickSize: 0.1, minQty: 0.001, minNotional: 5,
      volume24hUsd: 100_000_000, spreadBps: 3, ageMs: 0,
    },
    signalFresh: true,
  };
}

function prior(symbol: string, bucket: PriorRankState["lastBucket"], rank: number | null, score: number): PriorRankState {
  return { symbol, lastBucket: bucket, lastRank: rank, lastAdjustedScore: score, cooldownUntil: null, lastTransitionAt: null };
}

describe("rank hysteresis", () => {
  it("suppresses tiny upward moves (below enterBand)", () => {
    const r = ranked("BTC-USDT", "ranked", 1, 0.50);
    const priors = new Map([["BTC-USDT", prior("BTC-USDT", "eligible", null, 0.48)]]);
    const [h] = applyRankHysteresis([r], priors, Date.now());
    expect(h.finalBucket).toBe("eligible"); // frozen
    expect(h.transitioned).toBe(false);
  });

  it("allows upward moves that clear the enterBand", () => {
    const r = ranked("BTC-USDT", "ranked", 1, 0.60);
    const priors = new Map([["BTC-USDT", prior("BTC-USDT", "eligible", null, 0.50)]]);
    const [h] = applyRankHysteresis([r], priors, Date.now());
    expect(h.finalBucket).toBe("ranked");
    expect(h.finalRank).toBe(1);
    expect(h.transitioned).toBe(true);
  });

  it("suppresses tiny downward moves (below exitBand)", () => {
    const r = ranked("BTC-USDT", "eligible", null, 0.72);
    const priors = new Map([["BTC-USDT", prior("BTC-USDT", "ranked", 1, 0.75)]]);
    const [h] = applyRankHysteresis([r], priors, Date.now());
    expect(h.finalBucket).toBe("ranked");
    expect(h.finalRank).toBe(1);
    expect(h.transitioned).toBe(false);
  });

  it("respects an active cooldown by freezing the prior bucket", () => {
    const now = Date.now();
    const r = ranked("BTC-USDT", "ranked", 2, 0.9);
    const p = prior("BTC-USDT", "eligible", null, 0.1);
    p.cooldownUntil = now + DEFAULT_HYSTERESIS.cooldownMs;
    const [h] = applyRankHysteresis([r], new Map([["BTC-USDT", p]]), now);
    expect(h.finalBucket).toBe("eligible");
    expect(h.cooldownActive).toBe(true);
  });

  it("first-observation of a symbol passes through unchanged", () => {
    const r = ranked("NEW-USDT", "ranked", 1, 0.3);
    const [h] = applyRankHysteresis([r], new Map(), Date.now());
    expect(h.finalBucket).toBe("ranked");
    expect(h.finalRank).toBe(1);
  });
});
