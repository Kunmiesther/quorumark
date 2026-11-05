/** Trade-page responsibility guard: one live line chart supports execution. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DESK = fs.readFileSync(path.resolve(__dirname, "../TradeDesk.tsx"), "utf8");

describe("TradeDesk chart", () => {
  it("renders one symbol-linked desktop market chart", () => {
    expect(DESK.match(/<BotLineChart/g)).toHaveLength(1);
    expect(DESK).toMatch(/data-testid="desktop-market-chart"/);
    expect(DESK).toMatch(/useCandles\(symbol, chartInterval/);
    expect(DESK).not.toMatch(/<CandlestickChart/);
    expect(DESK).not.toMatch(/<VolumeChart/);
  });

  it("puts execution and position controls first", () => {
    expect(DESK).toMatch(/data-testid="trade-control-panel"/);
    expect(DESK).toMatch(/data-testid="position-control-panel"/);
    expect(DESK).toMatch(/<OrderPanel/);
    expect(DESK).toMatch(/<OpenPositionsCard/);
  });

  it("shares symbol selection between chart, ticket and position shortcuts", () => {
    expect(DESK).toContain("useTradeDeskSymbol(initialSymbol, candidateId)");
    expect(DESK).toMatch(/<DesktopMarketChart[\s\S]*?onSymbol=\{setSymbol\}/);
    expect(DESK).toMatch(/<OrderPanel[\s\S]*?onSymbol=\{setSymbol\}/);
    expect(DESK).toContain("onSelectSymbol={setSymbol}");
    expect(DESK).toMatch(/<BotLineChart\s+key=\{symbol\}/);
  });
});
