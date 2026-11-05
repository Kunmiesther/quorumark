import { describe, expect, it } from "vitest";
import {
  RISK_VETO_CONFIDENCE,
  classifyRiskObjection,
  hasRiskVeto,
  rankShortlist,
  type ReviewedCandidate,
  type SeatDecision,
} from "../shortlist";

function seat(role: string, over: Partial<SeatDecision> = {}): SeatDecision {
  return {
    role,
    available: true,
    direction: "long",
    confidence: 0.7,
    reason: `${role} ok`,
    ...over,
  };
}

function candidate(over: Partial<ReviewedCandidate> = {}): ReviewedCandidate {
  return {
    symbol: "BTC-USDT",
    direction: "long",
    signalId: "sig-1",
    candleCloseMs: 1_700_000_000_000,
    contractActive: true,
    liquidityUsd: 50_000_000,
    spreadBps: 2,
    volatilityPct: 0.2,
    exchangeMaxLeverage: 50,
    tickSize: 0.1,
    stepSize: 0.001,
    minNotionalUsd: 10,
    confidence: 0.7,
    momentum: 0.8,
    structure: 0.8,
    seats: [seat("lead"), seat("structure"), seat("risk")],
    verdict: "long",
    consensusDirection: "long",
    consensusConfidence: 0.72,
    riskFlags: [],
    ...over,
  };
}

describe("risk guardian classification", () => {
  it("treats a hard failure flag as a binding veto at any confidence", () => {
    const c = candidate({
      riskFlags: ["STALE_DATA"],
      seats: [seat("lead"), seat("structure"), seat("risk", { direction: "no_trade", confidence: 0.1 })],
    });
    const o = classifyRiskObjection(c);
    expect(o.classification).toBe("hard");
    expect(o.veto).toBe(true);
    expect(hasRiskVeto(c)).toBe(true);
  });

  it("downgrades a low-confidence discretionary objection to a penalty", () => {
    const c = candidate({
      seats: [seat("lead"), seat("structure"), seat("risk", { direction: "no_trade", confidence: 0.32 })],
    });
    const o = classifyRiskObjection(c);
    expect(o.classification).toBe("discretionary");
    expect(o.veto).toBe(false);
    expect(o.penalty).toBeGreaterThan(0);
    expect(o.reason).toBeTruthy();
  });

  it("still vetoes a discretionary objection at 0.50+ confidence", () => {
    const c = candidate({
      seats: [seat("lead"), seat("structure"), seat("risk", { direction: "no_trade", confidence: RISK_VETO_CONFIDENCE })],
    });
    expect(classifyRiskObjection(c).veto).toBe(true);
  });

  it("records no objection when the risk seat agrees", () => {
    const o = classifyRiskObjection(candidate());
    expect(o.objected).toBe(false);
    expect(o.penalty).toBe(0);
  });
});

describe("ranking with the recalibrated guardian", () => {
  it("does not let a hedged risk seat kill a strong two-seat consensus", () => {
    const c = candidate({
      seats: [
        seat("lead", { confidence: 0.8 }),
        seat("structure", { confidence: 0.78 }),
        seat("risk", { direction: "no_trade", confidence: 0.3, reason: "prefers a pullback" }),
      ],
      consensusDirection: "no_trade",
    });
    const res = rankShortlist([c], { threshold: 0 });
    expect(res.selected?.symbol).toBe("BTC-USDT");
    expect(res.ranked[0].riskObjection.classification).toBe("discretionary");
    expect(res.ranked[0].riskObjection.veto).toBe(false);
  });

  it("keeps every hard veto binding", () => {
    const c = candidate({
      riskFlags: ["INSUFFICIENT_LIQUIDITY"],
      seats: [
        seat("lead", { confidence: 0.9 }),
        seat("structure", { confidence: 0.9 }),
        seat("risk", { direction: "no_trade", confidence: 0.2 }),
      ],
    });
    const res = rankShortlist([c], { threshold: 0 });
    expect(res.selected).toBeNull();
    expect(res.ranked[0].rejectionReason).toContain("risk_guardian_hard_veto");
  });

  it("keeps a confident discretionary veto binding", () => {
    const c = candidate({
      seats: [
        seat("lead", { confidence: 0.9 }),
        seat("structure", { confidence: 0.9 }),
        seat("risk", { direction: "no_trade", confidence: 0.8 }),
      ],
    });
    const res = rankShortlist([c], { threshold: 0 });
    expect(res.selected).toBeNull();
    expect(res.ranked[0].rejectionReason).toBe("risk_guardian_veto");
  });

  it("penalizes but still ranks the downgraded candidate below a clean one", () => {
    const clean = candidate({ symbol: "ETH-USDT" });
    const hedged = candidate({
      symbol: "BTC-USDT",
      seats: [seat("lead"), seat("structure"), seat("risk", { direction: "no_trade", confidence: 0.2 })],
    });
    const res = rankShortlist([clean, hedged], { threshold: 0 });
    expect(res.ranked[0].symbol).toBe("ETH-USDT");
    expect(res.selected?.symbol).toBe("ETH-USDT");
  });
});
