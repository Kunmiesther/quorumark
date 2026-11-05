import { describe, it, expect } from "vitest";
import { CAPABILITY_MATRIX, getContract, isAllowed, LADDER_STRATEGY_IDS } from "../capabilityMatrix";
import { LADDER_STRATEGIES } from "@/lib/paper/ladder-policy";

describe("capabilityMatrix", () => {
  it("local roles cannot sign; live signing belongs to the private signer", () => {
    for (const c of CAPABILITY_MATRIX) {
      expect(c.capabilities).not.toContain("sign_live_order");
    }
  });
  it("declares Vanguard and Sweep without inventing Arbiter execution",()=>{
    expect(isAllowed("vanguard","open")).toBe(true);
    expect(isAllowed("sweep","open")).toBe(true);
    expect(getContract("sweep")?.summary).toContain("live campaign parity");
    expect(isAllowed("arbiter","open")).toBe(false);
    expect(getContract("arbiter")?.summary).toContain("Arbitrage");
  });

  it("scout is intelligence-only and CANNOT execute", () => {
    expect(isAllowed("scout", "detect")).toBe(true);
    expect(isAllowed("scout", "recommend")).toBe(true);
    expect(isAllowed("scout", "open")).toBe(false);
    expect(isAllowed("scout", "close")).toBe(false);
    expect(isAllowed("scout", "add_rung")).toBe(false);
    expect(isAllowed("scout", "decide")).toBe(false);
  });

  it("onyx can decide but cannot detect or sign live orders", () => {
    expect(isAllowed("onyx", "decide")).toBe(true);
    expect(isAllowed("onyx", "detect")).toBe(false);
    expect(isAllowed("onyx", "sign_live_order")).toBe(false);
  });

  it("accumulator and dca are the ladder-owning strategies", () => {
    expect(isAllowed("accumulator", "add_rung")).toBe(true);
    expect(isAllowed("dca", "add_rung")).toBe(true);
    expect(isAllowed("hunter", "add_rung")).toBe(false);
    expect(isAllowed("sniper", "add_rung")).toBe(false);
    expect(isAllowed("arbiter", "add_rung")).toBe(false);
  });

  it("LADDER_STRATEGY_IDS matches ladder-policy.LADDER_STRATEGIES exactly", () => {
    expect([...LADDER_STRATEGY_IDS].sort()).toEqual([...LADDER_STRATEGIES].sort());
  });

  it("fusion has ZERO capabilities and denies open/add/close (product surface only)", () => {
    const fusion = getContract("fusion")!;
    expect(fusion.capabilities).toHaveLength(0);
    for (const cap of ["open", "add_rung", "close", "decide", "detect", "sign_live_order"] as const) {
      expect(isAllowed("fusion", cap)).toBe(false);
    }
  });

  it("unknown subsystem has NO capabilities (default-deny)", () => {
    expect(isAllowed("random-thing", "open")).toBe(false);
    expect(isAllowed("random-thing", "detect")).toBe(false);
  });
});
