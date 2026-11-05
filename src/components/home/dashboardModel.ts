/** Read-only projections. Missing marks/identities never become zero exposure. */
export function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function baseSymbol(pair: string): string {
  const normalized = pair.toUpperCase().replace(/[_/]/g, "-");
  return normalized.includes("-") ? normalized.split("-")[0] : normalized.replace(/(USDT|USDC|USD)$/i, "") || normalized;
}

export interface ExposurePosition {
  pair: string;
  side: string;
  size: number | null;
  mark: number | null;
  liquidation: number | null;
}

export function summarizeExposure(positions: ExposurePosition[]) {
  let gross = 0, net = 0, missing = 0;
  let liquidationDistance: number | null = null;
  const bySymbol = new Map<string, number>();
  for (const p of positions) {
    if (p.mark == null || p.mark <= 0 || p.size == null) { missing++; continue; }
    const notional = Math.abs(p.size * p.mark);
    gross += notional;
    net += p.side.toLowerCase() === "short" ? -notional : notional;
    const symbol = baseSymbol(p.pair);
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + notional);
    if (p.liquidation != null && p.liquidation > 0) {
      const distance = Math.abs(p.mark - p.liquidation) / p.mark * 100;
      liquidationDistance = liquidationDistance == null ? distance : Math.min(liquidationDistance, distance);
    }
  }
  const concentrations = [...bySymbol].sort((a, b) => b[1] - a[1]).map(([symbol, value]) => ({ symbol, value, share: gross > 0 ? value / gross * 100 : 0 }));
  return { gross, net, missing, liquidationDistance, concentrations };
}

export interface ClosedTrade { realized_pnl: number | null; closed_at: string; fees_usd: number | null; }
export function summarizeTrades(rows: ClosedTrade[]) {
  const valid = rows.filter(r => finite(r.realized_pnl) != null && Number.isFinite(Date.parse(r.closed_at))).sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));
  let total = 0, gains = 0, losses = 0, peak = 0, drawdown = 0;
  const curve = [{ time: valid.length ? Date.parse(valid[0].closed_at) - 1 : 0, value: 0 }];
  for (const r of valid) {
    const pnl = Number(r.realized_pnl);
    total += pnl;
    if (pnl > 0) gains += pnl; else losses += Math.abs(pnl);
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
    curve.push({ time: Date.parse(r.closed_at), value: total });
  }
  const wins = valid.filter(r => Number(r.realized_pnl) > 0).length;
  return { total, wins, closed: valid.length, winRate: valid.length ? wins / valid.length * 100 : null, profitFactor: losses > 0 ? gains / losses : null, drawdown, curve, missing: rows.length - valid.length };
}

/** Bills allocated or covered without payment evidence are not paid. */
export function paidBillSummary(bills: { amount_usd: number; paid_at: string | null; proof_url: string | null }[], month: string) {
  const paid = bills.filter(b => b.paid_at?.slice(0, 7) === month && !!b.proof_url);
  return { count: paid.length, amount: paid.reduce((sum, b) => sum + Number(b.amount_usd), 0) };
}

/** Only explicit supported symbols reach the desk; never silently open another market. */
export function tradeDeskSymbol(pair: string): string | null {
  const symbol = pair.trim().toUpperCase().replace(/[_/]/g, "-").replace(/^(BTC|ETH|SOL|XRP)(USDT)$/, "$1-$2");
  return ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"].includes(symbol) ? symbol : null;
}

/** Equality with entry is a valid reported mark, not evidence that a quote is missing. */
export function reportedMark(position: { mark_price: unknown; current_price: unknown }): number | null {
  const mark = finite(position.mark_price);
  const current = finite(position.current_price);
  return mark != null && mark > 0 ? mark : current != null && current > 0 ? current : null;
}
