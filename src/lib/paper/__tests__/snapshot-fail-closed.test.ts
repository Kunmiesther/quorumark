/**
 * OWNER CORRECTION #1 — a stale / incomplete / future / misaligned market
 * snapshot must FAIL CLOSED.
 *
 * Production evidence (2026-08-03 ~10:20 UTC): six paper_ai_orchestrations
 * recorded all three seats as unavailable_reason='stale_snapshot', yet still
 * produced onyx_decision='enter', risk_passed=true and gate_allowed=true.
 * That path is now impossible:
 *
 *   1. `validateMarketSnapshot` rejects the snapshot BEFORE provider fan-out.
 *   2. `synthesizeOnyx` requires a real Council quorum including the risk
 *      officer. Provider outages and disagreement fail closed.
 *
 * Open-position management may continue mechanically during an AI outage,
 * but no new Council-gated exposure may be opened without quorum.
 */
import { describe, it, expect } from "vitest";
import {
  validateMarketSnapshot,
  synthesizeOnyx,
  paperCandidateRiskChecks,
  buildPaperEvidence,
  MAX_SNAPSHOT_AGE_MS,
  ENTRY_TF_MS,
  type PaperCandidateInput,
} from "../aiOrchestration.server";
import type { ProviderOutcome } from "@/lib/ai/committee/schema";

const NOW = 1_770_000_000_000; // ms, divisible by 5m
const ALIGNED = Math.floor((NOW - ENTRY_TF_MS) / ENTRY_TF_MS) * ENTRY_TF_MS;

function candidate(over: Partial<PaperCandidateInput> = {}): PaperCandidateInput {
  return {
    key: "accumulator:BTC-USDT:long:" + ALIGNED,
    symbol: "BTC-USDT",
    direction: "long",
    leg: "accumulator",
    entryCandleTs: ALIGNED,
    fillPx: 64_000,
    stopLevel: 63_000,
    tpLevel: 65_000,
    zoneLower: 63_800,
    zoneUpper: 64_200,
    margin: 60,
    notional: 6_000,
    leverage: 100,
    regime: "trend",
    trendState: "up",
    trendSlopePct: 0.4,
    movementScore: 0.6,
    htf: {
      bos1h: "up",
      bos4h: "up",
      lastClosed15mMs: Math.floor(ALIGNED / 900_000) * 900_000,
      lastClosed1hMs: Math.floor(ALIGNED / 3_600_000) * 3_600_000,
      lastClosed4hMs: Math.floor(ALIGNED / 14_400_000) * 14_400_000,
    },
    deterministicApproved: true,
    ...over,
  };
}

function unavailableSeat(reason: string, role: string): ProviderOutcome {
  return {
    role,
    provider: "test",
    model: "test/model",
    available: false,
    latencyMs: 0,
    reason,
    detail: reason,
  } as unknown as ProviderOutcome;
}

function availableSeat(role: "lead" | "risk" | "structure", direction: "long" | "short" | "no_trade", confidence = 0.8): ProviderOutcome {
  return {
    role,
    provider: role,
    model: `${role}/model`,
    available: true,
    latencyMs: 10,
    response: {
      schema_version: "committee.v1",
      direction,
      confidence,
      entry_zone: null,
      invalidation: 63_000,
      tp_levels: [65_000],
      evidence: { trend: 0.8, pivots: 0.7, volume: 0.6, liquidity: 0.6, fvg: 0.5, historical_similarity: 0.5 },
      risk_flags: [],
      summary: `${role} says ${direction}`,
    },
  } as ProviderOutcome;
}

function withProvider(outcome: ProviderOutcome, provider: string): ProviderOutcome {
  return { ...outcome, provider } as ProviderOutcome;
}

describe("validateMarketSnapshot — fail closed on unusable market data", () => {
  it("accepts a fresh, aligned, closed 5m snapshot", () => {
    const v = validateMarketSnapshot(candidate(), NOW);
    expect(v.valid).toBe(true);
    expect(v.code).toBeNull();
  });

  it("rejects a stale candle with SNAPSHOT_STALE", () => {
    // Keep the stale candle 5m-aligned so this asserts staleness, not alignment.
    const staleBars = Math.ceil(MAX_SNAPSHOT_AGE_MS / ENTRY_TF_MS) + 1;
    const old = ALIGNED - staleBars * ENTRY_TF_MS;
    const v = validateMarketSnapshot(candidate({ entryCandleTs: old }), NOW);
    expect(v.valid).toBe(false);
    expect(v.code).toBe("SNAPSHOT_STALE");
  });

  it("rejects a candle that has not closed yet with SNAPSHOT_FUTURE", () => {
    const v = validateMarketSnapshot(candidate({ entryCandleTs: ALIGNED + ENTRY_TF_MS * 2 }), NOW);
    expect(v.valid).toBe(false);
    expect(v.code).toBe("SNAPSHOT_FUTURE");
  });

  it("rejects a candle not aligned to the 5m grid with SNAPSHOT_MISALIGNED", () => {
    const v = validateMarketSnapshot(candidate({ entryCandleTs: ALIGNED + 7_000 }), NOW);
    expect(v.valid).toBe(false);
    expect(v.code).toBe("SNAPSHOT_MISALIGNED");
  });

  it("rejects missing / non-finite price or timestamp with SNAPSHOT_INCOMPLETE", () => {
    expect(validateMarketSnapshot(candidate({ fillPx: 0 }), NOW).code).toBe("SNAPSHOT_INCOMPLETE");
    expect(validateMarketSnapshot(candidate({ fillPx: Number.NaN }), NOW).code).toBe("SNAPSHOT_INCOMPLETE");
    expect(validateMarketSnapshot(candidate({ entryCandleTs: 0 }), NOW).code).toBe("SNAPSHOT_INCOMPLETE");
  });

  it("rejects higher-timeframe context that post-dates the entry candle", () => {
    const bad = candidate();
    bad.htf!.lastClosed1hMs = Math.floor(ALIGNED / 3_600_000) * 3_600_000 + 3_600_000;
    const v = validateMarketSnapshot(bad, NOW);
    expect(v.valid).toBe(false);
    expect(v.code).toBe("SNAPSHOT_TF_MISALIGNED");
  });

  it("rejects higher-timeframe context not aligned to its own frame", () => {
    const bad = candidate();
    bad.htf!.lastClosed4hMs = Math.floor(ALIGNED / 14_400_000) * 14_400_000 + 60_000;
    expect(validateMarketSnapshot(bad, NOW).code).toBe("SNAPSHOT_TF_MISALIGNED");
  });

  it("tolerates absent higher-timeframe context (reported, not fabricated)", () => {
    const v = validateMarketSnapshot(candidate({ htf: null }), NOW);
    expect(v.valid).toBe(true);
  });
});

describe("synthesizeOnyx — stale snapshot can never produce ENTER", () => {
  const staleSeats = [
    unavailableSeat("stale_snapshot", "lead"),
    unavailableSeat("stale_snapshot", "risk"),
    unavailableSeat("stale_snapshot", "structure"),
  ];

  it("returns WAIT, not ENTER, when every seat reports stale_snapshot", () => {
    const onyx = synthesizeOnyx(candidate(), staleSeats);
    expect(onyx.decision).toBe("wait");
    expect(onyx.decision).not.toBe("enter");
    expect(onyx.rationale).toMatch(/stale/i);
  });

  it("fails closed when every provider is unavailable", () => {
    const outages = [
      unavailableSeat("timeout", "lead"),
      unavailableSeat("http_error", "risk"),
      unavailableSeat("missing_credential", "structure"),
    ];
    expect(synthesizeOnyx(candidate(), outages).decision).toBe("wait");
  });

  it("fails closed below the two-seat quorum", () => {
    const outcomes = [
      availableSeat("lead", "long"),
      unavailableSeat("timeout", "risk"),
      unavailableSeat("timeout", "structure"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("wait");
  });

  it("requires the risk officer even when lead and structure agree", () => {
    const outcomes = [
      availableSeat("lead", "long"),
      unavailableSeat("timeout", "risk"),
      availableSeat("structure", "long"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("wait");
  });

  it("blocks a trade when the risk officer dissents", () => {
    const outcomes = [
      availableSeat("lead", "long"),
      availableSeat("risk", "short"),
      availableSeat("structure", "long"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("reject");
  });

  it("enters only when a confident majority includes the risk officer", () => {
    const outcomes = [
      withProvider(availableSeat("lead", "long", 0.75), "openai"),
      withProvider(availableSeat("risk", "long", 0.7), "deepseek"),
      unavailableSeat("timeout", "structure"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("enter");
  });

  it("blocks duplicate-provider votes from forming a majority", () => {
    const outcomes = [
      withProvider(availableSeat("lead", "long", 0.8), "openai"),
      withProvider(availableSeat("risk", "long", 0.8), "google"),
      withProvider(availableSeat("structure", "long", 0.8), "google"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("wait");
  });

  it("fails closed when Council confidence is too low", () => {
    const outcomes = [
      withProvider(availableSeat("lead", "long", 0.55), "openai"),
      withProvider(availableSeat("risk", "long", 0.59), "deepseek"),
      unavailableSeat("timeout", "structure"),
    ];
    expect(synthesizeOnyx(candidate(), outcomes).decision).toBe("wait");
  });

  it("never enters when the deterministic engine did not approve", () => {
    expect(synthesizeOnyx(candidate({ deterministicApproved: false }), staleSeats).decision).toBe("wait");
  });
});

describe("terminal contract — a data fault is not a strategy or risk fault", () => {
  it("stale snapshots map to a dedicated NO_TRADE_DATA outcome code", () => {
    // The orchestrator persists terminal_outcome='NO_TRADE_DATA' with
    // risk_code=<snapshot code> and providers_attempted=0, so runtime
    // compliance reporting can separate bad data from a real rejection.
    const v = validateMarketSnapshot(candidate({ entryCandleTs: ALIGNED - MAX_SNAPSHOT_AGE_MS - 1 }), NOW);
    expect(v.valid).toBe(false);
    expect(["SNAPSHOT_STALE", "SNAPSHOT_MISALIGNED"]).toContain(v.code);
    expect(v.detail).toHaveProperty("reason");
  });
});

describe("Council evidence and consolidated risk geometry", () => {
  it("persists the bounded candle evidence sent to the Council", () => {
    const marketEvidence = {
      atrPct: 0.8,
      recentCloses: [63_800, 64_000],
      recentHighs: [64_100, 64_200],
      recentLows: [63_700, 63_900],
      recentVolumes: [120, 180],
    };
    expect(buildPaperEvidence(candidate({ marketEvidence })).market_evidence).toEqual(marketEvidence);
  });

  it("accepts coherent long geometry and sizing", () => {
    expect(paperCandidateRiskChecks(candidate()).every((check) => check.passed)).toBe(true);
  });

  it("rejects a stop or target on the wrong side of entry", () => {
    const checks = paperCandidateRiskChecks(candidate({ stopLevel: 65_000, tpLevel: 63_000 }));
    expect(checks.find((check) => check.key === "protective_stop_geometry")?.passed).toBe(false);
    expect(checks.find((check) => check.key === "take_profit_geometry")?.passed).toBe(false);
  });

  it("rejects leverage over the system cap and inconsistent notional", () => {
    const checks = paperCandidateRiskChecks(candidate({ leverage: 101, notional: 1_000 }));
    expect(checks.find((check) => check.key === "leverage_within_cap")?.passed).toBe(false);
    expect(checks.find((check) => check.key === "notional_matches_margin")?.passed).toBe(false);
  });
});
