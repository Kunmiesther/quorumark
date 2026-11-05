/**
 * Life Map v2 — pure sync planner.
 *
 * Mirrors the loop inside `syncBillAllocations` without any I/O so we can
 * assert idempotency at unit-test level. Feeding the planner's own outputs
 * back into `existingKeys` on a second call MUST produce zero new inserts,
 * which is exactly the invariant the partial UNIQUE index
 * `(user_id, trade_id, bill_id)` guarantees in the DB.
 */
import { allocate, periodKeyFor, type BillForAlloc } from "./allocate";

export interface PlannerTrade {
  id: string;
  closed_at: string;
  pnl_net: number;
}

export interface PlannerInsert {
  trade_id: string;
  bill_id: string;
  amount_usd: number;
  period_key: string;
}

export interface PlanSyncInput {
  bills: readonly BillForAlloc[];
  /** Trades in chronological order (closed_at asc, id asc). */
  trades: readonly PlannerTrade[];
  /** Per-period covered totals BEFORE this batch. period_key -> bill_id -> usd. */
  coveredByPeriod: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * Trade ids already fully processed (any allocations already persisted).
   * Present-but-processed trades are skipped entirely; they may still exist
   * in `trades` when the caller re-reads a window that overlaps the cursor.
   */
  processedTradeIds: ReadonlySet<string>;
}

export interface PlanSyncResult {
  inserts: PlannerInsert[];
  cursor: { last_trade_closed_at: string | null; last_trade_id: string | null };
  totalAllocated: number;
  totalDrained: number;
}

export function planSyncBatch(input: PlanSyncInput): PlanSyncResult {
  const inserts: PlannerInsert[] = [];
  let totalAllocated = 0;
  let totalDrained = 0;
  let lastTs: string | null = null;
  let lastId: string | null = null;

  // Working copy of covered totals we mutate as we consume trades.
  const covered: Map<string, Map<string, number>> = new Map();
  for (const [pk, m] of Object.entries(input.coveredByPeriod)) {
    covered.set(pk, new Map(Object.entries(m)));
  }

  for (const t of input.trades) {
    if (input.processedTradeIds.has(t.id)) {
      // Cursor overlap: this trade already contributed allocations in a
      // previous run. Skip and just move the cursor.
      lastTs = t.closed_at;
      lastId = t.id;
      continue;
    }
    const pk = periodKeyFor(t.closed_at);
    const periodMap = covered.get(pk) ?? new Map<string, number>();
    const coveredObj: Record<string, number> = {};
    for (const [k, v] of periodMap) coveredObj[k] = v;

    const result = allocate({
      bills: input.bills,
      covered: coveredObj,
      delta_usd: Number(t.pnl_net),
    });

    for (const op of result.ops) {
      inserts.push({
        trade_id: t.id,
        bill_id: op.bill_id,
        amount_usd: op.delta_usd,
        period_key: pk,
      });
      periodMap.set(op.bill_id, (periodMap.get(op.bill_id) ?? 0) + op.delta_usd);
      if (op.delta_usd > 0) totalAllocated += op.delta_usd;
      else totalDrained += -op.delta_usd;
    }
    covered.set(pk, periodMap);

    lastTs = t.closed_at;
    lastId = t.id;
  }

  return {
    inserts,
    cursor: { last_trade_closed_at: lastTs, last_trade_id: lastId },
    totalAllocated,
    totalDrained,
  };
}
