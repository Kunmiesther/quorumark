import { fetchApexKlines } from "@/lib/paper/feed";
import type { Candle } from "@/lib/paper/signal";

/** Public market evidence only. Never falls back to another exchange. */
export async function publicCouncilCandles(
  exchange: string,
  symbol: string,
  intervalMin: 5 | 60 | 240 = 5,
  limit = 80,
): Promise<Candle[]> {
  if (![5, 60, 240].includes(intervalMin) || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Unsupported Council candle window.");
  if (["ApeX Omni", "apex_omni"].includes(exchange)) {
    return (await fetchApexKlines(symbol, intervalMin, limit)).candles;
  }
  if (!["Aster", "aster"].includes(exchange)) {
    throw new Error(`Council market feed for ${exchange || "unknown venue"} is not connected yet.`);
  }
  // Official public V3 API: asterdex/api-docs, Futures API, Kline data.
  const raw = symbol.replace(/[-/]/g, "");
  const interval = { 5: "5m", 60: "1h", 240: "4h" }[intervalMin];
  const frameMs = intervalMin * 60_000;
  const url = `https://fapi.asterdex.com/fapi/v3/klines?symbol=${encodeURIComponent(raw)}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Aster candles returned HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Aster returned an invalid candle response.");
  const now = Date.now();
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const values = row.slice(0, 6).map(Number);
    if (!values.every(Number.isFinite) || values[0] % frameMs !== 0 || values[0] + frameMs > now)
      continue;
    if (values.slice(1, 5).some((price) => price <= 0) || values[5] < 0) continue;
    if (
      values[2] < Math.max(values[1], values[3], values[4]) ||
      values[3] > Math.min(values[1], values[2], values[4])
    )
      continue;
    candles.push(values as Candle);
  }
  candles.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i][0] - candles[i - 1][0] !== frameMs)
      throw new Error("Aster candle history has gaps or duplicates.");
  }
  return candles;
}
