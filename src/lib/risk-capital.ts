/**
 * Risk Capital — per-connection isolation (P3-AMEND).
 *
 * Display / validation helpers ONLY. These MUST NOT read Life Map
 * balances and MUST NOT feed order sizing. The $500 cap is enforced
 * PER CONNECTION independently. The $3,000 aggregate is emergent from
 * MAX_CONNECTIONS × RISK_CAPITAL_MAX_PER_CONNECTION — never hardcoded.
 * Allocation is never borrowed across connections. Leverage may raise
 * notional exposure but allocated margin per connection is capped at
 * RISK_CAPITAL_MAX_PER_CONNECTION.
 */

export const RISK_CAPITAL_MAX_PER_CONNECTION = 500;
export const MAX_CONNECTIONS = 6;
export const MAX_AGGREGATE_RISK_CAPITAL =
  RISK_CAPITAL_MAX_PER_CONNECTION * MAX_CONNECTIONS;

export function capPerConnection(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  if (amount > RISK_CAPITAL_MAX_PER_CONNECTION) {
    return RISK_CAPITAL_MAX_PER_CONNECTION;
  }
  return amount;
}

export function leveragedNotional(margin: number, leverage: number): number {
  const m = Number.isFinite(margin) ? margin : 0;
  const l = Number.isFinite(leverage) ? leverage : 0;
  return m * l;
}

export interface ConnectionExposure {
  connection_id: string;
  marginAllocated: number;
  leverage: number;
  notionalExposure: number;
}

export function aggregateExposure(
  list: readonly ConnectionExposure[],
): { totalMargin: number; totalNotional: number } {
  let totalMargin = 0;
  let totalNotional = 0;
  for (const c of list) {
    totalMargin += c.marginAllocated;
    totalNotional += c.notionalExposure;
  }
  return { totalMargin, totalNotional };
}
