// Public list of tradable perp symbols on ApeX Omni (mainnet).
// Same host and CORS profile as useCandles — direct browser fetch.
// If the fetch fails, callers fall back to a small hardcoded list.

import { useQuery } from "@tanstack/react-query";

export type ApexMarket = {
  /** Project-style symbol, e.g. "BTC-USDT" — what the chart / signal state uses. */
  symbol: string;
  /** Compact API symbol, e.g. "BTCUSDT". */
  apexSymbol: string;
  /** Human display, e.g. "BTC". */
  base: string;
  /** Quote asset, typically "USDT". */
  quote: string;
  /**
   * Venue leverage ceiling for THIS contract, or null when ApeX did not
   * publish one.
   *
   * Per-symbol, not global: ApeX's top tier is 100x and BTC/ETH get it, but
   * SOL/XRP/ARB cap at 50x. Without this the leverage picker offered 100x on
   * every symbol and the sizer silently clamped — `plan_entry_size` uses
   * `min(requested, venue_max)`, so 80x on SOL became 50x with nothing said.
   *
   * Derived exactly as the worker derives it (accumulator_live_size
   * `_venue_max_leverage`): `displayMaxLeverage`, else the reciprocal of
   * `initialMarginRate`. null means "unknown", never an assumed ceiling.
   */
  maxLeverage: number | null;
};

// Mirrors accumulator_sizing.VENUE_MAX_LEVERAGE, the worker's own last-resort
// table, so the two sides cannot disagree when the live fetch fails.
const FALLBACK: ApexMarket[] = [
  { symbol: "BTC-USDT", apexSymbol: "BTCUSDT", base: "BTC", quote: "USDT", maxLeverage: 100 },
  { symbol: "ETH-USDT", apexSymbol: "ETHUSDT", base: "ETH", quote: "USDT", maxLeverage: 100 },
  { symbol: "SOL-USDT", apexSymbol: "SOLUSDT", base: "SOL", quote: "USDT", maxLeverage: 50 },
];

function splitQuote(apex: string): { base: string; quote: string } {
  const upper = apex.toUpperCase();
  for (const q of ["USDT", "USDC", "USD"]) {
    if (upper.endsWith(q) && upper.length > q.length) {
      return { base: upper.slice(0, upper.length - q.length), quote: q };
    }
  }
  return { base: upper, quote: "" };
}

type PerpContract = {
  symbol?: string;
  symbolDisplayName?: string;
  enableTrade?: boolean;
  enableDisplay?: boolean;
  displayMaxLeverage?: string | number;
  initialMarginRate?: string | number;
};

/** Same derivation as the worker's `_venue_max_leverage`. */
function venueMaxLeverage(p: PerpContract): number | null {
  const display = Number(p.displayMaxLeverage);
  if (Number.isFinite(display) && display > 0) return Math.floor(display);
  const imr = Number(p.initialMarginRate);
  if (Number.isFinite(imr) && imr > 0) return Math.floor(1 / imr);
  // Unknown. NOT a guessed ceiling — callers must decide what to do with
  // "the venue did not say", and guessing is how an unsupported leverage
  // reaches the venue.
  return null;
}

export function useApexMarkets() {
  return useQuery({
    queryKey: ["apex-symbols"],
    staleTime: 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
    queryFn: async (): Promise<ApexMarket[]> => {
      const res = await fetch("https://omni.apex.exchange/api/v3/symbols", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`symbols HTTP ${res.status}`);
      const body: unknown = await res.json();
      const perp =
        (body as { data?: { contractConfig?: { perpetualContract?: PerpContract[] } } })
          ?.data?.contractConfig?.perpetualContract ?? [];
      const markets: ApexMarket[] = [];
      const seen = new Set<string>();
      for (const p of perp) {
        if (!p || p.enableDisplay === false || p.enableTrade === false) continue;
        const apex = (p.symbolDisplayName ?? p.symbol ?? "").toString().toUpperCase();
        if (!apex || seen.has(apex)) continue;
        seen.add(apex);
        const { base, quote } = splitQuote(apex);
        if (!quote) continue;
        markets.push({
          symbol: `${base}-${quote}`,
          apexSymbol: apex,
          base,
          quote,
          maxLeverage: venueMaxLeverage(p),
        });
      }
      return markets.length > 0 ? markets : FALLBACK;
    },
  });
}

export function apexMarketsWithFallback(data: ApexMarket[] | undefined): ApexMarket[] {
  return data && data.length > 0 ? data : FALLBACK;
}
