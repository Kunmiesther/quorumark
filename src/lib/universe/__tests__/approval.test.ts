import { describe, it, expect } from "vitest";
import { decideApprovals } from "../approval";
import type { RankedSymbol } from "../types";
import type { CapacitySummary } from "../capacity";

function ranked(symbol: string, direction: RankedSymbol["direction"], rank: number | null = 1): RankedSymbol {
  return {
    symbol, bucket: rank == null ? "eligible" : "ranked", rank,
    rawScore: 0.5, adjustedScore: 0.5, direction,
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

function capacity(maxNew: number): CapacitySummary {
  return {
    totalSlots: 10, activeSymbols: [], reservedForHedge: 1, reservedForRecovery: 1,
    committed: 0, active: 0, unassigned: 8,
    availableForEntry: maxNew, maxNewEntries: maxNew, notes: [],
  };
}

describe("ONYX approval gate", () => {
  it("retains open symbols regardless of current rank", () => {
    const r = decideApprovals({
      ranked: [ranked("NEW-USDT", "long", 1)],
      capacity: capacity(3),
      openSymbols: ["OLD-USDT"],
    });
    expect(r.retainedSymbols).toEqual(["OLD-USDT"]);
    expect(r.approvedSymbols).toEqual(["NEW-USDT"]);
  });

  it("never approves a WAIT direction", () => {
    const r = decideApprovals({
      ranked: [ranked("BTC-USDT", "wait", 1)],
      capacity: capacity(3),
      openSymbols: [],
    });
    expect(r.approvedSymbols).toEqual([]);
    expect(r.benchedSymbols).toContain("BTC-USDT");
  });

  it("caps approvals at capacity.maxNewEntries", () => {
    const rankedList = [
      ranked("A-USDT", "long", 1),
      ranked("B-USDT", "long", 2),
      ranked("C-USDT", "long", 3),
      ranked("D-USDT", "long", 4),
    ];
    const r = decideApprovals({ ranked: rankedList, capacity: capacity(2), openSymbols: [] });
    expect(r.approvedSymbols).toEqual(["A-USDT", "B-USDT"]);
    expect(r.benchedSymbols).toEqual(["C-USDT", "D-USDT"]);
    expect(r.notes).toContain("ranked_exceeds_capacity");
  });

  it("onyx hold_all override zeroes approvals but keeps retention", () => {
    const r = decideApprovals({
      ranked: [ranked("BTC-USDT", "long", 1)],
      capacity: capacity(5),
      openSymbols: ["ETH-USDT"],
      onyxOverride: "hold_all",
    });
    expect(r.approvedSymbols).toEqual([]);
    expect(r.retainedSymbols).toEqual(["ETH-USDT"]);
    expect(r.notes).toContain("onyx_hold_all");
  });

  it("does NOT re-approve an already-open symbol (no duplicate entry)", () => {
    const r = decideApprovals({
      ranked: [ranked("BTC-USDT", "long", 1), ranked("ETH-USDT", "long", 2)],
      capacity: capacity(5),
      openSymbols: ["BTC-USDT"],
    });
    expect(r.approvedSymbols).toEqual(["ETH-USDT"]);
    expect(r.retainedSymbols).toEqual(["BTC-USDT"]);
  });

  it("zero capacity → zero approvals but retention intact", () => {
    const r = decideApprovals({
      ranked: [ranked("BTC-USDT", "long", 1)],
      capacity: capacity(0),
      openSymbols: ["ETH-USDT"],
    });
    expect(r.approvedSymbols).toEqual([]);
    expect(r.retainedSymbols).toEqual(["ETH-USDT"]);
    expect(r.notes).toContain("no_new_entry_capacity");
  });
});
