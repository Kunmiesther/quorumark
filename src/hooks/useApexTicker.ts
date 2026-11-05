// Shared, read-only ApeX Omni public ticker poll. Multiple consumers of the
// same symbol dedupe via React Query's cache key. No auth, no keys, no orders.
//
// Endpoint: GET https://omni.apex.exchange/api/v3/ticker?symbol=<RAW>
// Returns the full 24h summary the desk header needs (last, high24, low24,
// vol24, fundingRate + nextFundingTime, mark/index). REST is the poll fallback
// path; the live tick stream lives in useApexPublicStream.
import { useQuery } from "@tanstack/react-query";

export type LivePrice = {
  /** Canonical RAW symbol the venue returned (e.g. "ETHUSDT"). Consumers
   *  passing `price` into a build path MUST verify this matches their
   *  requested symbol — see Ruling #6. */
  symbol: string;
  price: number;
  fetchedAt: number;
  // Extended header fields (all optional — may be null if the venue omits).
  markPrice: number | null;
  indexPrice: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;         // base units
  turnover24h: number | null;       // quote (USDT) — matches header "24h Vol"
  price24hPcnt: number | null;      // fractional (0.0123 == 1.23%)
  fundingRate: number | null;       // fractional per funding period
  nextFundingTimeMs: number | null; // epoch ms
};

/** ApeX ticker expects compact symbols ("BTCUSDT"), not "BTC-USDT". */
function toApexSymbol(symbol: string): string {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchTicker(symbol: string): Promise<LivePrice> {
  const apex = toApexSymbol(symbol);
  const url = `https://omni.apex.exchange/api/v3/ticker?symbol=${apex}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  const arr = Array.isArray(body?.data) ? body.data : [];
  const first = arr[0] as Record<string, unknown> | undefined;
  const last =
    num(first?.lastPrice) ??
    num(first?.markPrice) ??
    num(first?.indexPrice) ??
    num(first?.price) ??
    num(first?.oraclePrice);
  if (last == null || last <= 0) throw new Error("no price");
  const nextIso = typeof first?.nextFundingTime === "string" ? (first?.nextFundingTime as string) : null;
  const nextMs = nextIso ? Date.parse(nextIso) : NaN;
  return {
    symbol: apex,
    price: last,
    fetchedAt: Date.now(),
    markPrice: num(first?.markPrice),
    indexPrice: num(first?.indexPrice),
    high24h: num(first?.highPrice24h),
    low24h: num(first?.lowPrice24h),
    volume24h: num(first?.volume24h),
    turnover24h: num(first?.turnover24h),
    price24hPcnt: num(first?.price24hPcnt),
    fundingRate: num(first?.fundingRate),
    nextFundingTimeMs: Number.isFinite(nextMs) ? nextMs : null,
  };
}

/** Poll ApeX public ticker for one symbol. Read-only, deduped by react-query. */
export function useApexTicker(symbol: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["apex-ticker", symbol],
    enabled: !!symbol && enabled,
    queryFn: () => fetchTicker(symbol!),
    refetchInterval: 4_000,
    refetchIntervalInBackground: false,
    staleTime: 3_000,
    retry: 1,
  });
}
