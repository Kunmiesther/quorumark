import { describe, it, expect } from "vitest";
import { groupPaperTrades, exitReasonLabel, type RawPaperTrade } from "../tradeGrouping";

function mk(overrides: Partial<RawPaperTrade>): RawPaperTrade {
  return {
    id: overrides.id ?? "t1",
    position_id: overrides.position_id ?? null,
    wallet_key: overrides.wallet_key ?? "ADA-long",
    symbol: overrides.symbol ?? "ADA-USDT",
    direction: overrides.direction ?? "long",
    entry_price: overrides.entry_price ?? 0,
    exit_price: overrides.exit_price ?? 0,
    exit_reason: overrides.exit_reason ?? "stop",
    size_qty: overrides.size_qty ?? 0,
    size_notional: overrides.size_notional ?? 0,
    margin: overrides.margin ?? 0,
    pnl_gross: overrides.pnl_gross ?? 0,
    pnl_net: overrides.pnl_net ?? 0,
    fees: overrides.fees ?? 0,
    opened_at: overrides.opened_at ?? "2026-07-21T06:50:00Z",
    closed_at: overrides.closed_at ?? "2026-07-21T16:35:00Z",
  };
}

describe("groupPaperTrades", () => {
  it("groups four ADA rungs of a single ladder into one parent row", () => {
    const pid = "cdec00df-76cd-4a21-8ce1-1838252b937a";
    const rows: RawPaperTrade[] = [
      mk({ id: "r1", position_id: pid, entry_price: 0.1766, exit_price: 0.1729654, size_qty: 4246, size_notional: 750, margin: 15, pnl_gross: -15.44, fees: 0.37, pnl_net: -15.80 }),
      mk({ id: "r2", position_id: pid, entry_price: 0.175423, exit_price: 0.1729654, size_qty: 4275, size_notional: 750, margin: 15, pnl_gross: -10.51, fees: 0.37, pnl_net: -10.88 }),
      mk({ id: "r3", position_id: pid, entry_price: 0.174245, exit_price: 0.1729654, size_qty: 4304, size_notional: 750, margin: 15, pnl_gross: -5.51, fees: 0.37, pnl_net: -5.88 }),
      mk({ id: "r4", position_id: pid, entry_price: 0.173068, exit_price: 0.1729654, size_qty: 4333, size_notional: 750, margin: 15, pnl_gross: -0.44, fees: 0.37, pnl_net: -0.82 }),
    ];
    const groups = groupPaperTrades(rows);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.rung_count).toBe(4);
    expect(g.total_margin).toBe(60);
    expect(g.total_notional).toBe(3000);
    expect(g.exit_reason).toBe("stop");
    // Weighted entry = mean of the four (equal notionals)
    expect(g.weighted_entry).toBeCloseTo((0.1766 + 0.175423 + 0.174245 + 0.173068) / 4, 6);
    expect(g.total_net).toBeCloseTo(-33.38, 2);
    expect(g.total_gross).toBeCloseTo(-31.90, 2);
    expect(g.total_fees).toBeCloseTo(1.48, 2);
    // Long ladder: rungs sorted top→deepest (desc entry)
    expect(g.rungs.map((r) => r.entry_price)).toEqual([0.1766, 0.175423, 0.174245, 0.173068]);
  });

  it("keeps independent same-symbol positions as separate parent rows", () => {
    const rows: RawPaperTrade[] = [
      mk({ id: "a", position_id: "pos-A" }),
      mk({ id: "b", position_id: "pos-B" }),
    ];
    expect(groupPaperTrades(rows)).toHaveLength(2);
  });

  it("keeps orphan rows (null position_id) individually", () => {
    const rows: RawPaperTrade[] = [
      mk({ id: "legacy1", position_id: null }),
      mk({ id: "legacy2", position_id: null }),
    ];
    const g = groupPaperTrades(rows);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.rung_count === 1)).toBe(true);
  });

  it("sorts short-ladder rungs ascending (top→deepest above entry)", () => {
    const rows: RawPaperTrade[] = [
      mk({ id: "s1", position_id: "p", direction: "short", entry_price: 1.00, size_notional: 100 }),
      mk({ id: "s2", position_id: "p", direction: "short", entry_price: 1.02, size_notional: 100 }),
      mk({ id: "s3", position_id: "p", direction: "short", entry_price: 1.01, size_notional: 100 }),
    ];
    const g = groupPaperTrades(rows)[0];
    expect(g.rungs.map((r) => r.entry_price)).toEqual([1.00, 1.01, 1.02]);
  });
});

describe("exitReasonLabel", () => {
  it("maps known codes to precise labels — never a generic STOP fallback", () => {
    expect(exitReasonLabel("stop").label).toBe("HARD STOP");
    expect(exitReasonLabel("tp_touch").label).toBe("TAKE PROFIT");
    expect(exitReasonLabel("scout_bos").label).toBe("SCOUT INVALIDATION");
    expect(exitReasonLabel("onyx_cut").label).toBe("ONYX CUT");
    expect(exitReasonLabel("liquidation").label).toBe("LIQUIDATION GUARD");
    expect(exitReasonLabel("trailing_stop").label).toBe("TRAILING STOP");
  });
  it("surfaces unknown codes verbatim (uppercased) rather than lying", () => {
    expect(exitReasonLabel("weird_new_reason").label).toBe("WEIRD NEW REASON");
  });
});
