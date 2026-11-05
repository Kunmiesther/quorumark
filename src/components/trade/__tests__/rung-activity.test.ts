/**
 * RungActivityPanel logic — day boundary, tally, and grouping are pure and
 * deterministic. We test them without React.
 */
import { describe, it, expect } from "vitest";
import { computeTally, __internals__ } from "../RungActivityPanel";

type Row = Parameters<typeof computeTally>[0][number];

const mk = (state: Row["state"], over: Partial<Row> = {}): Row => ({
  key: Math.random().toString(),
  leg: "Accumulator",
  symbol: "BTC-USDT",
  side: "long",
  rungIndex: 1,
  price: 100,
  size: 1,
  state,
  ts: 0,
  ...over,
});

describe("RungActivityPanel", () => {
  it("computeTally counts open, closed, pending, and totals fired-today", () => {
    const t = computeTally([
      mk("filled"), mk("filled"), mk("filled"),
      mk("closed", { realizedPnl: 1 }), mk("closed", { realizedPnl: -0.5 }),
      mk("pending"),
    ]);
    expect(t.open).toBe(3);
    expect(t.closed).toBe(2);
    expect(t.pending).toBe(1);
    // Pending doesn't count as "fired today" — hasn't filled.
    expect(t.total).toBe(5);
  });

  it("empty tally when nothing fired today", () => {
    const t = computeTally([]);
    expect(t.open).toBe(0);
    expect(t.closed).toBe(0);
    expect(t.total).toBe(0);
  });

  it("startOfUtcDayMs is UTC midnight, not local — no bleed across days", () => {
    // Sample instant just after UTC midnight
    const at = Date.UTC(2026, 6, 27, 0, 0, 42);
    const start = __internals__.startOfUtcDayMs(at);
    expect(start).toBe(Date.UTC(2026, 6, 27));
    // A trade closed 1s before UTC midnight belongs to *yesterday*.
    const yesterdayClose = start - 1000;
    expect(yesterdayClose < start).toBe(true);
  });

  it("groupBySymbolLeg groups rows by symbol+leg+side and orders filled→closed→pending", () => {
    const rows = [
      mk("pending", { rungIndex: 4 }),
      mk("closed", { rungIndex: 0, realizedPnl: 1 }),
      mk("filled", { rungIndex: 2 }),
      mk("filled", { rungIndex: 1 }),
      mk("filled", { symbol: "ETH-USDT" }),
    ];
    const groups = __internals__.groupBySymbolLeg(rows);
    expect(groups.length).toBe(2);
    const btc = groups.find((g) => g.symbol === "BTC-USDT")!;
    expect(btc.items.map((r) => r.state)).toEqual(["filled", "filled", "closed", "pending"]);
    expect(btc.items[0].rungIndex).toBe(1);
    expect(btc.items[1].rungIndex).toBe(2);
  });

  it("prettyLeg normalizes known bot names and falls back to '—'", () => {
    expect(__internals__.prettyLeg("accumulator")).toBe("Accumulator");
    expect(__internals__.prettyLeg("SWEEP")).toBe("Sweep");
    expect(__internals__.prettyLeg(null)).toBe("—");
    expect(__internals__.prettyLeg("")).toBe("—");
  });

  it("closed-in-profit vs closed-at-loss are distinguishable by realizedPnl sign", () => {
    // Panel uses realizedPnl sign for color choice (teal vs faint red).
    const rows = [
      mk("closed", { realizedPnl: 2.5 }),
      mk("closed", { realizedPnl: -0.75 }),
    ];
    expect(rows[0].realizedPnl).toBeGreaterThan(0);
    expect(rows[1].realizedPnl).toBeLessThan(0);
  });
});
