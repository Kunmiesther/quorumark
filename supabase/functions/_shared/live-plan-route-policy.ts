export const LIVE_EXECUTION_VENUES = new Set(["apex_omni", "aster"]);
export type PlanVenueConnection = {
  exchange: string; environment: string; status: string;
  permission_read: boolean; permission_trade: boolean; permissions_verified: boolean;
};
/** Static support plus verified account permission; runtime gates are checked separately. */
export function supportsLivePlan(connection: PlanVenueConnection): boolean {
  return LIVE_EXECUTION_VENUES.has(connection.exchange) &&
    ["mainnet", "production", "live"].includes(connection.environment) &&
    connection.status === "verified" && connection.permissions_verified === true &&
    connection.permission_read === true && connection.permission_trade === true;
}
