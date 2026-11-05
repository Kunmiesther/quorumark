import { describe, expect, it } from "vitest";
import { planExecutionState } from "./planExecutionState";
const live = { mode: "live", enabled: true };
describe("saved plan and execution reconciliation", () => {
  it("identifies the legacy paper pause without claiming live execution stopped", () => {
    const state = planExecutionState("paused", [live], "Automatic loss limit reached");
    expect(state.conflict).toBe(true);
    expect(state.label).toBe("Live rows armed · plan needs reconciliation");
    expect(state.detail).toContain("did not verify plan attribution");
    expect(planExecutionState("paused", [live], "Paused by user").label).toBe(
      "Configuration conflict",
    );
  });
  it.each(["draft", "awaiting_approval", "paused", "rejected", "archived"])(
    "does not hide armed rows behind %s",
    (status) => {
      const state = planExecutionState(status, [live]);
      expect(state.conflict).toBe(true);
      expect(state.label).toBe("Configuration conflict");
      expect(state.armed).toBe(1);
    },
  );
  it("does not equate saved eligibility to execution", () => {
    expect(planExecutionState("live_configured", [{ ...live, enabled: false }])).toMatchObject({
      label: "Not armed live", armed: 0, conflict: false,
    });
    expect(planExecutionState("live_configured", [live])).toMatchObject({
      label: "Live rows armed", armed: 1, conflict: false,
    });
    expect(planExecutionState("live_eligible", []).label).toBe("No execution rows");
    expect(planExecutionState("live_eligible", [{ ...live, enabled: false }]).label).toBe(
      "Not armed live",
    );
  });
  it("distinguishes partial and full arming without claiming fills", () => {
    expect(planExecutionState("live_eligible", [live]).label).toBe("Live rows armed");
    expect(planExecutionState("live_eligible", [live, { ...live, enabled: false }]).label).toBe(
      "Partially armed",
    );
  });
  it("does not count paper rows or mutate settings", () => {
    const row = Object.freeze({ mode: "paper", enabled: true });
    expect(planExecutionState("paused", [row])).toMatchObject({ armed: 0, conflict: false });
  });
});
