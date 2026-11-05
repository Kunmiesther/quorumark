import { describe, expect, it } from "vitest";
import { synFuturesReadiness, type SynReadinessObservation } from "./readiness";
const ready: SynReadinessObservation = {
  stage: "deployed", balances: { gate_reserve_usdc: "100" },
  permissions: { module_enabled: true, operator: "0x1111111111111111111111111111111111111111", session_authorized_at_block: true, exit_session_authorized_at_block: true },
  markets: [{ symbol: "BTC-USDC", entries_enabled: true }], operatorGasWei: "1000",
};
describe("SynFutures activation requirements", () => {
  it("distinguishes expired exit authority from exhausted entry budget", () => {
    const exhausted = synFuturesReadiness({ ...ready, permissions: { ...ready.permissions!, session_authorized_at_block: false } });
    expect(exhausted.blockers).toContain("ENTRY_SESSION_UNAVAILABLE");
    expect(exhausted.blockers).not.toContain("EXIT_SESSION_UNAVAILABLE");
    const expired = synFuturesReadiness({ ...ready, permissions: { ...ready.permissions!, session_authorized_at_block: false, exit_session_authorized_at_block: false } });
    expect(expired.blockers).toContain("EXIT_SESSION_UNAVAILABLE");
  });
  it("does not present deployed and authorized contracts as a working worker and exit adapter", () => {
    expect(synFuturesReadiness(ready)).toEqual({ execution_ready: false,
      blockers: ["AUTONOMOUS_EXECUTION_UNAVAILABLE", "PROTECTIVE_EXIT_UNAVAILABLE"] });
  });
  it("shows revoked sessions, disabled markets, and missing collateral and operator gas", () => {
    const result = synFuturesReadiness({ ...ready, balances: { gate_reserve_usdc: "0" },
      permissions: { module_enabled: false, operator: "0x" + "0".repeat(40), session_authorized_at_block: false },
      markets: [{ symbol: "BTC-USDC", entries_enabled: false }], operatorGasWei: "0" });
    expect(result.blockers).toEqual(expect.arrayContaining(["ENTRY_COLLATERAL_REQUIRED", "MODULE_NOT_ENABLED",
      "OPERATOR_NOT_AUTHORIZED", "ENTRY_SESSION_UNAVAILABLE", "MARKET_ENTRIES_DISABLED", "OPERATOR_GAS_REQUIRED"]));
  });
  it("keeps unavailable observations distinct from zero collateral", () => {
    const result = synFuturesReadiness({ ...ready, balances: null, permissions: null, markets: null, operatorGasWei: null });
    expect(result.blockers).toEqual(expect.arrayContaining(["COLLATERAL_UNVERIFIED", "SESSION_UNVERIFIED",
      "MARKET_LIMITS_UNVERIFIED", "OPERATOR_GAS_UNVERIFIED"]));
    expect(result.blockers).not.toContain("ENTRY_COLLATERAL_REQUIRED");
  });
  it("preserves exact decimal amounts without rounding dust to zero", () => {
    expect(synFuturesReadiness({ ...ready, balances: { gate_reserve_usdc: "0.000001" } }).blockers).not.toContain("ENTRY_COLLATERAL_REQUIRED");
  });
});
