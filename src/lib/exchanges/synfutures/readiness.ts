/** Observed prerequisites are separate from a working autonomous execution path. */
export type SynReadinessObservation = {
  stage: "deploy_safe" | "deploy_module" | "deployed";
  balances: { gate_reserve_usdc: string } | null;
  permissions: { module_enabled: boolean; operator: string; session_authorized_at_block: boolean; exit_session_authorized_at_block?: boolean } | null;
  markets: Array<{ symbol: string; entries_enabled: boolean }> | null;
  operatorGasWei: string | null;
};
export function synFuturesReadiness(observed: SynReadinessObservation) {
  const blockers: string[] = [];
  if (observed.stage !== "deployed") blockers.push(observed.stage === "deploy_safe" ? "SAFE_NOT_DEPLOYED" : "MODULE_NOT_DEPLOYED");
  if (!observed.balances) blockers.push("COLLATERAL_UNVERIFIED");
  else if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(observed.balances.gate_reserve_usdc)) blockers.push("COLLATERAL_UNVERIFIED");
  else if (!/[1-9]/.test(observed.balances.gate_reserve_usdc)) blockers.push("ENTRY_COLLATERAL_REQUIRED");
  if (!observed.permissions) blockers.push("SESSION_UNVERIFIED");
  else {
    if (!observed.permissions.module_enabled) blockers.push("MODULE_NOT_ENABLED");
    if (/^0x0{40}$/i.test(observed.permissions.operator)) blockers.push("OPERATOR_NOT_AUTHORIZED");
    if (!observed.permissions.session_authorized_at_block) blockers.push("ENTRY_SESSION_UNAVAILABLE");
    if (observed.permissions.exit_session_authorized_at_block === undefined) blockers.push("EXIT_SESSION_UNVERIFIED");
    else if (!observed.permissions.exit_session_authorized_at_block) blockers.push("EXIT_SESSION_UNAVAILABLE");
  }
  if (!observed.markets) blockers.push("MARKET_LIMITS_UNVERIFIED");
  else if (!observed.markets.some(market => market.entries_enabled)) blockers.push("MARKET_ENTRIES_DISABLED");
  if (observed.operatorGasWei === null || !/^(?:0|[1-9]\d*)$/.test(observed.operatorGasWei)) blockers.push("OPERATOR_GAS_UNVERIFIED");
  else if (observed.operatorGasWei === "0") blockers.push("OPERATOR_GAS_REQUIRED");
  // These remain explicit until dedicated signing, worker dispatch and exits are verified.
  blockers.push("AUTONOMOUS_EXECUTION_UNAVAILABLE", "PROTECTIVE_EXIT_UNAVAILABLE");
  return { execution_ready: false as const, blockers };
}
