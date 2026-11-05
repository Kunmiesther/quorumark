import { describe, expect, it } from "vitest";
import { analyzeClosedTrades } from "./tradeIntelligence";

const trade = (symbol: string, pnl: number, day: number) => ({
  symbol,
  strategy: symbol.startsWith("BTC") ? "Accumulator" : "Scout",
  pnl,
  closedAt: `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`,
});

describe("closed-trade intelligence", () => {
  it("does not invent performance from an empty sample", () => {
    const result = analyzeClosedTrades([]);
    expect(result.count).toBe(0);
    expect(result.winRate).toBeNull();
    expect(result.profitFactor).toBeNull();
    expect(result.bySymbol).toEqual([]);
    expect(result.byStrategy).toEqual([]);
  });

  it("computes realized performance, symbol ranking and closed-trade drawdown", () => {
    const result = analyzeClosedTrades([
      trade("ETH-USDT", -20, 3),
      trade("BTC-USDT", 30, 1),
      trade("ETH-USDT", -10, 2),
      trade("BTC-USDT", 0, 4),
    ]);
    expect(result).toMatchObject({
      count: 4,
      wins: 1,
      losses: 2,
      breakeven: 1,
      netPnl: 0,
      winRate: 0.25,
      profitFactor: 1,
      averageWin: 30,
      averageLoss: -15,
      expectancy: 0,
      maxClosedTradeDrawdown: 30,
      longestLossStreak: 2,
    });
    expect(result.bySymbol.map((row) => row.symbol)).toEqual(["BTC-USDT", "ETH-USDT"]);
    expect(result.byStrategy).toMatchObject([
      { symbol: "Accumulator", count: 2, netPnl: 30 },
      { symbol: "Scout", count: 2, netPnl: -30 },
    ]);
  });

  it("excludes unpriced trades instead of counting unknown P&L as breakeven", () => {
    const result = analyzeClosedTrades([
      trade("BTC-USDT", Number.NaN, 1),
      trade("SOL-USDT", 5, 2),
    ]);
    expect(result.count).toBe(1);
    expect(result.profitFactor).toBeNull();
  });

  it("keeps missing strategy attribution visible instead of guessing", () => {
    const result = analyzeClosedTrades([{ ...trade("BTC-USDT", 5, 1), strategy: null }]);
    expect(result.byStrategy[0].symbol).toBe("Unattributed");
  });
});
