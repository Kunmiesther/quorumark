import { describe, expect, it } from "vitest";
import { baseSymbol, reportedMark, tradeDeskSymbol, paidBillSummary, summarizeExposure, summarizeTrades } from "./dashboardModel";

describe("live dashboard evidence", () => {
  it("normalizes supported desk markets without substituting unsupported instruments", () => {
    expect(tradeDeskSymbol("BTCUSDT")).toBe("BTC-USDT");
    expect(tradeDeskSymbol("ETH/USDT")).toBe("ETH-USDT");
    expect(tradeDeskSymbol("DOGE-USDT")).toBeNull();
    expect(tradeDeskSymbol("BTC/USD")).toBeNull();
  });
  it("retains a reported unchanged mark and rejects absent or invalid prices", () => {
    expect(reportedMark({ mark_price: 100, current_price: 100 })).toBe(100);
    expect(reportedMark({ mark_price: null, current_price: null })).toBeNull();
    expect(reportedMark({ mark_price: 0, current_price: 101 })).toBe(101);
  });
  it("preserves standalone stablecoin identities", () => {
    expect(baseSymbol("USDC")).toBe("USDC");
    expect(baseSymbol("USDT")).toBe("USDT");
    expect(baseSymbol("BTCUSDT")).toBe("BTC");
  });
  it("separates gross and signed exposure and excludes missing marks", () => {
    const result = summarizeExposure([
      { pair: "BTC-USDT", side: "long", size: 2, mark: 100, liquidation: 80 },
      { pair: "ETH/USDT", side: "short", size: 3, mark: 50, liquidation: 60 },
      { pair: "SOL-USDT", side: "long", size: 10, mark: null, liquidation: null },
    ]);
    expect(result.gross).toBe(350);
    expect(result.net).toBe(50);
    expect(result.missing).toBe(1);
    expect(result.liquidationDistance).toBe(20);
    expect(result.concentrations[0].symbol).toBe("BTC");
  });
  it("sorts closures and computes realized drawdown without treating missing P&L as a trade", () => {
    const result = summarizeTrades([
      { closed_at: "2026-10-03", realized_pnl: -30, fees_usd: 0 },
      { closed_at: "2026-10-01", realized_pnl: 100, fees_usd: 0 },
      { closed_at: "2026-10-02", realized_pnl: null, fees_usd: null },
    ]);
    expect(result.total).toBe(70);
    expect(result.drawdown).toBe(30);
    expect(result.closed).toBe(2);
    expect(result.winRate).toBe(50);
    expect(result.missing).toBe(1);
    expect(result.curve.map(p => p.value)).toEqual([0, 100, 70]);
  });
  it("counts only this month's payments with proof", () => {
    expect(paidBillSummary([
      { amount_usd: 100, paid_at: "2026-10-01", proof_url: "proof" },
      { amount_usd: 200, paid_at: "2026-10-02", proof_url: null },
      { amount_usd: 50, paid_at: "2026-09-01", proof_url: "proof" },
      { amount_usd: 300, paid_at: null, proof_url: null },
    ], "2026-10")).toEqual({ count: 1, amount: 100 });
  });
});
