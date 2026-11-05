import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("Autopilot and Life Map setup", () => {
  it("opens the Onyx planner from the setup control, not an anchor to itself", () => {
    const suite = read("../../turtle/SuiteSelectCard.tsx");
    const status = read("../AutopilotPlanStatus.tsx");
    expect(suite).toMatch(/Build with Onyx/);
    expect(suite).toMatch(/if \(first\) setPlanning\(first\)/);
    expect(status).not.toMatch(/href="#automation"/);
  });

  it("validates a selected bill belongs to the account before saving the plan", () => {
    const edge = read("../../../../supabase/functions/autopilot-plan/index.ts");
    expect(edge).toMatch(/\.eq\("user_id", auth\.user\.id\)/);
    expect(edge).toMatch(/\.is\("archived_at", null\)/);
    expect(edge).toMatch(/goal_label: goalLabel/);
  });

  it("labels paper and live allocation separately", () => {
    const income = read("../AutomationIncomePanel.tsx");
    const lifeMap = read("../../../routes/_authenticated/life-map.tsx");
    expect(income).toMatch(/total_paper_covered_usd/);
    expect(lifeMap).toMatch(/Live income allocated this period/);
    expect(lifeMap).toMatch(/Paper simulation:/);
  });
});
