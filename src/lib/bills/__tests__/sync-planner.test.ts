import { describe, it, expect } from "vitest";
import { planSyncBatch, type PlannerTrade } from "../sync-planner";
import type { BillForAlloc } from "../allocate";

const bills: BillForAlloc[] = [
  { id: "rent", amount_usd: 1500, priority: 1, created_at: "2026-01-01T00:00:00Z" },
  { id: "phone", amount_usd: 100, priority: 5, created_at: "2026-01-01T00:00:00Z" },
];

const trades: PlannerTrade[] = [
  { id: "t1", closed_at: "2026-07-01T12:00:00Z", pnl_net: 900 },
  { id: "t2", closed_at: "2026-07-02T12:00:00Z", pnl_net: 700 },
  { id: "t3", closed_at: "2026-07-03T12:00:00Z", pnl_net: -50 },
];

describe("planSyncBatch — sync idempotency", () => {
  it("first pass produces allocations; second pass over same trades produces zero inserts", () => {
    const first = planSyncBatch({
      bills,
      trades,
      coveredByPeriod: {},
      processedTradeIds: new Set(),
    });
    expect(first.inserts.length).toBeGreaterThan(0);
    expect(first.cursor.last_trade_id).toBe("t3");

    // Simulate persistence: build the covered totals AND the processed-trade
    // set from the first pass, then re-run with the same trades.
    const covered: Record<string, Record<string, number>> = {};
    const processed = new Set<string>();
    for (const ins of first.inserts) {
      covered[ins.period_key] ??= {};
      covered[ins.period_key][ins.bill_id] =
        (covered[ins.period_key][ins.bill_id] ?? 0) + ins.amount_usd;
      processed.add(ins.trade_id);
    }

    const second = planSyncBatch({
      bills,
      trades,
      coveredByPeriod: covered,
      processedTradeIds: processed,
    });
    expect(second.inserts).toEqual([]);
    expect(second.totalAllocated).toBe(0);
    expect(second.totalDrained).toBe(0);
  });

  it("advances cursor to the newest trade even if a trade produced no ops", () => {
    const r = planSyncBatch({
      bills: [],
      trades,
      coveredByPeriod: {},
      processedTradeIds: new Set(),
    });
    expect(r.inserts).toEqual([]);
    expect(r.cursor.last_trade_id).toBe("t3");
    expect(r.cursor.last_trade_closed_at).toBe("2026-07-03T12:00:00Z");
  });
});
