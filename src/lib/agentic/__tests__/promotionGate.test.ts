import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  agenticLiveExecutionAllowed,
  evaluatePromotion,
  maxDrawdownPct,
  profitFactor,
  type PromotionMetrics,
} from "../promotionGate";

const perfect: PromotionMetrics = {
  sampleSize: 500,
  netPnl: 1200,
  expectancy: 2.4,
  profitFactor: 1.9,
  maxDrawdownPct: 8,
  degradedRatePct: 5,
  missingTraceViolations: 0,
  riskRuleViolations: 0,
  executionIntegrityPct: 100,
};

describe("promotion gate", () => {
  it("never qualifies while thresholds are still the shipped defaults", () => {
    const evaln = evaluatePromotion(perfect, DEFAULT_THRESHOLDS, {
      ownerApproved: true,
      agenticLiveEnabled: false,
      thresholdsAreOwnerSet: false,
    });
    expect(evaln.wouldQualify).toBe(false);
    expect(evaln.provisional).toBe(true);
    expect(evaln.blockers).toContain("thresholds_are_defaults_not_owner_set");
  });

  it("never qualifies without explicit owner approval", () => {
    const evaln = evaluatePromotion(perfect, DEFAULT_THRESHOLDS, {
      ownerApproved: false,
      agenticLiveEnabled: false,
      thresholdsAreOwnerSet: true,
    });
    expect(evaln.wouldQualify).toBe(false);
    expect(evaln.blockers).toContain("owner_approval_missing");
  });

  it("qualifies only when every measured check and the owner gate pass", () => {
    const evaln = evaluatePromotion(perfect, DEFAULT_THRESHOLDS, {
      ownerApproved: true,
      agenticLiveEnabled: false,
      thresholdsAreOwnerSet: true,
    });
    expect(evaln.checks.every((c) => c.passed)).toBe(true);
    expect(evaln.wouldQualify).toBe(true);
    // Qualifying is not enabling.
    expect(evaln.agenticLiveEnabled).toBe(false);
  });

  it("blocks on any single failing metric", () => {
    for (const patch of [
      { sampleSize: 10 },
      { netPnl: -1 },
      { expectancy: -0.1 },
      { profitFactor: 1.0 },
      { maxDrawdownPct: 40 },
      { degradedRatePct: 55 },
      { missingTraceViolations: 1 },
      { riskRuleViolations: 1 },
      { executionIntegrityPct: 99 },
    ]) {
      const evaln = evaluatePromotion({ ...perfect, ...patch }, DEFAULT_THRESHOLDS, {
        ownerApproved: true,
        agenticLiveEnabled: false,
        thresholdsAreOwnerSet: true,
      });
      expect(evaln.wouldQualify, JSON.stringify(patch)).toBe(false);
    }
  });

  it("keeps agentic live execution disabled in every reachable configuration", () => {
    expect(agenticLiveExecutionAllowed(null, {})).toBe(false);
    expect(agenticLiveExecutionAllowed({ agenticLiveEnabled: true, ownerApproved: false }, { AGENTIC_LIVE_EXECUTION_ENABLED: "true" })).toBe(false);
    expect(agenticLiveExecutionAllowed({ agenticLiveEnabled: false, ownerApproved: true }, { AGENTIC_LIVE_EXECUTION_ENABLED: "true" })).toBe(false);
    // Both the DB gate and the deployment flag are required.
    expect(agenticLiveExecutionAllowed({ agenticLiveEnabled: true, ownerApproved: true }, {})).toBe(false);
    expect(agenticLiveExecutionAllowed({ agenticLiveEnabled: true, ownerApproved: true }, { AGENTIC_LIVE_EXECUTION_ENABLED: "true" })).toBe(true);
  });

  it("computes profit factor and drawdown", () => {
    expect(profitFactor(300, 150)).toBe(2);
    expect(profitFactor(0, 0)).toBe(0);
    expect(maxDrawdownPct([100, -50, 25])).toBeCloseTo(50, 4);
    expect(maxDrawdownPct([10, 10, 10])).toBe(0);
  });
});
