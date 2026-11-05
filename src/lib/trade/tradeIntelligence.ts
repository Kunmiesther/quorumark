/** Descriptive analytics over one book's recent, closed, P&L-bearing trades. */
export interface IntelligenceTrade {
  symbol: string;
  strategy: string | null;
  pnl: number;
  closedAt: string;
}

export interface SymbolPerformance {
  symbol: string;
  count: number;
  wins: number;
  netPnl: number;
  winRate: number;
  profitFactor: number | null;
}

export interface TradeIntelligence {
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  netPnl: number;
  winRate: number | null;
  profitFactor: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  expectancy: number | null;
  largestLoss: number | null;
  maxClosedTradeDrawdown: number;
  longestLossStreak: number;
  bySymbol: SymbolPerformance[];
  byStrategy: SymbolPerformance[];
}

function groupPerformance(
  rows: IntelligenceTrade[],
  keyOf: (row: IntelligenceTrade) => string,
): SymbolPerformance[] {
  const groups = new Map<string, { count: number; wins: number; netPnl: number; grossWin: number; grossLoss: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = groups.get(key) ?? { count: 0, wins: 0, netPnl: 0, grossWin: 0, grossLoss: 0 };
    current.count++;
    current.wins += row.pnl > 0 ? 1 : 0;
    current.netPnl += row.pnl;
    current.grossWin += Math.max(0, row.pnl);
    current.grossLoss += Math.max(0, -row.pnl);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([symbol, value]) => ({
      symbol,
      count: value.count,
      wins: value.wins,
      netPnl: value.netPnl,
      winRate: value.wins / value.count,
      profitFactor: value.grossLoss > 0 ? value.grossWin / value.grossLoss : null,
    }))
    .sort((a, b) => b.netPnl - a.netPnl || b.count - a.count);
}

export function analyzeClosedTrades(rows: IntelligenceTrade[]): TradeIntelligence {
  const valid = rows.filter(
    (row) => Number.isFinite(row.pnl) && Boolean(row.symbol) && Number.isFinite(Date.parse(row.closedAt)),
  );
  const chronological = [...valid].sort(
    (a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt),
  );
  const wins = valid.filter((row) => row.pnl > 0);
  const losses = valid.filter((row) => row.pnl < 0);
  const grossWin = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = -losses.reduce((sum, row) => sum + row.pnl, 0);
  const netPnl = grossWin - grossLoss;
  let running = 0;
  let peak = 0;
  let drawdown = 0;
  let lossStreak = 0;
  let longestLossStreak = 0;
  for (const row of chronological) {
    running += row.pnl;
    peak = Math.max(peak, running);
    drawdown = Math.max(drawdown, peak - running);
    lossStreak = row.pnl < 0 ? lossStreak + 1 : 0;
    longestLossStreak = Math.max(longestLossStreak, lossStreak);
  }

  return {
    count: valid.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: valid.length - wins.length - losses.length,
    netPnl,
    winRate: valid.length ? wins.length / valid.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? -grossLoss / losses.length : null,
    expectancy: valid.length ? netPnl / valid.length : null,
    largestLoss: losses.length ? Math.min(...losses.map((row) => row.pnl)) : null,
    maxClosedTradeDrawdown: drawdown,
    longestLossStreak,
    bySymbol: groupPerformance(valid, (row) => row.symbol.toUpperCase()),
    byStrategy: groupPerformance(valid, (row) => row.strategy?.trim() || "Unattributed"),
  };
}
