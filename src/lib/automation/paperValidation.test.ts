import { describe, expect, it } from "vitest";
import { evaluatePaperEvidence } from "../../../supabase/functions/autopilot-plan/validation";

describe("Autopilot paper validation", () => {
  it("qualifies only a sufficient, profitable, compliant sample", () => {
    const result = evaluatePaperEvidence(
      Array.from({ length: 30 }, () => ({ realized_pnl: 1 })),
      1000,
      0,
    );
    expect(result.qualified).toBe(true);
  });

  it("blocks an undersized sample and a risk violation", () => {
    const result = evaluatePaperEvidence(
      Array.from({ length: 29 }, () => ({ realized_pnl: 1 })),
      1000,
      1,
    );
    expect(result.qualified).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.key)).toEqual([
      "sample_size",
      "risk_violations",
    ]);
  });

  it("blocks drawdown above ten percent", () => {
    const trades = [
      ...Array.from({ length: 29 }, () => ({ realized_pnl: 1 })),
      { realized_pnl: -120 },
    ];
    const result = evaluatePaperEvidence(trades, 1000, 0);
    expect(result.qualified).toBe(false);
    expect(result.checks.find((check) => check.key === "max_drawdown")?.passed).toBe(false);
  });

  it("does not count explicitly unverified client evidence", () => {
    const trades = Array.from({ length: 30 }, () => ({
      realized_pnl: 10,
      evidence_verified: false,
    }));
    const result = evaluatePaperEvidence(trades, 1000, 0);

    expect(result.qualified).toBe(false);
    expect(result.checks[0]).toMatchObject({ actual: 0, passed: false });
  });
});
