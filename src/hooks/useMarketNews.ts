/**
 * useMarketNews — real CoinDesk headlines via the market-news server function.
 *
 * The server function proxies CoinDesk's public RSS (browser can't hit it
 * directly — no CORS). On failure the hook surfaces empty items so the UI
 * can render an honest "News unavailable" state; we never fabricate.
 */

import { useQuery } from "@tanstack/react-query";
import { getMarketNews, type MarketNewsItem } from "@/lib/market-news.functions";

export type { MarketNewsItem };

export function useMarketNews() {
  return useQuery({
    queryKey: ["market-news", "coindesk"],
    staleTime: 4 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const res = await getMarketNews();
      return res.items;
    },
  });
}
