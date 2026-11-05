/** The owner's connection switch is independent of credential validity. */
export function permitsLiveEntry(connection: Record<string, unknown> | null): boolean {
  return connection?.is_live === true && connection.status === "verified" &&
    connection.permission_trade === true && connection.permissions_verified === true;
}
