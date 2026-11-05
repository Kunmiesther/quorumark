/** A flat venue snapshot proves closure, not realized P&L or an exit price. */
export function livePositionClosePatch(at: string, priorMetadata: unknown) {
  if (!Number.isFinite(Date.parse(at))) throw new Error("INVALID_RECONCILIATION_TIME");
  const metadata = priorMetadata && typeof priorMetadata === "object" && !Array.isArray(priorMetadata)
    ? priorMetadata as Record<string, unknown> : {};
  return {
    status: "closed", synced_at: at, updated_at: at, open_orders: [],
    pnl_amount: null, pnl_pct: null, unrealized_pnl: null,
    current_price: null, mark_price: null,
    strategy_metadata: { ...metadata, closure_evidence: {
      source: "venue_flat_snapshot", observed_at: at, realized_pnl_verified: false,
    } },
  };
}

/** Bounded independent reads; one failed route cannot discard other results. */
export async function reconcileConnections<T, R>(
  rows: readonly T[], run: (row: T) => Promise<R>, onError: (row: T) => R, concurrency = 3,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("INVALID_CONCURRENCY");
  const results = new Array<R>(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      try { results[index] = await run(rows[index]); }
      catch { results[index] = onError(rows[index]); }
    }
  }));
  return results;
}
