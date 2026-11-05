/**
 * Hedge planner tests (P3).
 * Locks the four-cell decision matrix and the fail-safe branches.
 */
import { describe, it, expect } from "vitest";
import { planHedge, HEDGE_SCHEMA_VERSION, type HedgeAction } from "../hedge";

describe("planHedge — matrix", () => {
  it("opposing + hedge supported → native_hedge", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: "long",
      hedgeSupported: true,
      proposedDirection: "short",
    });
    expect(p.action).toBe<HedgeAction>("native_hedge");
    expect(p.opposingDirection).toBe("short");
  });

  it("opposing + no hedge support → close_and_reverse", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: "short",
      hedgeSupported: false,
      proposedDirection: "long",
    });
    expect(p.action).toBe<HedgeAction>("close_and_reverse");
    expect(p.opposingDirection).toBe("long");
  });

  it("opposing + unknown capability → hold_and_flag", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: "long",
      hedgeSupported: null,
      proposedDirection: "short",
    });
    expect(p.action).toBe<HedgeAction>("hold_and_flag");
    expect(p.reasonCodes).toContain("hedge_unresolved_capability");
  });

  it("non-opposing regime → no_action regardless of capability", () => {
    for (const r of ["strong_uptrend", "ranging", "volatile", "reversal_forming", "unknown"] as const) {
      const p = planHedge({
        regime: r,
        openDirection: "long",
        hedgeSupported: true,
        proposedDirection: "short",
      });
      expect(p.action).toBe<HedgeAction>("no_action");
    }
  });

  it("opposing but proposed matches open → no_action (inconsistent)", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: "long",
      hedgeSupported: true,
      proposedDirection: "long",
    });
    expect(p.action).toBe<HedgeAction>("no_action");
    expect(p.reasonCodes).toContain("proposed_matches_open_direction");
  });

  it("opposing but missing directions → hold_and_flag", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: null,
      hedgeSupported: true,
      proposedDirection: "short",
    });
    expect(p.action).toBe<HedgeAction>("hold_and_flag");
    expect(p.reasonCodes).toContain("hedge_input_inconsistent");
  });

  it("emits versioned schema tag", () => {
    const p = planHedge({
      regime: "opposing_to_open_position",
      openDirection: "long",
      hedgeSupported: true,
      proposedDirection: "short",
    });
    expect(p.schemaVersion).toBe(HEDGE_SCHEMA_VERSION);
  });
});

describe("planHedge — determinism", () => {
  it("same input → same output", () => {
    const input = {
      regime: "opposing_to_open_position" as const,
      openDirection: "long" as const,
      hedgeSupported: false,
      proposedDirection: "short" as const,
    };
    const runs = Array.from({ length: 20 }, () => JSON.stringify(planHedge(input)));
    for (const r of runs) expect(r).toBe(runs[0]);
  });
});
