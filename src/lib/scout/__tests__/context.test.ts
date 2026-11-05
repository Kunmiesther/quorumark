import { describe, expect, it } from "vitest";
import { computeBreadth, computeContext, CONTEXT_MAX_ADJUST, NOT_CONNECTED, returns } from "../context";

describe("context.computeBreadth", () => {
  it("empty → zeros", () => {
    expect(computeBreadth([])).toEqual({ bull_pct: 0, bear_pct: 0, balanced_pct: 0, no_signal_pct: 0, n: 0 });
  });
  it("majority bull", () => {
    const b = computeBreadth(["long-priority", "long-priority", "long-priority", "balanced"]);
    expect(b.bull_pct).toBe(0.75);
    expect(b.bear_pct).toBe(0);
    expect(b.n).toBe(4);
  });
});

describe("context.computeContext", () => {
  const emptyFleet = { bull_pct: 0, bear_pct: 0, balanced_pct: 0, no_signal_pct: 0, n: 0 };
  const neutralAnchors = { btc: "no-signal" as const, eth: "no-signal" as const };

  it("no info → zero adjust, correlation null", () => {
    const r = computeContext({
      symbol: "SOL-USDT",
      proposedBias: "no-signal",
      proposedScore: 0,
      fleet: emptyFleet,
      anchors: neutralAnchors,
      symbolCloses: [],
      btcCloses: [],
    });
    expect(r.adjust).toBe(0);
    expect(r.correlation).toBeNull();
    expect(r.not_connected).toBe(NOT_CONNECTED);
  });

  it("caps adjust at ±MAX", () => {
    const bulls = new Array(10).fill(0).map((_, i) => 100 + i);
    const r = computeContext({
      symbol: "LINK-USDT",
      proposedBias: "long-priority",
      proposedScore: 0.5,
      fleet: { bull_pct: 0.9, bear_pct: 0, balanced_pct: 0, no_signal_pct: 0.1, n: 10 },
      anchors: { btc: "long-priority", eth: "long-priority" },
      symbolCloses: bulls,
      btcCloses: bulls,
    });
    expect(r.adjust).toBeLessThanOrEqual(CONTEXT_MAX_ADJUST);
    expect(r.adjust).toBeGreaterThan(0);
  });

  it("bearish BTC + bearish anchors → negative adjust", () => {
    const r = computeContext({
      symbol: "AVAX-USDT",
      proposedBias: "short-priority",
      proposedScore: -0.3,
      fleet: { bull_pct: 0, bear_pct: 0.8, balanced_pct: 0.1, no_signal_pct: 0.1, n: 10 },
      anchors: { btc: "short-priority", eth: "short-priority" },
      symbolCloses: [],
      btcCloses: [],
    });
    expect(r.adjust).toBeLessThan(0);
    expect(r.reasons).toContain("context_btc_bear");
  });

  it("returns() drops non-positive prev prices", () => {
    expect(returns([100, 110, 121])).toEqual([0.1, 0.1]);
  });
});
