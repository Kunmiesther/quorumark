import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../AutomationObservatory.tsx"), "utf8");

describe("Automation observatory evidence contract", () => {
  it("reads live closes and the restored advisory ledger using deployed columns", () => {
    expect(source).toContain(
      "id,connection_id,wallet_connection_id,autopilot_workflow_id,exchange,strategy_id,decision_id,pair,realized_pnl,closed_at",
    );
    expect(source).toContain('from("live_position_advisories")');
    expect(source).toContain('eq("evidence_verified", true)');
  });

  it("does not invent per-Turtle performance or claim account results are automation-only", () => {
    expect(source).toContain("Unattributed strategy");
    expect(source).toContain("account-wide, not automation-only");
    expect(source).toContain("Current reconciled fills retain wallet, workflow, strategy");
  });

  it("keeps a decision timeline refreshed without claiming an order from an advisory", () => {
    expect(source).toContain("refetchInterval: 15_000");
    expect(source).toContain('table: "strategy_decisions"');
    expect(source).toContain("No venue order in this review");
  });
});
