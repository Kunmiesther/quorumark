import { describe, expect, it } from "vitest";
import {
  buildDcaContext,
  DCA_CANONICAL_SYMBOLS,
  DCA_CONTRACT,
  noPositionContext,
  type PaperPositionRow,
} from "../dcaContext";

function baseRow(over: Partial<PaperPositionRow> = {}): PaperPositionRow {
  return {
    symbol: "BTC-USDT",
    direction: "long",
    status: "open",
    leverage: 100,
    margin: 60,
    entry_price: 100,
    strategy: "accumulator",
    rung_count: 4,
    ladder_total_margin: 60,
    ladder_total_rungs: 8,
    fills: [
      { price: 100, margin: 7.5 },
      { price: 99, margin: 7.5 },
      { price: 98.5, margin: 7.5 },
      { price: 98, margin: 7.5 },
    ],
    pending_rungs: [
      { level: 97.5, margin: 7.5 },
      { level: 97, margin: 7.5 },
      { level: 96.5, margin: 7.5 },
      { level: 96, margin: 7.5 },
    ],
    resize_levels: [],
    stop_level: null,
    tp_level: null,
    ...over,
  };
}

describe("dcaContext canonical allowlist", () => {
  it("canonical only BTC + ETH", () => {
    expect([...DCA_CANONICAL_SYMBOLS]).toEqual(["BTC-USDT", "ETH-USDT"]);
  });
  it("non-canonical symbol → NOT_CANONICAL_SYMBOL, never mutates", () => {
    const ctx = buildDcaContext("SOL-USDT", baseRow({ symbol: "SOL-USDT" }));
    expect(ctx.status).toBe("NOT_CANONICAL_SYMBOL");
  });
  it("LINK-USDT also excluded", () => {
    const ctx = buildDcaContext("LINK-USDT", baseRow({ symbol: "LINK-USDT" }));
    expect(ctx.status).toBe("NOT_CANONICAL_SYMBOL");
  });
});

describe("dcaContext contract validation", () => {
  it("no position → NO_POSITION with full planned margin", () => {
    const ctx = noPositionContext("BTC-USDT");
    expect(ctx.status).toBe("NO_POSITION");
    expect(ctx.remaining_planned_margin_usd).toBe(DCA_CONTRACT.planned_margin_usd);
  });

  it("valid 4/8 → ACTIVE, stop not armed, next rung has distance", () => {
    const ctx = buildDcaContext("BTC-USDT", baseRow(), 98);
    expect(ctx.status).toBe("ACTIVE");
    expect(ctx.filled_rungs).toBe(4);
    expect(ctx.pending_rungs).toBe(4);
    expect(ctx.final_stop_armed).toBe(false);
    expect(ctx.next_rung?.level).toBe(97.5);
    expect(ctx.remaining_planned_margin_usd).toBeCloseTo(30, 3);
  });

  it("8/8 filled → hard stop armed 1% beyond last fill", () => {
    const fills = new Array(8).fill(0).map((_, i) => ({ price: 100 - i * 0.15, margin: 7.5 }));
    const ctx = buildDcaContext("BTC-USDT", baseRow({
      fills,
      pending_rungs: [],
      stop_level: fills[7].price * (1 - 0.01),
    }), fills[7].price);
    expect(ctx.final_stop_armed).toBe(true);
    expect(ctx.final_stop_level).toBeCloseTo(fills[7].price * 0.99, 5);
    expect(ctx.mismatched_fields).not.toContain("stop_level");
  });

  it("leverage mismatch → CONTRACT_MISMATCH", () => {
    const ctx = buildDcaContext("BTC-USDT", baseRow({ leverage: 50 }));
    expect(ctx.status).toBe("CONTRACT_MISMATCH");
    expect(ctx.mismatched_fields).toContain("leverage");
  });

  it("per-rung TP is 1% from each fill price (long)", () => {
    const ctx = buildDcaContext("BTC-USDT", baseRow(), 100);
    const tp0 = ctx.per_rung_tps[0];
    expect(tp0.filled).toBe(true);
    expect(tp0.tp_level).toBeCloseTo(100 * 1.01, 5);
  });
});
