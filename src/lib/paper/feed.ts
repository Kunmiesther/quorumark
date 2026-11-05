/**
 * ApeX Omni public candle fetch — SIMULATION READ-ONLY.
 * Public GET /api/v3/klines endpoint only. No signing, no auth, no orders.
 */
import type { Candle } from "./signal";

const APEX_OMNI_HTTP = "https://omni.apex.exchange";
const KLINES_PATH = "/api/v3/klines";

/** Legacy hardcoded tick sizes — kept as a safety fallback when the caller
 * doesn't provide a per-symbol tick. New callers should pass the tick from
 * paper_test_symbols. */
export const APEX_TICKS: Record<string, number> = {
  BTCUSDT: 0.1,
  ETHUSDT: 0.01,
  SOLUSDT: 0.001,
};

export interface FetchedFeed {
  symbol: string;              // "BTC-USDT" (dashed, display)
  raw_symbol: string;          // "BTCUSDT" (venue)
  interval_min: number;
  candles: Candle[];           // ASCENDING; ONLY COMPLETED candles
  tick: number;
  fetched_at_ms: number;
}

export async function fetchApexKlines(
  displaySymbol: string,   // "BTC-USDT"
  intervalMin: number,
  limit: number,
  tickOverride?: number,
): Promise<FetchedFeed> {
  const raw = displaySymbol.replace("-", "");
  const tick = tickOverride ?? APEX_TICKS[raw] ?? 0.01;
  const url = `${APEX_OMNI_HTTP}${KLINES_PATH}?symbol=${raw}&interval=${intervalMin}&limit=${limit}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`ApeX klines HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown[]> };
  const data = body?.data;
  if (!data || typeof data !== "object") throw new Error("ApeX klines: bad envelope");
  const rows = data[raw];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`ApeX klines: no rows for ${raw}`);

  const stepMs = intervalMin * 60_000;
  const nowMs = Date.now();
  const out: Candle[] = [];
  for (const r of rows as Array<Record<string, string | number>>) {
    const ts = Number(r["t"]);
    const o = Number(r["o"]);
    const h = Number(r["h"]);
    const l = Number(r["l"]);
    const c = Number(r["c"]);
    const v = Number(r["v"]);
    if (![ts, o, h, l, c, v].every((n) => Number.isFinite(n))) continue;
    if (ts % stepMs !== 0) continue;
    if (ts + stepMs > nowMs) continue;
    out.push([ts, o, h, l, c, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < out.length; i++) {
    if (out[i][0] - out[i - 1][0] !== stepMs) {
      throw new Error(`ApeX klines: gap or dup at index ${i}`);
    }
  }
  return {
    symbol: displaySymbol,
    raw_symbol: raw,
    interval_min: intervalMin,
    candles: out,
    tick,
    fetched_at_ms: nowMs,
  };
}
