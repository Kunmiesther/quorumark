import { describe, expect, it } from "vitest";
import { evaluateMissedOpportunity } from "./opportunityOutcome";
import type { Candle } from "@/lib/paper/signal";

const bars: Candle[] = [
  [0, 100, 102, 99, 101, 10],
  [900_000, 101, 103, 100, 102, 10],
  [1_800_000, 102, 104, 101, 103, 10],
  [2_700_000, 103, 105, 102, 104, 10],
];

describe("missed-opportunity directional benchmark", () => {
  it("does not look forward before the full window closes", () => {
    expect(evaluateMissedOpportunity({
      direction: "long", referencePrice: 100, decisionAtMs: 0,
      nowMs: 3_599_999, window: "1h", candles: bars,
    })).toBeNull();
  });

  it("measures both sides of a completed window without claiming a fill", () => {
    const common = { referencePrice: 100, decisionAtMs: 0, nowMs: 3_600_000,
      window: "1h" as const, candles: bars };
    expect(evaluateMissedOpportunity({ ...common, direction: "long" })).toMatchObject({
      status: "complete", mfe_pct: 0.05, mae_pct: 0.01, net_pct: 0.04, bars_used: 4,
    });
    expect(evaluateMissedOpportunity({ ...common, direction: "short" })).toMatchObject({
      status: "complete", mfe_pct: 0.01, mae_pct: 0.05, net_pct: -0.04,
    });
  });

  it("marks missing candles insufficient rather than a missed winner", () => {
    const outcome = evaluateMissedOpportunity({
      direction: "long", referencePrice: 100, decisionAtMs: 0,
      nowMs: 3_600_000, window: "1h", candles: bars.slice(1),
    });
    expect(outcome).toMatchObject({ status: "insufficient_data", net_pct: null });
  });
});
