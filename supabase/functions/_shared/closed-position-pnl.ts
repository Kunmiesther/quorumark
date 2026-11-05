type ReconciliationClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

/** Closed accounting only. The database verifies evidence and owns atomicity. */
export async function reconcileClosedPositionPnl(
  client: ReconciliationClient, connection: { id: string; user_id: string; exchange: string },
) {
  if (!["apex_omni", "aster"].includes(connection.exchange)) {
    return { status: "not_applicable", settled: 0, unresolved: 0 };
  }
  return reconcile(client, connection, "reconcile_closed_position_pnl");
}

/** A separate venue-reported basis, never reused for another exchange. */
export async function reconcileApexReportedPnl(
  client: ReconciliationClient, connection: { id: string; user_id: string; exchange: string },
) {
  if (connection.exchange !== "apex_omni") {
    return { status: "not_applicable", settled: 0, unresolved: 0 };
  }
  return reconcile(client, connection, "reconcile_apex_reported_pnl");
}

async function reconcile(client: ReconciliationClient,
  connection: { id: string; user_id: string }, rpc: string,
) {
  try {
    const { data, error } = await client.rpc(rpc, {
      p_user_id: connection.user_id, p_connection_id: connection.id, p_apply: true,
    });
    if (error || !data || typeof data !== "object" || !("results" in data)
      || !Array.isArray(data.results) || !("applied" in data) || data.applied !== true) {
      return { status: "failed", reason: "CLOSED_PNL_RECONCILIATION_FAILED" };
    }
    const settled = data.results.filter(row => row?.status === "SETTLED").length;
    return { status: "checked", settled, unresolved: data.results.length - settled,
      results: data.results };
  } catch {
    // Do not leak database errors or discard the independently successful venue snapshot.
    return { status: "failed", reason: "CLOSED_PNL_RECONCILIATION_FAILED" };
  }
}
