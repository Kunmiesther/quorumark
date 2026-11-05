// Shared portfolio aggregation hook.
// Reads (a) verified exchange connections and their live equity via the
// existing `exchange-credentials` (action: "summary") edge function, and
// (b) on-chain wallet balances via the existing `wallet-balances` edge
// function. Returns a normalized shape so multiple pages can render the
// same total without duplicating logic.
//
// This hook is READ-ONLY. It does not change auth, adapters, or trading.
//
// NOTE: totals here SUM USD across wallets and exchange accounts. They do
// NOT net exposure by instrument (e.g. long BTC-PERP on one venue vs spot
// BTC on another). The two-wallet hedge accounting needed for spot/futures
// exposure netting is a separate build and is not attempted in this hook.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isSupportedVenue } from "@/lib/supported-exchanges";
import { invokeWithRetry } from "@/lib/edge/invokeWithRetry";

const VENUE_LABELS: Record<string, string> = {
  btcc: "BTCC",
  bydfi: "BYDfi",
  apex_omni: "ApeX Omni",
};

export type ExchangeSummary =
  | { ok: true; venue: string; total: number; available: number; inTrades: number }
  | { ok: false; venue: string; code: string; message: string };

export type WalletBalance = { asset: string; amount: number; usdValue: number | null };
export type WalletEntry = {
  id: string;
  chain: string;
  address: string;
  balances: WalletBalance[];
  walletUsdTotal: number;
  priceUnavailable: boolean;
  errors: { chain: string; code: string; message: string }[];
};
export type WalletBalancesPayload = {
  ok?: boolean;
  wallets?: WalletEntry[];
  overallUsdTotal?: number;
  errors?: { chain: string; address: string; code: string; message: string }[];
};

export interface PortfolioTotals {
  // Aggregates
  totalUsd: number;
  exchangeUsd: number;
  walletUsd: number;
  available: number;
  allocated: number;

  // Connection presence
  verifiedConns: { id: string; exchange: string; status: string | null }[];
  exchangeConns: { id: string; exchange: string; status: string | null }[];
  walletCount: number;

  // Detail entries
  exchangeEntries: ExchangeSummary[];
  exchangeSuccesses: Extract<ExchangeSummary, { ok: true }>[];
  exchangeFailures: Extract<ExchangeSummary, { ok: false }>[];
  walletEntries: WalletEntry[];
  walletErrors: { chain: string; address: string; code: string; message: string }[];

  // Loading / freshness
  isLoading: boolean;
  exchangeFetching: boolean;
  walletFetching: boolean;
  exchangeUpdatedAt: number;

  // Convenience
  hasAnyConnection: boolean;
  hasError: boolean;
  walletAllZero: boolean;
}

export function usePortfolioTotals(): PortfolioTotals {
  const { user } = useAuth();

  const { data: walletCount = 0 } = useQuery({
    queryKey: ["wallet-connections-count", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("wallet_connections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user!.id)
        .neq("status", "disconnected");
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: conns = [] } = useQuery({
    queryKey: ["exchange-connections-list", user?.id],
    enabled: !!user,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as { id: string; exchange: string; status: string | null }[];
    },
  });

  const exchangeConns = conns.filter(
    (c) => c.status !== "disconnected" && isSupportedVenue(c.exchange),
  );
  const verifiedConns = exchangeConns.filter((c) => c.status === "verified");

  const {
    data: exchangeEntries = [],
    isFetching: exchangeFetching,
    dataUpdatedAt: exchangeUpdatedAt,
  } = useQuery({
    queryKey: [
      "exchange-summaries",
      user?.id,
      verifiedConns.map((c) => c.id).sort().join(","),
    ],
    enabled: !!user && verifiedConns.length > 0,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const out: ExchangeSummary[] = [];
      for (const c of verifiedConns) {
        const venueLabel = VENUE_LABELS[c.exchange] ?? c.exchange;
        const { data, error: fnError } = await invokeWithRetry(
          "exchange-credentials",
          { action: "summary", connection_id: c.id },
        );
        if (fnError) {
          out.push({
            ok: false,
            venue: venueLabel,
            code: "REQUEST_FAILED",
            message: fnError.message || "Could not reach balance service.",
          });
          continue;
        }
        const payload = data as {
          ok?: boolean;
          code?: string;
          message?: string;
          summary?: { totalEquity?: number; availableBalance?: number; inTrades?: number };
        } | null;
        if (payload?.ok && payload.summary) {
          out.push({
            ok: true,
            venue: venueLabel,
            total: payload.summary.totalEquity ?? 0,
            available: payload.summary.availableBalance ?? 0,
            inTrades: payload.summary.inTrades ?? 0,
          });
        } else {
          out.push({
            ok: false,
            venue: venueLabel,
            code: payload?.code ?? "UNKNOWN_ERROR",
            message: payload?.message ?? "Balance fetch failed.",
          });
        }
      }
      return out;
    },
  });

  const {
    data: walletBalancesData,
    isFetching: walletFetching,
  } = useQuery({
    queryKey: ["wallet-balances", user?.id],
    enabled: !!user && walletCount > 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error: fnError } = await supabase.functions.invoke(
        "wallet-balances",
        { body: {} },
      );
      if (fnError) {
        return {
          ok: false,
          wallets: [],
          overallUsdTotal: 0,
          errors: [
            {
              chain: "*",
              address: "",
              code: "REQUEST_FAILED",
              message: fnError.message || "Could not reach wallet balance service.",
            },
          ],
        } as WalletBalancesPayload;
      }
      return (data ?? {}) as WalletBalancesPayload;
    },
  });

  const exchangeSuccesses = exchangeEntries.filter(
    (e): e is Extract<ExchangeSummary, { ok: true }> => e.ok,
  );
  const exchangeFailures = exchangeEntries.filter(
    (e): e is Extract<ExchangeSummary, { ok: false }> => !e.ok,
  );
  const exchangeUsd = exchangeSuccesses.reduce((a, b) => a + b.total, 0);
  const available = exchangeSuccesses.reduce((a, b) => a + b.available, 0);
  const allocated = exchangeSuccesses.reduce((a, b) => a + b.inTrades, 0);

  const walletEntries = walletBalancesData?.wallets ?? [];
  const walletErrors = walletBalancesData?.errors ?? [];
  const walletUsd = walletBalancesData?.overallUsdTotal ?? 0;
  const walletHasFunded = walletEntries.some((w) => w.walletUsdTotal > 0);
  const walletAllZero =
    walletCount > 0 && walletEntries.length > 0 && !walletHasFunded && walletErrors.length === 0;

  const totalUsd = exchangeUsd + walletUsd;
  const hasAnyConnection = verifiedConns.length > 0 || walletCount > 0;

  // "Loading" = at least one source is being fetched for the first time.
  const exchangeLoading =
    verifiedConns.length > 0 && exchangeFetching && exchangeUpdatedAt === 0;
  const walletLoading = walletCount > 0 && walletFetching && !walletBalancesData;
  const isLoading = exchangeLoading || walletLoading;

  const hasError =
    (exchangeFailures.length > 0 && exchangeSuccesses.length === 0) ||
    (walletCount > 0 && walletErrors.length > 0 && !walletHasFunded);

  return {
    totalUsd,
    exchangeUsd,
    walletUsd,
    available,
    allocated,
    verifiedConns,
    exchangeConns,
    walletCount,
    exchangeEntries,
    exchangeSuccesses,
    exchangeFailures,
    walletEntries,
    walletErrors,
    isLoading,
    exchangeFetching,
    walletFetching,
    exchangeUpdatedAt,
    hasAnyConnection,
    hasError,
    walletAllZero,
  };
}
