/**
 * Adaptive formation planner tests (P2).
 *
 * Locks the regime → formation classification, universal five-rung sizing,
 * and the "no entry" contract for the two hedge-adjacent regimes.
 */
import { describe, it, expect } from "vitest";
import {
  planFormation,
  FORMATION_SCHEMA_VERSION,
  type FormationMode,
} from "../adaptiveFormation";
const BTC = "BTC-USDT";
const ETH = "ETH-USDT";
const LINK = "LINK-USDT";
const SOL = "SOL-USDT";
const XRP = "XRP-USDT";

describe("planFormation — mode mapping", () => {
  it("strong_uptrend → precision with five rungs", () => {
    expect(planFormation({ regime: "strong_uptrend", leverage: 100, symbol: BTC }).rungs).toBe(5);
    expect(planFormation({ regime: "strong_uptrend", leverage: 50, symbol: LINK }).rungs).toBe(5);
  });
  it("strong_downtrend → precision with five rungs", () => {
    const eth = planFormation({ regime: "strong_downtrend", leverage: 100, symbol: ETH });
    expect(eth.mode).toBe<FormationMode>("precision");
    expect(eth.rungs).toBe(5);
    expect(planFormation({ regime: "strong_downtrend", leverage: 50, symbol: SOL }).rungs).toBe(5);
  });
  it("developing_trend → staged with five rungs", () => {
    expect(planFormation({ regime: "developing_trend", leverage: 100, symbol: BTC }).rungs).toBe(5);
    expect(planFormation({ regime: "developing_trend", leverage: 50, symbol: LINK }).rungs).toBe(5);
  });
  it("ranging / volatile / unknown → adaptive with five rungs", () => {
    for (const r of ["ranging", "volatile", "unknown"] as const) {
      const btc = planFormation({ regime: r, leverage: 100, symbol: BTC });
      expect(btc.mode).toBe<FormationMode>("adaptive");
      expect(btc.rungs).toBe(5);
      const link = planFormation({ regime: r, leverage: 50, symbol: LINK });
      expect(link.mode).toBe<FormationMode>("adaptive");
      expect(link.rungs).toBe(5);
    }
  });
  it("reversal_forming → wait (no entry authorized)", () => {
    const p = planFormation({ regime: "reversal_forming", leverage: 100, symbol: BTC });
    expect(p.mode).toBe<FormationMode>("wait");
    expect(p.rungs).toBe(0);
    expect(p.reasonCodes).toContain("reversal_forming_no_entry");
  });
  it("opposing_to_open_position → wait (delegates to P3 hedge)", () => {
    const p = planFormation({ regime: "opposing_to_open_position", leverage: 100, symbol: BTC });
    expect(p.mode).toBe<FormationMode>("wait");
    expect(p.reasonCodes).toContain("opposing_to_open_delegate_to_hedge");
  });
});

describe("planFormation — wallet compounding invariant", () => {
  it("uses five percent of settled balance across all authorized modes", () => {
    const cases = [
      { regime: "strong_uptrend" as const, symbol: BTC, leverage: 100 },
      { regime: "strong_uptrend" as const, symbol: LINK, leverage: 50 },
      { regime: "developing_trend" as const, symbol: ETH, leverage: 100 },
      { regime: "developing_trend" as const, symbol: SOL, leverage: 50 },
      { regime: "ranging" as const, symbol: BTC, leverage: 100 },
      { regime: "unknown" as const, symbol: XRP, leverage: 50 },
    ];
    for (const c of cases) {
      const p = planFormation({ ...c, settledWalletBalance: 3_000 });
      expect(p.rungs).toBe(5);
      expect(p.totalMargin).toBe(150);
      expect(p.marginPerRung).toBe(30);
    }
  });
  it("wait plans commit zero margin", () => {
    const p = planFormation({ regime: "reversal_forming", leverage: 100, symbol: BTC });
    expect(p.totalMargin).toBe(0);
    expect(p.marginPerRung).toBe(0);
  });
});

describe("planFormation — determinism + schema", () => {
  it("emits versioned schema tag on every plan", () => {
    expect(planFormation({ regime: "ranging", leverage: 100, symbol: BTC }).schemaVersion).toBe(FORMATION_SCHEMA_VERSION);
    expect(planFormation({ regime: "reversal_forming", leverage: 100, symbol: BTC }).schemaVersion).toBe(FORMATION_SCHEMA_VERSION);
  });
  it("same input → same output", () => {
    const input = { regime: "developing_trend" as const, leverage: 100, symbol: BTC };
    const runs = Array.from({ length: 20 }, () => JSON.stringify(planFormation(input)));
    for (const r of runs) expect(r).toBe(runs[0]);
  });
});

describe("planFormation — symbol parity", () => {
  it.each([BTC, ETH, LINK, SOL, XRP])("%s gets the same five-rung geometry", (sym) => {
    for (const r of ["ranging", "volatile", "unknown"] as const) {
      const p = planFormation({ regime: r, leverage: 50, symbol: sym });
      expect(p.rungs).toBe(5);
    }
  });
});
