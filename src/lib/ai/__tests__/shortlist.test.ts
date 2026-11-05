import { describe, expect, it } from "vitest";
import {
  MIN_AVAILABLE_SEATS,
  PREFILTER_POLICY,
  SELECTION_THRESHOLD,
  cycleKeyFor,
  EDGE_ATR_MULTIPLE,
  expectedNetEdgeBps,
  hasRiskVeto,
  normalizeWithin,
  prefilterCandidates,
  rankShortlist,
  type PrefilterCandidate,
  type ReviewedCandidate,
  type SeatDecision,
} from "@/lib/ai/shortlist";
import { deriveCycleSignal, MIN_CANDLES, type OHLCV } from "@/lib/ai/cycleSignals";

function candidate(over: Partial<PrefilterCandidate> = {}): PrefilterCandidate {
  return {
    symbol: "BTC-USDT",
    direction: "long",
    signalId: "sig-1",
    candleCloseMs: 1_000_000,
    contractActive: true,
    liquidityUsd: 50_000_000,
    spreadBps: 2,
    volatilityPct: 1.2,
    exchangeMaxLeverage: 100,
    tickSize: 0.1,
    stepSize: 0.001,
    minNotionalUsd: 10,
    confidence: 0.7,
    momentum: 0.6,
    structure: 0.6,
    ...over,
  };
}

const NOW = 1_000_000 + 60_000;

function seats(
  lead: Partial<SeatDecision> = {},
  risk: Partial<SeatDecision> = {},
  structure: Partial<SeatDecision> = {},
): SeatDecision[] {
  const base = (role: string, o: Partial<SeatDecision>): SeatDecision => ({
    role,
    available: true,
    direction: "long",
    confidence: 0.7,
    reason: "ok",
    ...o,
  });
  return [base("lead", lead), base("risk", risk), base("structure", structure)];
}

function reviewed(over: Partial<ReviewedCandidate> = {}): ReviewedCandidate {
  return {
    ...candidate(),
    seats: seats(),
    verdict: "shadow_endorse",
    consensusDirection: "long",
    consensusConfidence: 0.7,
    riskFlags: [],
    ...over,
  };
}

describe("prefilter — universe fan-out", () => {
  it("measures freshness from candle close, not candle open", () => {
    const candles: OHLCV[] = Array.from({ length: 120 }, (_, index) => [
      index * 900_000,
      100 + index,
      102 + index,
      99 + index,
      101 + index,
      1000,
    ]);
    const signal = deriveCycleSignal(candles, 900_000)!;
    expect(signal.candleCloseMs).toBe(120 * 900_000);
    const nowMs = signal.candleCloseMs + 60_000;
    expect(
      prefilterCandidates([candidate({ candleCloseMs: signal.candleCloseMs })], { nowMs }).accepted,
    ).toHaveLength(1);
    expect(
      prefilterCandidates([candidate({ candleCloseMs: signal.candleCloseMs })], {
        nowMs: nowMs + 900_000,
      }).rejected[0].reason,
    ).toBe("stale_candle");
  });
  it("accepts a healthy candidate", () => {
    const { accepted, rejected } = prefilterCandidates([candidate()], { nowMs: NOW });
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects each policy breach with a distinct auditable reason", () => {
    const cases: Array<[Partial<PrefilterCandidate>, string]> = [
      [{ contractActive: false }, "contract_inactive"],
      [{ candleCloseMs: 0 }, "no_closed_candle"],
      [{ candleCloseMs: NOW - PREFILTER_POLICY.maxSignalAgeMs - 1 }, "stale_candle"],
      [{ liquidityUsd: 1_000 }, "insufficient_liquidity"],
      [{ spreadBps: PREFILTER_POLICY.maxSpreadBps + 1 }, "spread_too_wide"],
      [{ volatilityPct: 0.001 }, "volatility_out_of_band"],
      [{ volatilityPct: 99 }, "volatility_out_of_band"],
      [{ exchangeMaxLeverage: 1 }, "leverage_unsupported"],
      [{ tickSize: null }, "precision_unknown"],
      [{ stepSize: null }, "precision_unknown"],
    ];
    for (const [over, reason] of cases) {
      const { accepted, rejected } = prefilterCandidates([candidate(over)], { nowMs: NOW });
      expect(accepted, reason).toHaveLength(0);
      expect(rejected[0]?.reason).toBe(reason);
    }
  });

  it("suppresses duplicate signals, existing exposure and correlated sides", () => {
    const dup = prefilterCandidates([candidate()], {
      nowMs: NOW,
      alreadySeenSignalIds: new Set(["sig-1"]),
    });
    expect(dup.rejected[0].reason).toBe("duplicate_candidate");

    const open = prefilterCandidates([candidate()], {
      nowMs: NOW,
      openSymbols: new Set(["BTC-USDT"]),
    });
    expect(open.rejected[0].reason).toBe("existing_exposure");

    const bothSides = prefilterCandidates(
      [candidate(), candidate({ direction: "short", signalId: "sig-2" })],
      { nowMs: NOW },
    );
    expect(bothSides.accepted).toHaveLength(1);
    expect(bothSides.rejected[0].reason).toBe("correlated_duplicate_symbol");
  });

  it("fans out the whole universe up to the batch cap, deterministically", () => {
    const universe = Array.from({ length: 30 }, (_, i) =>
      candidate({ symbol: `SYM${String(i).padStart(2, "0")}-USDT`, signalId: `sig-${i}` }),
    );
    const a = prefilterCandidates(universe, { nowMs: NOW });
    const b = prefilterCandidates([...universe].reverse(), { nowMs: NOW });
    expect(a.accepted).toHaveLength(PREFILTER_POLICY.maxBatch);
    expect(a.accepted.map((c) => c.symbol)).toEqual(b.accepted.map((c) => c.symbol));
    expect(a.rejected.some((r) => r.reason === "batch_cap_reached")).toBe(true);
  });

  it("blocks the batch when there is no remaining capacity", () => {
    const { accepted, rejected } = prefilterCandidates([candidate()], {
      nowMs: NOW,
      remainingCapacity: 0,
    });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("capacity_exhausted");
  });
});

describe("normalization", () => {
  it("maps an all-equal batch to the midpoint, not to 0 or 1", () => {
    expect(normalizeWithin([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
  });

  it("min-max scales within the cycle only", () => {
    expect(normalizeWithin([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it("net edge subtracts fees and spread from the gross expectation", () => {
    const c = reviewed({ volatilityPct: 1, consensusConfidence: 1, spreadBps: 5 });
    expect(expectedNetEdgeBps(c, 10)).toBeCloseTo(100 * EDGE_ATR_MULTIPLE - 10 - 5, 6);
  });

  it("a negative modeled edge is a scoring penalty, not a hard rejection", () => {
    // Low volatility alone drives gross edge below round-trip cost, but every
    // other component (full agreement, no risk objection, healthy liquidity)
    // is strong enough that the composite score should still clear threshold.
    const thin = reviewed({ volatilityPct: 0.03 });
    expect(expectedNetEdgeBps(thin)).toBeLessThan(0);
    const out = rankShortlist([thin]);
    expect(out.ranked[0].rejectionReason).not.toBe("negative_net_edge");
    expect(out.selected).not.toBeNull();
  });

  it("ranks the shortlist deterministically and assigns dense ranks", () => {
    const batch = [
      reviewed({ symbol: "AAA-USDT", liquidityUsd: 3_000_000, volatilityPct: 0.4 }),
      reviewed({ symbol: "BBB-USDT", liquidityUsd: 900_000_000, volatilityPct: 2 }),
      reviewed({ symbol: "CCC-USDT", liquidityUsd: 40_000_000, volatilityPct: 1 }),
    ];
    const first = rankShortlist(batch);
    const second = rankShortlist([...batch].reverse());
    expect(first.ranked.map((r) => r.symbol)).toEqual(second.ranked.map((r) => r.symbol));
    expect(first.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(first.selected?.symbol).toBe("BBB-USDT");
    expect(first.ranked.filter((r) => r.state === "selected")).toHaveLength(1);
  });
});

describe("risk guardian veto", () => {
  it("is absolute — a no_trade risk seat removes the candidate from selection", () => {
    const vetoed = reviewed({ seats: seats({}, { direction: "no_trade" }) });
    expect(hasRiskVeto(vetoed)).toBe(true);
    const out = rankShortlist([vetoed]);
    expect(out.selected).toBeNull();
    expect(out.ranked[0].state).toBe("rejected");
    expect(out.ranked[0].rejectionReason).toBe("risk_guardian_veto");
    expect(out.noTradeReason).toBe("risk_guardian_veto_all");
  });

  it("cannot be outvoted by the other two seats", () => {
    const out = rankShortlist([
      reviewed({
        symbol: "BBB-USDT",
        liquidityUsd: 900_000_000,
        volatilityPct: 3,
        seats: seats({ confidence: 0.99 }, { direction: "no_trade" }, { confidence: 0.99 }),
      }),
      reviewed({ symbol: "CCC-USDT", liquidityUsd: 40_000_000, volatilityPct: 1.5 }),
    ]);
    // The vetoed candidate outranks on every other component, yet it can
    // never be the selection.
    expect(out.ranked[0].symbol).toBe("BBB-USDT");
    expect(out.ranked[0].state).toBe("rejected");
    expect(out.ranked[0].rejectionReason).toBe("risk_guardian_veto");
    expect(out.selected?.symbol ?? null).not.toBe("BBB-USDT");
  });

  it("requires a minimum quorum of available seats", () => {
    const out = rankShortlist([
      reviewed({
        seats: seats(
          { available: false, direction: null },
          { available: false, direction: null },
          {},
        ),
      }),
    ]);
    expect(MIN_AVAILABLE_SEATS).toBe(2);
    expect(out.ranked[0].rejectionReason).toBe("insufficient_reviews");
    expect(out.selected).toBeNull();
  });

  it("stands down when the committee says no_trade or disagrees on side", () => {
    const stand = rankShortlist([
      reviewed({
        consensusDirection: "no_trade",
        seats: seats({ direction: "no_trade" }, {}, { direction: "no_trade" }),
      }),
    ]);
    expect(stand.ranked[0].rejectionReason).toBe("committee_stand_down");
    const mismatch = rankShortlist([reviewed({ consensusDirection: "short" })]);
    expect(mismatch.ranked[0].rejectionReason).toBe("direction_mismatch");
  });

  it("never selects below the threshold", () => {
    const weak = rankShortlist([
      reviewed({ volatilityPct: 0.05, momentum: 0, structure: 0, consensusConfidence: 0.1 }),
    ]);
    expect(weak.selected).toBeNull();
    expect(SELECTION_THRESHOLD).toBeGreaterThan(0.5);
  });
});

describe("cycle identity", () => {
  it("is one key per 15-minute candle per book", () => {
    const a = cycleKeyFor(1_700_000_123_000, "paper");
    const b = cycleKeyFor(1_700_000_299_000, "paper");
    expect(a).toBe(b);
    expect(cycleKeyFor(1_700_001_023_000, "paper")).not.toBe(a);
    expect(cycleKeyFor(1_700_000_123_000, "live")).not.toBe(a);
  });
});

describe("deterministic per-symbol read", () => {
  function series(n: number, fn: (i: number) => number): OHLCV[] {
    return Array.from({ length: n }, (_, i) => {
      const c = fn(i);
      return [1_000_000 + i * 300_000, c, c * 1.002, c * 0.998, c, 100] as OHLCV;
    });
  }

  it("refuses to propose a side without enough candles", () => {
    expect(deriveCycleSignal(series(MIN_CANDLES - 1, (i) => 100 + i))).toBeNull();
  });

  it("reads an uptrend as long and a downtrend as short", () => {
    expect(deriveCycleSignal(series(120, (i) => 100 + i))?.direction).toBe("long");
    expect(deriveCycleSignal(series(120, (i) => 1000 - i * 2))?.direction).toBe("short");
  });

  it("returns null on a flat, directionless tape", () => {
    expect(deriveCycleSignal(series(120, () => 100))).toBeNull();
  });

  it("places invalidation behind entry and TPs in front of it", () => {
    const sig = deriveCycleSignal(series(120, (i) => 100 + i))!;
    expect(sig.invalidation).toBeLessThan(sig.entry);
    expect(Math.min(...sig.tpLevels)).toBeGreaterThan(sig.entry);
    expect(sig.volatilityPct).toBeGreaterThan(0);
  });
});
