// Pausing order routing must not pause account observation. Permission to read
// is independent of permission to trade; disconnected/unverified accounts are
// deliberately excluded. Never reuse this policy to authorize order writes.
export const READABLE_VENUE_STATUSES = ["verified", "paused"];
export const RECONCILED_VENUES = ["apex_omni", "apex_omni_testnet", "aster"];

export function selectReadableVenueConnections<T extends {
  eq: (column: string, value: boolean) => T;
  in: (column: string, values: string[]) => T;
}>(query: T): T {
  return query.eq("permission_read", true)
    .in("status", READABLE_VENUE_STATUSES)
    .in("exchange", RECONCILED_VENUES);
}
