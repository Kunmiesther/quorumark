import { describe, it, expect } from "vitest";
import { SLO, evaluateSlo } from "../slo";

describe("SLO", () => {
  it("defines all required control-plane budgets", () => {
    expect(SLO.scheduler_lateness_ms).toBeDefined();
    expect(SLO.data_freshness_ms["5m"]).toBeDefined();
    expect(SLO.data_freshness_ms["4h"]).toBeDefined();
    expect(SLO.data_freshness_ms["1d"]).toBeDefined();
    expect(SLO.scout_scan_duration_ms).toBeDefined();
    expect(SLO.scout_to_onyx_ms).toBeDefined();
    expect(SLO.onyx_decision_ms).toBeDefined();
    expect(SLO.intent_processing_ms).toBeDefined();
  });

  it("evaluateSlo returns null observations for empty samples", () => {
    const r = evaluateSlo("x", [], { p50: 100, p95: 500 });
    expect(r.observed_p50_ms).toBeNull();
    expect(r.observed_p95_ms).toBeNull();
    expect(r.violations).toBe(0);
  });

  it("evaluateSlo counts p95 violations", () => {
    const r = evaluateSlo("x", [50, 100, 200, 600, 700], { p50: 100, p95: 500 });
    expect(r.violations).toBe(2);
    expect(r.observed_p95_ms).toBeGreaterThan(500);
  });
});
