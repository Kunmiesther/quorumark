/**
 * useCoinGecko — keyless public CoinGecko hooks.
 *
 * Rules (money app):
 *  - Never fabricate prices. On network / 429 / non-OK responses the hook
 *    surfaces `{ data: undefined, isError: true }` and the UI shows a real
 *    "unavailable" state.
 *  - Gentle polling only: 60s refetch, 45s stale, one retry.
 *  - Direct browser fetch (CoinGecko public API is CORS-open on the
 *    keyless tier for these endpoints).
 */

import { useQuery } from "@tanstack/react-query";

const BASE = "https://api.coingecko.com/api/v3";

async function cgFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // 429 / 5xx / any non-2xx — treat as unavailable, do not synthesise data.
    throw new Error(`CoinGecko ${res.status}`);
  }
  return (await res.json()) as T;
}

// ── Simple price ────────────────────────────────────────────────────────────
export interface Ticker {
  id: "bitcoin" | "ethereum" | "solana";
  symbol: "BTC" | "ETH" | "SOL";
  name: string;
  usd: number;
  change24h: number;
}

const TICKER_META: Array<Pick<Ticker, "id" | "symbol" | "name">> = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" },
];

type SimplePriceResponse = Record<
  string,
  { usd?: number; usd_24h_change?: number }
>;

export function useMarketTickers() {
  return useQuery({
    queryKey: ["cg", "tickers", "btc-eth-sol"],
    staleTime: 45_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<Ticker[]> => {
      const raw = await cgFetch<SimplePriceResponse>(
        "/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
        signal,
      );
      return TICKER_META.map((m) => {
        const row = raw[m.id];
        if (!row || typeof row.usd !== "number") {
          throw new Error(`missing ticker ${m.id}`);
        }
        return {
          ...m,
          usd: row.usd,
          change24h: typeof row.usd_24h_change === "number" ? row.usd_24h_change : 0,
        };
      });
    },
  });
}

// ── Top by 24h volume ───────────────────────────────────────────────────────
export interface MarketRow {
  id: string;
  symbol: string;
  name: string;
  image: string;
  price: number;
  change24h: number;
  rank: number;
}

interface CGMarket {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  price_change_percentage_24h?: number | null;
  market_cap_rank?: number | null;
}

export function useTopMovers() {
  return useQuery({
    queryKey: ["cg", "movers", "volume-desc"],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<MarketRow[]> => {
      const rows = await cgFetch<CGMarket[]>(
        "/coins/markets?vs_currency=usd&order=volume_desc&per_page=10&page=1&price_change_percentage=24h",
        signal,
      );
      return rows.map((r, i) => ({
        id: r.id,
        symbol: r.symbol.toUpperCase(),
        name: r.name,
        image: r.image,
        price: r.current_price,
        change24h: r.price_change_percentage_24h ?? 0,
        rank: r.market_cap_rank ?? i + 1,
      }));
    },
  });
}

// ── Top 10 by market cap (stablecoins filtered so every tile is a live mover) ─
const STABLECOIN_IDS = new Set([
  "tether",
  "usd-coin",
  "dai",
  "first-digital-usd",
  "true-usd",
  "paypal-usd",
  "frax",
  "usdd",
  "ethena-usde",
  "usds",
]);

export function useTopByMarketCap() {
  return useQuery({
    queryKey: ["cg", "top-market-cap", "no-stables"],
    staleTime: 45_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<MarketRow[]> => {
      // Ask for 20 so filtering stablecoins still leaves 10 real movers.
      const rows = await cgFetch<CGMarket[]>(
        "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&price_change_percentage=24h",
        signal,
      );
      return rows
        .filter((r) => !STABLECOIN_IDS.has(r.id))
        .slice(0, 10)
        .map((r, i) => ({
          id: r.id,
          symbol: r.symbol.toUpperCase(),
          name: r.name,
          image: r.image,
          price: r.current_price,
          change24h: r.price_change_percentage_24h ?? 0,
          rank: r.market_cap_rank ?? i + 1,
        }));
    },
  });
}

// ── Trending (search) ───────────────────────────────────────────────────────
export interface TrendingRow {
  id: string;
  symbol: string;
  name: string;
  image: string;
  price: number | null;
  change24h: number | null;
  rank: number;
}

interface CGTrendingResponse {
  coins: Array<{
    item: {
      id: string;
      coin_id: number;
      name: string;
      symbol: string;
      small: string;
      thumb: string;
      market_cap_rank: number;
      data?: {
        price?: number | string | null;
        price_change_percentage_24h?: Record<string, number> | null;
      };
    };
  }>;
}

export function useTrending() {
  return useQuery({
    queryKey: ["cg", "trending"],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<TrendingRow[]> => {
      const raw = await cgFetch<CGTrendingResponse>("/search/trending", signal);
      return raw.coins.slice(0, 7).map((c, i) => {
        const priceRaw = c.item.data?.price;
        const price =
          typeof priceRaw === "number"
            ? priceRaw
            : typeof priceRaw === "string"
              ? Number(priceRaw.replace(/[$,]/g, ""))
              : null;
        const chg = c.item.data?.price_change_percentage_24h?.usd;
        return {
          id: c.item.id,
          symbol: c.item.symbol.toUpperCase(),
          name: c.item.name,
          image: c.item.small ?? c.item.thumb,
          price: Number.isFinite(price ?? NaN) ? (price as number) : null,
          change24h: typeof chg === "number" ? chg : null,
          rank: c.item.market_cap_rank ?? i + 1,
        };
      });
    },
  });
}
