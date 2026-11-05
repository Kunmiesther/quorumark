import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const planner = fs.readFileSync(path.resolve(__dirname, "../AutopilotPlannerModal.tsx"), "utf8");
const suite = fs.readFileSync(path.resolve(__dirname, "../SuiteSelectCard.tsx"), "utf8");
const lifeMap = fs.readFileSync(
  path.resolve(__dirname, "../../../routes/_authenticated/life-map.tsx"),
  "utf8",
);
const edgeWorkflow = fs.readFileSync(
  path.resolve(__dirname, "../../../../supabase/functions/autopilot-plan/index.ts"),
  "utf8",
);

describe("Autopilot planning workflow", () => {
  it("uses the same authenticated bills source as Life Map", () => {
    expect(planner).toMatch(/listBills/);
    expect(planner).toMatch(/queryKey: \["bills"\]/);
  });

  it("collects goal, boundaries, risk mode, and review before configuration", () => {
    expect(planner).toMatch(/\["Goal", "Assessment", "Mode", "Review"\]/);
    expect(planner).toMatch(/Maximum loss before pausing/);
    expect(planner).toMatch(/Conservative/);
    expect(planner).toMatch(/Approve for paper/);
    expect(planner).toMatch(/functions\.invoke\("autopilot-plan"/);
    expect(edgeWorkflow).toMatch(/StateGraph/);
    expect(edgeWorkflow).toMatch(/paper_validation/);
  });

  it("keeps bill amounts out of position-sizing promises", () => {
    expect(planner).toMatch(/bill amount will not increase trade[\s\S]*?size/i);
  });

  it("creates execution rows from the Onyx mandate without a disconnected second modal", () => {
    expect(suite).toMatch(/<AutopilotPlannerModal/);
    expect(suite).not.toMatch(/<StrategyConfigModal/);
    expect(edgeWorkflow).toMatch(/from\("user_strategy"\)/);
    expect(edgeWorkflow).toMatch(/autopilot_workflow_id/);
    expect(planner).toContain("Where each symbol trades");
    expect(planner).toContain("walletBySymbol");
    expect(edgeWorkflow).toContain("wallet_connection_id: assignment.walletConnectionId");
    expect(planner).toContain('"configure_live"');
    expect(edgeWorkflow).toContain('mode: liveSetup ? "live" : "paper"');
    expect(edgeWorkflow).toContain("enabled: !liveSetup");
  });

  it("never leaves the Autopilot entry surface blank when the catalog is unavailable", () => {
    expect(suite).toMatch(/Strategy catalog unavailable/);
    expect(suite).toMatch(/Refresh catalog/);
    expect(suite).toMatch(/Check connection/);
  });

  it("keeps bot activation controls off the Life Map page", () => {
    expect(lifeMap).not.toMatch(/<ActivationStrip/);
    expect(lifeMap).toMatch(/Build an Autopilot plan/);
  });

  it("counts configured trading Turtles and keeps Scout as reconnaissance", () => {
    expect(suite).toContain('strategy.slug !== "ema-cross"');
    expect(suite).toContain("configuredTradingCount");
    expect(suite).toContain("Scout handles reconnaissance separately");
    expect(suite).toContain("openScout()");
    expect(suite).toContain("Not configured");
    expect(suite).toContain("Live armed");
  });
});
