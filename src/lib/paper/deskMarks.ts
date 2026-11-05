export type PaperQuote = { symbol: string; price: number; fetchedAt: number };
export const compactSymbol = (symbol: string) => symbol.replace(/[-_/]/g, "").toUpperCase();

/** Independent public reference prices; no wallet credentials or order API. */
export async function fetchPaperQuote(symbol: string): Promise<PaperQuote> {
  const raw = compactSymbol(symbol);
  const response = await fetch(`https://omni.apex.exchange/api/v3/ticker?symbol=${encodeURIComponent(raw)}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Paper reference price is unavailable. Retry shortly.");
  const body = await response.json();
  const row = Array.isArray(body?.data)
    ? body.data.find((item: { symbol?: string }) => compactSymbol(item.symbol ?? "") === raw)
    : null;
  const price = Number(row?.markPrice ?? row?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("No verified price for this symbol.");
  return { symbol: raw, price, fetchedAt: Date.now() };
}

export function paperValuation(
  position: { pair: string; side: "long" | "short"; entry: number | null; size: number | null; estimatedMargin?: number | null },
  quote: PaperQuote | null | undefined,
  now = Date.now(),
) {
  const unavailable = { mark: null, pnl: null, pnlPct: null };
  if (!quote || quote.symbol !== compactSymbol(position.pair) || !Number.isFinite(quote.price)
    || quote.price <= 0 || !Number.isFinite(quote.fetchedAt) || quote.fetchedAt > now + 5_000
    || now - quote.fetchedAt > 30_000) return unavailable;
  const { entry, size, estimatedMargin } = position;
  if (entry == null || entry <= 0 || !Number.isFinite(entry) || size == null || size <= 0 || !Number.isFinite(size))
    return { ...unavailable, mark: quote.price };
  const pnl = (quote.price - entry) * size * (position.side === "long" ? 1 : -1);
  return { mark: quote.price, pnl, pnlPct: estimatedMargin != null && estimatedMargin > 0 ? pnl / estimatedMargin * 100 : null };
}
