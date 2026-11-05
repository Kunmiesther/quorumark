// Public candle data for the trading chart.
// Sourced from ApeX Omni's public klines endpoint (mainnet, no auth) —
// the same venue the worker trades on. CORS is `*`, so we hit it
// directly from the browser. READ-ONLY market data; no credentials or
// execution path involved.

import { useQuery } from "@tanstack/react-query";

export type Candle = {
  openTime: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

// ApeX uses minute-integer strings (and "D" for daily) — NOT Binance codes.
const APEX_INTERVAL_MAP: Record<Interval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Normalize project-style "BTC-USDT" (or slash/underscore) to ApeX compact "BTCUSDT". */
function toApexSymbol(symbol: string): string {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

type ApexKline = {
  s?: string;
  i?: string;
  t?: number | string; // open time ms
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
};

function num(v: unknown): number {
  if (v == null) return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function mapKline(k: ApexKline, intervalMs: number): Candle | null {
  const openTime = num(k.t);
  const open = num(k.o);
  const high = num(k.h);
  const low = num(k.l);
  const close = num(k.c);
  const volume = num(k.v);
  if (!Number.isFinite(openTime) || !Number.isFinite(close)) return null;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    closeTime: openTime + intervalMs - 1,
  };
}

export function useCandles(
  symbol: string = "BTC-USDT",
  interval: Interval = "5m",
  limit: number = 200,
) {
  return useQuery({
    queryKey: ["candles", "apex", symbol, interval, limit],
    // Refresh a bit faster than the candle closes so the tape stays live.
    refetchInterval: Math.max(15_000, Math.floor(INTERVAL_MS[interval] / 4)),
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<Candle[]> => {
      const apexSym = toApexSymbol(symbol);
      const apexInt = APEX_INTERVAL_MAP[interval];
      const url = `https://omni.apex.exchange/api/v3/klines?symbol=${apexSym}&interval=${apexInt}&limit=${limit}`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`Market data unavailable (HTTP ${res.status})`);
      }
      const body: unknown = await res.json();

      // Real shape: { data: { [SYMBOL]: ApexKline[] }, timeCost }.
      // Also tolerate { data: ApexKline[] } or a bare array.
      let rows: ApexKline[] = [];
      if (body && typeof body === "object") {
        const data = (body as { data?: unknown }).data;
        if (Array.isArray(data)) {
          rows = data as ApexKline[];
        } else if (data && typeof data === "object") {
          const byKey = (data as Record<string, unknown>)[apexSym];
          if (Array.isArray(byKey)) {
            rows = byKey as ApexKline[];
          } else {
            // Fall back to the first array value in the map.
            for (const v of Object.values(data as Record<string, unknown>)) {
              if (Array.isArray(v)) {
                rows = v as ApexKline[];
                break;
              }
            }
          }
        } else if (Array.isArray(body)) {
          rows = body as ApexKline[];
        }
      }

      const intervalMs = INTERVAL_MS[interval];
      const candles = rows
        .map((r) => mapKline(r, intervalMs))
        .filter((c): c is Candle => c !== null)
        .sort((a, b) => a.openTime - b.openTime);
      return candles;
    },
  });
}
