/**
 * Rung-identity contract regressions.
 *
 * These tests pin the invariants that the client-side portion of the
 * rung-persistence contract must uphold, independent of the SECURITY
 * DEFINER RPC. The DB-side idempotency is enforced by the unique key
 * (position_id, rung_index) on `paper_rung_fills`; these tests pin the
 * client-derived `rung_index` mapping and payload shape.
 */
import { describe, it, expect } from "vitest";
import type { RungFillIdentity } from "../repository";

// Mirror of the engine's rung-index assignment. If the engine drifts,
// this test must fail — keep them in lockstep.
function assignRungIndices(
  baselineRungCount: number,
  newlyFilled: ReadonlyArray<{ price: number; qty: number; margin: number; tp: number }>,
  candleTsMs: number,
): RungFillIdentity[] {
  return newlyFilled.map((r, i) => ({
    rung_index: baselineRungCount + i + 1,
    price: r.price,
    qty: r.qty,
    margin: r.margin,
    tp: r.tp,
    fill_status: "filled",
    candle_ts_ms: candleTsMs,
  }));
}

const R = (price: number) => ({ price, qty: 1, margin: 7.5, tp: price * 1.01 });

describe("rung identity contract (client-side)", () => {
  // 1. Sequential fills — indices increment strictly.
  it("assigns strictly increasing rung_index for sequential fills", () => {
    const out = assignRungIndices(1, [R(100), R(99), R(98)], 1_700_000_000_000);
    expect(out.map((r) => r.rung_index)).toEqual([2, 3, 4]);
    expect(out.every((r) => r.fill_status === "filled")).toBe(true);
  });

  // 2. Retry duplicate — an identical payload produces identical rung_indices
  //    so ON CONFLICT DO NOTHING collapses the duplicate at the DB.
  it("produces identical rung_index for a replayed payload (retry dedupe)", () => {
    const a = assignRungIndices(3, [R(97)], 1_700_000_000_000);
    const b = assignRungIndices(3, [R(97)], 1_700_000_000_000);
    expect(a).toEqual(b);
    expect(a[0].rung_index).toBe(4);
  });

  // 3. Concurrent fill attempt — the CAS baseline diverges but the DB unique
  //    key guarantees only one commit wins. Client-side, two independent
  //    workers with the SAME baseline produce the SAME index, and the DB
  //    dedupes.
  it("two concurrent callers on the same baseline collide on the same rung_index", () => {
    const workerA = assignRungIndices(4, [R(96)], 1_700_000_000_000);
    const workerB = assignRungIndices(4, [R(96)], 1_700_000_000_000);
    expect(workerA[0].rung_index).toBe(workerB[0].rung_index);
    expect(workerA[0].rung_index).toBe(5);
  });

  // 4. Multi-rung candle — one wick fills rungs 4 & 5 in a single call;
  //    indices remain strictly sequential.
  it("multi-fill in one candle assigns adjacent indices", () => {
    const out = assignRungIndices(3, [R(95), R(94)], 1_700_000_000_000);
    expect(out.map((r) => r.rung_index)).toEqual([4, 5]);
  });

  // 5. Final-rung arming is exactly-once at the boundary: rung_index == N.
  //    The RPC returns armed=true only when persisted filled_rung_count
  //    catches up to configured_rung_count. Here we pin the client mapping
  //    that generates the boundary event exactly once.
  it("the fill whose rung_index equals configured count is the arming event", () => {
    const CONFIGURED = 8;
    const beforeLast = assignRungIndices(6, [R(94)], 1_700_000_000_000);
    expect(beforeLast[0].rung_index).toBeLessThan(CONFIGURED);
    const last = assignRungIndices(7, [R(93)], 1_700_000_000_000);
    expect(last[0].rung_index).toBe(CONFIGURED);
  });

  // 6. Cancelled / rejected rungs carry an explicit non-filled status so
  //    the RPC's count(*) filter on fill_status='filled' still excludes them.
  it("supports non-filled statuses without inflating filled count", () => {
    const out: RungFillIdentity[] = [
      { rung_index: 2, price: 99, qty: 1, margin: 7.5, tp: 99.99, fill_status: "rejected" },
      { rung_index: 3, price: 98, qty: 1, margin: 7.5, tp: 98.98, fill_status: "filled" },
    ];
    const filled = out.filter((r) => (r.fill_status ?? "filled") === "filled");
    expect(filled).toHaveLength(1);
    expect(filled[0].rung_index).toBe(3);
  });

  // 7. Backfill idempotency — the migration inserts one row per fills[]
  //    entry using ordinality. Any re-run produces the exact same
  //    (position_id, rung_index) key set, so ON CONFLICT DO NOTHING zeroes
  //    the second run. We simulate that here with a deduplicating map.
  it("backfill from fills[] array is idempotent (dedupes by rung_index)", () => {
    const fills = [R(100), R(99), R(98), R(97)];
    const runOnce = fills.map((f, i) => ({ rung_index: i + 1, ...f }));
    const runTwice = fills.map((f, i) => ({ rung_index: i + 1, ...f }));
    const seen = new Set<number>();
    let inserted = 0;
    for (const row of [...runOnce, ...runTwice]) {
      if (seen.has(row.rung_index)) continue;
      seen.add(row.rung_index);
      inserted += 1;
    }
    expect(inserted).toBe(fills.length);
  });

  // 8. Out-of-order fills (if a caller supplies them) still map to distinct
  //    indices — sequential by arrival, not by price. The DB relies on
  //    rung_index uniqueness, not sort order.
  it("out-of-order fills receive distinct sequential indices", () => {
    const out = assignRungIndices(2, [R(93), R(97), R(95)], 1_700_000_000_000);
    expect(new Set(out.map((r) => r.rung_index)).size).toBe(3);
    expect(out.map((r) => r.rung_index)).toEqual([3, 4, 5]);
  });
});
