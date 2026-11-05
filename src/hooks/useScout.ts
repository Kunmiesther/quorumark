/**
 * useScout — focused internal-test scanner. BTC, XRP, SOL, and ETH come
 * from the shared orchestration contract. Fetches 5m ApeX klines (public,
 * read-only — same venue the paper engine reads) and computes movement /
 * trend / volatility / momentum via `scoutSignal`.
 *
 * REPORT-ONLY: this hook produces intelligence for the Scout dashboard.
 * It never touches wallets, orders, the worker, or the paper engine's
 * execution path.
 */

import { useQuery } from "@tanstack/react-query";
import { scoutSignal, type ScoutSignal } from "@/lib/scout/scoring";
import type { Candle } from "@/lib/paper/signal";
import { DEFAULT_PAPER_SYMBOLS } from "@/lib/paper/constants";

export interface ScoutSymbol {
  /** Project-style symbol e.g. "BTC-USDT" (what the paper engine uses). */
  symbol: string;
  /** Display base e.g. "BTC". */
  base: string;
  /** True for BTC/ETH — always-watched anchors. */
  anchor: boolean;
  /** True when this symbol is enabled for internal paper testing. */
  paperEnabled: boolean;
}

export interface ScoutReport extends ScoutSymbol {
  signal: ScoutSignal | null;
  error: string | null;
  candleCount: number;
}

const ANCHORS = new Set(["BTC-USDT", "ETH-USDT"]);

function baseOf(symbol: string): string {
  const i = symbol.indexOf("-");
  return i > 0 ? symbol.slice(0, i) : symbol;
}

function toApexSymbol(symbol: string): string {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

interface ApexKline {
  t?: number | string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Fetch 5m klines from ApeX and shape into the paper engine's Candle tuple. */
async function fetchCandles(symbol: string, limit = 200): Promise<Candle[]> {
  const apexSym = toApexSymbol(symbol);
  const url = `https://omni.apex.exchange/api/v3/klines?symbol=${apexSym}&interval=5&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ApeX klines ${symbol} HTTP ${res.status}`);
  const body = (await res.json()) as unknown;

  let rows: ApexKline[] = [];
  if (body && typeof body === "object") {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) rows = data as ApexKline[];
    else if (data && typeof data === "object") {
      const byKey = (data as Record<string, unknown>)[apexSym];
      if (Array.isArray(byKey)) rows = byKey as ApexKline[];
      else {
        for (const v of Object.values(data as Record<string, unknown>)) {
          if (Array.isArray(v)) {
            rows = v as ApexKline[];
            break;
          }
        }
      }
    } else if (Array.isArray(body)) rows = body as ApexKline[];
  }

  return rows
    .map<Candle | null>((r) => {
      const t = num(r.t),
        o = num(r.o),
        h = num(r.h),
        l = num(r.l),
        c = num(r.c),
        v = num(r.v);
      if (!Number.isFinite(t) || !Number.isFinite(c)) return null;
      return [t, o, h, l, c, Number.isFinite(v) ? v : 0];
    })
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a[0] - b[0]);
}

async function fetchScanUniverse(): Promise<ScoutSymbol[]> {
  return DEFAULT_PAPER_SYMBOLS.map((symbol) => ({
    symbol,
    base: baseOf(symbol),
    anchor: ANCHORS.has(symbol),
    paperEnabled: true,
  }));
}

export function useScout() {
  return useQuery({
    queryKey: ["scout", "movement-scan"],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<ScoutReport[]> => {
      const universe = await fetchScanUniverse();
      const reports = await Promise.all(
        universe.map(async (u): Promise<ScoutReport> => {
          try {
            const candles = await fetchCandles(u.symbol);
            const signal = candles.length > 0 ? scoutSignal(candles) : null;
            return { ...u, signal, error: null, candleCount: candles.length };
          } catch (e) {
            return {
              ...u,
              signal: null,
              error: e instanceof Error ? e.message : "fetch failed",
              candleCount: 0,
            };
          }
        }),
      );
      return reports;
    },
  });
}
