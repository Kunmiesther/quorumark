export type PaperTradeEvidence = {
  realized_pnl: number | string;
  evidence_verified?: boolean;
};

export function evaluatePaperEvidence(
  trades: PaperTradeEvidence[],
  authorizedCapital: number,
  riskViolations: number,
) {
  const verifiedTrades = trades.filter((trade) => trade.evidence_verified !== false);
  let equity = authorizedCapital;
  let peak = equity;
  let maxDrawdownPct = 0;
  let netPnl = 0;
  for (const trade of verifiedTrades) {
    const pnl = Number(trade.realized_pnl);
    netPnl += pnl;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 100);
  }
  const checks = [
    {
      key: "sample_size",
      label: "Closed paper trades",
      actual: verifiedTrades.length,
      required: 30,
      passed: verifiedTrades.length >= 30,
    },
    {
      key: "net_pnl",
      label: "Net paper P&L",
      actual: Number(netPnl.toFixed(2)),
      required: "> 0",
      passed: netPnl > 0,
    },
    {
      key: "max_drawdown",
      label: "Maximum drawdown",
      actual: Number(maxDrawdownPct.toFixed(2)),
      required: "<= 10%",
      passed: maxDrawdownPct <= 10,
    },
    {
      key: "risk_violations",
      label: "Risk violations",
      actual: riskViolations,
      required: 0,
      passed: riskViolations === 0,
    },
  ];
  return { qualified: checks.every((check) => check.passed), checks };
}
