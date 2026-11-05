import { describe, expect, it } from "vitest";
import { computeConsensus, BIAS_DEAD_ZONE } from "@/lib/scout/consensus";
import type { TimeframeState, Timeframe } from "@/lib/scout/types";

function tf(
  name: Timeframe,
  score: number,
  state: TimeframeState["state"] = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral",
  stale = false,
): TimeframeState {
  return {
    tf: name,
    score,
    state,
    lastClosedTs: 0,
    ageMs: 0,
    stale,
    reasons: [],
  };
}

describe("computeConsensus", () => {
  it("agreement across all TFs → strong bias, high confidence", () => {
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", 1), tf("D", 1), tf("H4", 1), tf("H1", 1), tf("M15", 1), tf("M5", 1),
    ];
    const c = computeConsensus(states);
    expect(c.bias).toBe("long-priority");
    expect(c.readiness).toBe("armed");
    expect(c.availability).toBeCloseTo(1, 5);
    expect(c.confidence).toBeGreaterThan(0.7);
  });

  it("5m alone cannot override macro bias", () => {
    // Higher TFs strongly bullish, 5m bearish
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", 1), tf("D", 1), tf("H4", 1), tf("H1", 0.5), tf("M15", 0.5), tf("M5", -1),
    ];
    const c = computeConsensus(states);
    expect(c.bias).toBe("long-priority");
  });

  it("missing H4 / D → no-signal", () => {
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", 1),
      tf("D", 0, "unavailable"),
      tf("H4", 0, "unavailable"),
      tf("H1", 1), tf("M15", 1), tf("M5", 1),
    ];
    const c = computeConsensus(states);
    expect(c.bias).toBe("no-signal");
    expect(c.readiness).toBe("no-signal");
  });

  it("stale H4 → no-signal even with data", () => {
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", 1), tf("D", 1),
      tf("H4", 1, "bullish", true),
      tf("H1", 1), tf("M15", 1), tf("M5", 1),
    ];
    expect(computeConsensus(states).bias).toBe("no-signal");
  });

  it("dead-zone → balanced", () => {
    const states: TimeframeState[] = [
      tf("M", 0), tf("W", 0), tf("D", 0.1), tf("H4", -0.1), tf("H1", 0.05), tf("M15", 0), tf("M5", 0),
    ];
    const c = computeConsensus(states);
    expect(Math.abs(c.weightedScore)).toBeLessThan(BIAS_DEAD_ZONE);
    expect(c.bias).toBe("balanced");
  });

  it("readiness watching when H1/M15/M5 don't all confirm", () => {
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", 1), tf("D", 1), tf("H4", 1),
      tf("H1", 1), tf("M15", 1),
      tf("M5", -1),  // disagrees with bias
    ];
    const c = computeConsensus(states);
    expect(c.bias).toBe("long-priority");
    expect(c.readiness).toBe("watching");
  });

  it("disagreement across TFs raises conflict", () => {
    const states: TimeframeState[] = [
      tf("M", 1), tf("W", -1), tf("D", 1), tf("H4", -1), tf("H1", 1), tf("M15", -1), tf("M5", 1),
    ];
    const c = computeConsensus(states);
    expect(c.conflict).toBeGreaterThan(0.5);
  });
});
