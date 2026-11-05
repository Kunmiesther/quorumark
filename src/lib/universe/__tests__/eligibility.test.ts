import { describe, it, expect } from "vitest";
import { DEFAULT_ELIGIBILITY, filterEligibility } from "../eligibility";
import { resolveOverrides } from "../overrides";
import type { VerifiedInstrument, VerifiedUniverse } from "../types";

function inst(partial: Partial<VerifiedInstrument>): VerifiedInstrument {
  return {
    symbol: "BTC-USDT",
    venueSymbol: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    tradable: true,
    maxLeverage: 100,
    tickSize: 0.1,
    minQty: 0.001,
    minNotional: 5,
    volume24hUsd: 100_000_000,
    spreadBps: 3,
    ageMs: 1_000,
    ...partial,
  };
}

function uni(instruments: VerifiedInstrument[]): VerifiedUniverse {
  return {
    exchange: "apex_omni",
    environment: "paper",
    marketType: "futures",
    adapterVersion: 1,
    capabilityVersion: 1,
    health: "healthy",
    instruments,
    detail: {},
    generatedAt: Date.now(),
  };
}

describe("eligibility filter — fail closed", () => {
  it("passes a well-formed liquid instrument", () => {
    const res = filterEligibility(uni([inst({})]), []);
    expect(res[0].eligible).toBe(true);
    expect(res[0].reasons).toEqual([]);
  });

  it("rejects when metadata is stale", () => {
    const res = filterEligibility(uni([inst({ ageMs: DEFAULT_ELIGIBILITY.maxAgeMs + 1 })]), []);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("metadata_stale");
  });

  it("rejects when required fields are missing", () => {
    const res = filterEligibility(
      uni([inst({ maxLeverage: null, tickSize: null, minNotional: null })]),
      [],
    );
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toEqual(
      expect.arrayContaining(["missing_maxLeverage", "missing_tickSize", "missing_minNotional"]),
    );
  });

  it("rejects thin liquidity", () => {
    const res = filterEligibility(uni([inst({ volume24hUsd: 10_000 })]), []);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("liquidity_below_min");
  });

  it("rejects wide spread", () => {
    const res = filterEligibility(uni([inst({ spreadBps: 500 })]), []);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("spread_above_max");
  });

  it("rejects tradable=false", () => {
    const res = filterEligibility(uni([inst({ tradable: false })]), []);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("not_tradable");
  });

  it("rejects sub-min leverage", () => {
    const res = filterEligibility(uni([inst({ maxLeverage: 2 })]), []);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("leverage_below_min");
  });

  it("owner deny override forces exclude even when eligible", () => {
    const overrides = resolveOverrides([
      { symbol: "BTC-USDT", kind: "deny", expiresAt: null, reason: "manual" },
    ]);
    const res = filterEligibility(uni([inst({})]), overrides);
    expect(res[0].eligible).toBe(false);
    expect(res[0].reasons).toContain("override_deny");
  });

  it("emergency_allow override forces include even when ineligible", () => {
    const overrides = resolveOverrides([
      { symbol: "BTC-USDT", kind: "emergency_allow", expiresAt: null, reason: "launch" },
    ]);
    const res = filterEligibility(uni([inst({ volume24hUsd: 100 })]), overrides);
    expect(res[0].eligible).toBe(true);
    expect(res[0].reasons).toContain("override_emergency_allow");
  });

  it("expired overrides are ignored", () => {
    const overrides = resolveOverrides(
      [{ symbol: "BTC-USDT", kind: "deny", expiresAt: 1_000, reason: null }],
      2_000,
    );
    expect(overrides).toEqual([]);
  });

  it("precedence: emergency_allow beats deny beats allow", () => {
    const r = resolveOverrides([
      { symbol: "BTC-USDT", kind: "allow", expiresAt: null, reason: null },
      { symbol: "BTC-USDT", kind: "deny", expiresAt: null, reason: null },
      { symbol: "BTC-USDT", kind: "emergency_allow", expiresAt: null, reason: null },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].effective).toBe("force_include");
    expect(r[0].source).toBe("emergency_allow");
  });
});
