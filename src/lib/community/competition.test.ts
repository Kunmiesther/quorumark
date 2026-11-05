import { describe, expect, it } from "vitest";
import { scoreCompetitionTrades } from "./competition";

describe("scoreCompetitionTrades", () => {
  it("scores return, drawdown, liquidations, and integrity penalties deterministically", () => {
    const result = scoreCompetitionTrades(
      2_000,
      [
        { pnl_net: 200, exit_reason: "tp_touch", closed_at: "2026-01-02T00:00:00Z" },
        { pnl_net: -440, exit_reason: "liquidation", closed_at: "2026-01-03T00:00:00Z" },
        { pnl_net: 240, exit_reason: "tp_touch", closed_at: "2026-01-04T00:00:00Z" },
      ],
      3,
    );

    expect(result.endingBalance).toBe(2_000);
    expect(result.returnPct).toBe(0);
    expect(result.maxDrawdownPct).toBeCloseTo(20);
    expect(result.liquidationCount).toBe(1);
    expect(result.closedTradeCount).toBe(3);
    expect(result.score).toBeCloseTo(-58);
  });

  it("sorts trades by close time before calculating drawdown", () => {
    const result = scoreCompetitionTrades(2_000, [
      { pnl_net: -100, exit_reason: "stop", closed_at: "2026-01-03T00:00:00Z" },
      { pnl_net: 200, exit_reason: "tp_touch", closed_at: "2026-01-02T00:00:00Z" },
    ]);
    expect(result.maxDrawdownPct).toBeCloseTo((100 / 2200) * 100);
  });
});
