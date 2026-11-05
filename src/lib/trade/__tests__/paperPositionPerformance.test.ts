import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPaperPositionPerformance,
  paperPositionPerformance,
  type PaperPerformancePosition,
} from "../paperPositionPerformance";
import { analyzeClosedTrades } from "../tradeIntelligence";

describe("whole-position paper performance", () => {
  const position: PaperPerformancePosition = {
    id: "p1",
    symbol: "SOL-USDT",
    strategy: "accumulator",
    status: "closed",
    paper_trades: [
      { pnl_net: 4.22, closed_at: "2026-09-16T18:15:00Z" },
      { pnl_net: -72.38, closed_at: "2026-09-19T17:00:00Z" },
      { pnl_net: -69.76, closed_at: "2026-09-19T17:00:00Z" },
      { pnl_net: -67.17, closed_at: "2026-09-19T17:00:00Z" },
      { pnl_net: -64.61, closed_at: "2026-09-19T17:00:00Z" },
    ],
  };
  it("counts a five-exit campaign once with all its net results", () => {
    const rows = paperPositionPerformance([position]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl).toBeCloseTo(-269.7);
    expect(rows[0].closedAt).toBe("2026-09-19T17:00:00Z");
    expect(analyzeClosedTrades(rows).losses).toBe(1);
  });
  it("does not call a profitable partial exit a completed winning trade", () => {
    expect(
      paperPositionPerformance([
        { ...position, status: "open", paper_trades: position.paper_trades.slice(0, 1) },
      ]),
    ).toEqual([]);
  });
  it("does not turn absent accounting into zero or a partial total", () => {
    expect(
      paperPositionPerformance([
        { ...position, paper_trades: [{ pnl_net: null, closed_at: "2026-09-19T17:00:00Z" }] },
      ]),
    ).toEqual([]);
  });
  it("does not merge different positions on the same symbol", () => {
    expect(paperPositionPerformance([position, { ...position, id: "p2" }])).toHaveLength(2);
  });
  it("uses recorded detector identity instead of the execution wallet's DCA label", () => {
    expect(
      paperPositionPerformance([
        { ...position, strategy: "dca", strategy_metadata: { detector_strategy: "vanguard" } },
      ])[0].strategy,
    ).toBe("vanguard");
  });
  it("paginates all exits without relying on a nonexistent production FK", async () => {
    const results = [
      { data: [{ ...position, paper_trades: undefined }], error: null },
      {
        data: Array.from({ length: 1000 }, () => ({
          position_id: "p1",
          pnl_net: 1,
          closed_at: "2026-09-19T17:00:00Z",
        })),
        error: null,
      },
      {
        data: [{ position_id: "p1", pnl_net: -1500, closed_at: "2026-09-20T17:00:00Z" }],
        error: null,
      },
    ];
    const range = vi.fn();
    const selections: string[] = [];
    const client = {
      from: vi.fn(() => {
        const result = results.shift();
        const q = {
          select: (value: string) => {
            selections.push(value);
            return q;
          },
          eq: () => q,
          in: () => q,
          order: () => q,
          limit: () => q,
          range: (...args: number[]) => {
            range(...args);
            return q;
          },
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
        return q;
      }),
    } as unknown as SupabaseClient;
    expect((await loadPaperPositionPerformance(client, "owner"))[0].pnl).toBe(-500);
    expect(range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(selections.every((s) => !s.includes("paper_trades("))).toBe(true);
  });
});
