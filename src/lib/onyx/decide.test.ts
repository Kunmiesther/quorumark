/**
 * Unit tests for the Onyx execution-commander decision layer.
 * Uses a mocked fetch — no real AI call is made.
 */
import { describe, it, expect } from "vitest";
import {
  decideOnyxForCandidates, computeBenchedWallets,
  type OnyxCandidate, type FleetSnapshot, type OnyxOpenPosition,
} from "./decide";


function makeCandidate(overrides: Partial<OnyxCandidate>): OnyxCandidate {
  return {
    key: overrides.key ?? `${overrides.symbol ?? "BTC-USDT"}:${overrides.direction ?? "long"}:${overrides.leg ?? "accumulator"}`,
    symbol: "BTC-USDT",
    base: "BTC",
    direction: "long",
    leg: "accumulator",
    regime: "trend",
    walletKey: "BTC-long",
    entryRawPx: 100,
    fillPx: 100,
    stopLevel: 98,
    tpLevel: 106,
    zoneUpper: 100.5,
    zoneLower: 99.5,
    zoneLevel: 100,
    qty: 1,
    notional: 100,
    margin: 10,
    leverage: 10,
    entryFee: 0.05,
    entryCandleTs: 1_000,
    openedFromSignal: "seed",
    trendState: "up",
    trendSlopePct: 0.5,
    movementScore: 100,
    ...overrides,
  };
}

const baseFleet: FleetSnapshot = {
  walletCount: 24, openCount: 0, altOpenCount: 0, freeWalletCount: 8,
  benchedWallets: [], maxTotalOpen: 8, maxAltPositions: 6, benchConsecutiveStops: 3,
};

const okFetch = (deploys: Array<{ key: string; priority?: number; rationale?: string }>): typeof fetch =>
  (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ deploys, narrative: "test" }) } }],
  }), { status: 200 })) as unknown as typeof fetch;

function makeOpen(overrides: Partial<OnyxOpenPosition>): OnyxOpenPosition {
  return {
    walletKey: "BTC-short",
    positionId: "pos-1",
    symbol: "BTC-USDT",
    base: "BTC",
    direction: "short",
    strategy: "accumulator",
    entryPx: 100,
    worstPx: 100,
    markPx: 100,
    qty: 1,
    margin: 10,
    pnlPctOfMargin: -50,
    ageMinutes: 30,
    regime: "trend",
    trendState: "up",
    trendSlopePct: 0.6,
    ...overrides,
  };
}

describe("computeBenchedWallets", () => {
  it("benches wallets with N consecutive stops at head", () => {
    const trades = [
      { walletKey: "BTC-long", exitReason: "stop", closedAt: "t3" },
      { walletKey: "BTC-long", exitReason: "stop", closedAt: "t2" },
      { walletKey: "BTC-long", exitReason: "stop", closedAt: "t1" },
      { walletKey: "ETH-long", exitReason: "tp_touch", closedAt: "t3" },
      { walletKey: "ETH-long", exitReason: "stop", closedAt: "t2" },
    ];
    expect(computeBenchedWallets(trades, 3)).toEqual(["BTC-long"]);
  });
});

describe("decideOnyxForCandidates", () => {
  it("skips AI when no candidates", async () => {
    const d = await decideOnyxForCandidates([], baseFleet, "k", okFetch([]));
    expect(d.aiCalled).toBe(false);
    expect(d.skipReason).toBe("no_candidates");
  });

  it("skips AI when no capacity", async () => {
    const d = await decideOnyxForCandidates(
      [makeCandidate({})], { ...baseFleet, freeWalletCount: 0 }, "k", okFetch([]),
    );
    expect(d.aiCalled).toBe(false);
    expect(d.skipReason).toBe("no_capacity");
    expect(d.approved).toHaveLength(0);
  });

  it("rejects benched candidates before AI", async () => {
    const d = await decideOnyxForCandidates(
      [makeCandidate({ walletKey: "BTC-long" })],
      { ...baseFleet, benchedWallets: ["BTC-long"] },
      "k",
      okFetch([]),
    );
    expect(d.rejected[0]?.reason).toBe("benched_wallet");
  });

  it("uses deterministic path (AI disabled) even when a fetch is provided", async () => {
    // Ruling 3: ONYX_AI_ENABLED=false — the mock fetch is never called and
    // the deterministic path is authoritative (not a "fallback").
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const c = makeCandidate({});
    const d = await decideOnyxForCandidates([c], baseFleet, "k", failing);
    expect(d.aiCalled).toBe(false);
    expect(d.usedFallback).toBe(false);
    expect(d.approved).toHaveLength(1);
    expect(d.approved[0]!.key).toBe(c.key);
  });

  it("deterministic approvals still respect the alt cap", async () => {
    const btc = makeCandidate({ key: "BTC-USDT:long:accumulator" });
    const sol = makeCandidate({ key: "SOL-USDT:long:accumulator", symbol: "SOL-USDT", base: "SOL", walletKey: "SOL-long" });
    const doge = makeCandidate({ key: "DOGE-USDT:long:accumulator", symbol: "DOGE-USDT", base: "DOGE", walletKey: "DOGE-long" });
    const d = await decideOnyxForCandidates(
      [btc, sol, doge],
      { ...baseFleet, altOpenCount: 5 }, // 1 alt slot left
      "k",
      okFetch([]),
    );
    expect(d.approved.map((a) => a.key)).toEqual([btc.key, sol.key]);
    expect(d.rejected.some((r) => r.candidate.key === doge.key && r.reason === "correlated_over_exposure")).toBe(true);
  });

  it("deterministic path approves every survivor when capacity allows (no onyx_held)", async () => {
    // With AI disabled there is no ranker to leave survivors unpicked;
    // deterministic scan approves every candidate that fits guardrails.
    const a = makeCandidate({ key: "A" });
    const b = makeCandidate({ key: "B", symbol: "ETH-USDT", base: "ETH", walletKey: "ETH-long" });
    const d = await decideOnyxForCandidates([a, b], baseFleet, "k", okFetch([]));
    expect(d.approved.map((x) => x.key).sort()).toEqual(["A", "B"]);
    expect(d.rejected.some((r) => r.reason === "onyx_held")).toBe(false);
  });

  it("deterministic path runs when apiKey is null", async () => {
    const c = makeCandidate({});
    const d = await decideOnyxForCandidates([c], baseFleet, null);
    expect(d.aiCalled).toBe(false);
    expect(d.usedFallback).toBe(false);
    expect(d.approved).toHaveLength(1);
  });


  it("never cuts red open positions unless Scout marked BOS", async () => {
    const d = await decideOnyxForCandidates(
      [],
      { ...baseFleet, openCount: 1, freeWalletCount: 7 },
      "k",
      okFetch([]),
      [makeOpen({ pnlPctOfMargin: -160, trendState: "up", structureBroken: false })],
    );
    expect(d.closes).toEqual([]);
  });
});
