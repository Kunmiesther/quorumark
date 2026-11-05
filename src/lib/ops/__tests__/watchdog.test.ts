import { describe, it, expect } from "vitest";
import { evaluateComponent, rollupFleet, worseState, percentile } from "../watchdog";

describe("watchdog", () => {
  it("HEALTHY when fresh + no backlog + within p95 budget", () => {
    const h = evaluateComponent({
      component: "x",
      last_success_ms: 1000,
      now_ms: 2000,
      freshness_budget_ms: 5000,
      backlog: 0,
      latency_samples_ms: [10, 20, 30],
      p95_budget_ms: 500,
    });
    expect(h.state).toBe("HEALTHY");
    expect(h.freshness_ms).toBe(1000);
  });

  it("STALE when last_success_ms is null", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: null, now_ms: 1000, freshness_budget_ms: 5000,
    });
    expect(h.state).toBe("STALE");
    expect(h.reasons).toContain("NO_SUCCESS_YET");
  });

  it("STALE when freshness exceeds budget", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: 0, now_ms: 10_000, freshness_budget_ms: 5000,
    });
    expect(h.state).toBe("STALE");
  });

  it("DEGRADED when backlog exceeds warn threshold", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: 0, now_ms: 100, freshness_budget_ms: 5000,
      backlog: 10, backlog_warn: 5,
    });
    expect(h.state).toBe("DEGRADED");
  });

  it("HALTED when backlog exceeds halt threshold", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: 0, now_ms: 100, freshness_budget_ms: 5000,
      backlog: 100, backlog_warn: 5, backlog_halt: 50,
    });
    expect(h.state).toBe("HALTED");
  });

  it("HALTED when explicit halt signal is passed, regardless of other checks", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: 0, now_ms: 100, freshness_budget_ms: 5000,
      halt: true, halt_reason: "KILL_SWITCH",
    });
    expect(h.state).toBe("HALTED");
    expect(h.reasons).toContain("KILL_SWITCH");
  });

  it("DEGRADED when p95 exceeds budget", () => {
    const h = evaluateComponent({
      component: "x", last_success_ms: 0, now_ms: 100, freshness_budget_ms: 5000,
      latency_samples_ms: [10, 20, 30, 40, 1_000], p95_budget_ms: 500,
    });
    expect(h.state).toBe("DEGRADED");
  });

  it("worseState picks the higher-severity state", () => {
    expect(worseState("HEALTHY", "STALE")).toBe("STALE");
    expect(worseState("DEGRADED", "HALTED")).toBe("HALTED");
    expect(worseState("STALE", "DEGRADED")).toBe("STALE");
  });

  it("rollupFleet returns worst state across components", () => {
    const state = rollupFleet([
      { component: "a", state: "HEALTHY", reasons: [], freshness_ms: 0, backlog: 0, p50_latency_ms: null, p95_latency_ms: null, last_success_at: 0 },
      { component: "b", state: "HALTED",  reasons: [], freshness_ms: 0, backlog: 0, p50_latency_ms: null, p95_latency_ms: null, last_success_at: 0 },
      { component: "c", state: "DEGRADED",reasons: [], freshness_ms: 0, backlog: 0, p50_latency_ms: null, p95_latency_ms: null, last_success_at: 0 },
    ]);
    expect(state).toBe("HALTED");
  });

  it("percentile returns null for empty samples", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("percentile computes p50 and p95", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
