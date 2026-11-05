export type ScoredPaperTrade = {
  pnl_net: number;
  exit_reason: string;
  closed_at: string;
};

export type CompetitionScore = {
  endingBalance: number;
  returnPct: number;
  maxDrawdownPct: number;
  liquidationCount: number;
  closedTradeCount: number;
  integrityPenalty: number;
  score: number;
};

/** Deterministic public formula from the published competition rules. */
export function scoreCompetitionTrades(
  startingBalance: number,
  trades: readonly ScoredPaperTrade[],
  integrityPenalty = 0,
): CompetitionScore {
  if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
    throw new Error("Starting balance must be positive.");
  }

  const ordered = [...trades].sort(
    (a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime(),
  );
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdownPct = 0;
  let liquidationCount = 0;

  for (const trade of ordered) {
    const pnl = Number(trade.pnl_net);
    if (!Number.isFinite(pnl)) continue;
    equity += pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    if (/liquid/i.test(trade.exit_reason)) liquidationCount += 1;
  }

  const returnPct = ((equity - startingBalance) / startingBalance) * 100;
  const penalty = Math.max(0, Number.isFinite(integrityPenalty) ? integrityPenalty : 0);
  const score = returnPct - 1.5 * maxDrawdownPct - 25 * liquidationCount - penalty;

  return {
    endingBalance: equity,
    returnPct,
    maxDrawdownPct,
    liquidationCount,
    closedTradeCount: ordered.length,
    integrityPenalty: penalty,
    score,
  };
}
