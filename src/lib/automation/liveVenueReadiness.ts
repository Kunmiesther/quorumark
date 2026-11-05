export type LiveVenueConnection = {
  id: string; exchange: string; environment: string; status: string;
  permission_trade: boolean; permissions_verified: boolean; is_live: boolean;
};
type Credential = { exchange_connection_id: string; environment: string; active: boolean; revoked_at: string | null };
type Strategy = { connection_id: string | null; enabled: boolean; mode: string };
export const AUTOMATION_VENUES = new Set(["apex_omni", "aster"]);

export function verifiedAutomationVenue(connection: Pick<LiveVenueConnection,
  "exchange" | "status" | "permission_trade" | "permissions_verified"> | null): boolean {
  return Boolean(connection && AUTOMATION_VENUES.has(connection.exchange) &&
    connection.status === "verified" && connection.permission_trade === true &&
    connection.permissions_verified === true);
}

export function executionReadyConnections(connections: LiveVenueConnection[], credentials: Credential[]) {
  return connections.filter(connection =>
    verifiedAutomationVenue(connection) && ["mainnet", "production", "live"].includes(connection.environment) &&
    // Aster's verified agent credentials do not use ApeX STARK signing records.
    (connection.exchange === "aster" || credentials.some(credential =>
      credential.exchange_connection_id === connection.id && credential.active === true &&
      credential.environment === "mainnet" && !credential.revoked_at)));
}

export function hasRunningLiveStrategy(connections: LiveVenueConnection[], strategies: Strategy[],
  venues?: Record<string, boolean>): boolean {
  return connections.some(connection => connection.is_live === true &&
    (!venues || venues[connection.exchange] === true) && strategies.some(strategy =>
      strategy.connection_id === connection.id && strategy.enabled === true && strategy.mode === "live"));
}

export function liveAutomationReason(connections: LiveVenueConnection[], strategies: Strategy[],
  venues: Record<string, boolean>): string {
  const available = connections.filter(connection => venues[connection.exchange] === true);
  if (!available.length) return "The automation broker or signer is not ready for your verified exchange routes.";
  if (hasRunningLiveStrategy(available, strategies, venues)) return "Live strategy routing is enabled on a resumed exchange.";
  const armedPaused = available.some(connection => !connection.is_live && strategies.some(strategy =>
    strategy.connection_id === connection.id && strategy.enabled && strategy.mode === "live"));
  return armedPaused
    ? "Your strategy is enabled, but its exchange is paused. Use Resume trading on Exchanges."
    : "No enabled live strategy is configured for a ready exchange. Review and arm a strategy, then resume its exchange.";
}
