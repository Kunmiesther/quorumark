import { describe, it, expect } from "vitest";
import {
  guardianCloseExitReason,
  GUARDIAN_EXIT_REASONS,
  type GuardianExitReason,
} from "../guardian";

// The exit reasons the engine may write for a Guardian force-close. These MUST
// stay a subset of the paper_trades_exit_reason_check constraint added in
// migration 20260723181500_scout_guardian_directives.sql.
const ALLOWED_TRADE_EXIT_REASONS = new Set([
  "tp_touch",
  "stop",
  "floor",
  "scout_bos",
  "paper_reset",
  "scout_guardian_bos",
  "scout_guardian_cluster",
]);

describe("guardianCloseExitReason", () => {
  it("maps the correlated-cluster rule to scout_guardian_cluster", () => {
    expect(guardianCloseExitReason("scout_guardian_cluster")).toBe("scout_guardian_cluster");
  });

  it("maps adverse-BOS and every other code to the structural default", () => {
    expect(guardianCloseExitReason("scout_guardian_bos")).toBe("scout_guardian_bos");
    expect(guardianCloseExitReason("scout_guardian_ladder_underwater")).toBe("scout_guardian_bos");
    expect(guardianCloseExitReason("something_new")).toBe("scout_guardian_bos");
    expect(guardianCloseExitReason(null)).toBe("scout_guardian_bos");
    expect(guardianCloseExitReason(undefined)).toBe("scout_guardian_bos");
  });

  it("only ever returns a value the paper_trades CHECK constraint permits", () => {
    const codes = ["scout_guardian_cluster", "scout_guardian_bos", "", "x", null, undefined];
    for (const c of codes) {
      const reason: GuardianExitReason = guardianCloseExitReason(c as string);
      expect(ALLOWED_TRADE_EXIT_REASONS.has(reason)).toBe(true);
    }
  });

  it("declares both exit reasons in GUARDIAN_EXIT_REASONS", () => {
    expect([...GUARDIAN_EXIT_REASONS].sort()).toEqual([
      "scout_guardian_bos",
      "scout_guardian_cluster",
    ]);
  });
});
