/**
 * useTradeBalance — the authenticated account's REAL spendable balance for
 * the trade ticket.
 *
 *   paper → simulated equity: `paper_accounts.balance` minus margin already
 *           locked in open paper positions.
 *   live  → the venue's own reported available balance, via the existing
 *           portfolio summary path (exchange account source of truth).
 *
 * Never falls back to a placeholder number: when the source is unavailable it
 * returns `null` so the ticket blocks submission instead of sizing against a
 * balance nobody verified.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePortfolioTotals } from "@/hooks/usePortfolioTotals";
import { paperTicketAvailable } from "@/lib/paper/portfolioWallets";

export interface TradeBalance {
  /** Spendable margin in USD, or null when unknown. */
  available: number | null;
  /** Total equity in USD, or null when unknown. */
  equity: number | null;
  source: "paper_account" | "exchange_account" | "unavailable";
  isLoading: boolean;
}

export function useTradeBalance(
  book: "paper" | "live",
  paperWallet?: "long" | "short",
): TradeBalance {
  const { user, isReady } = useAuth();
  const portfolio = usePortfolioTotals();

  const paper = useQuery({
    queryKey: ["trade-balance", "paper", user?.id ?? "anon", paperWallet ?? "portfolio"],
    enabled: book === "paper" && isReady && !!user,
    refetchInterval: 30_000,
    staleTime: 10_000,
    queryFn: async () => {
      const [acct, open, wallet] = await Promise.all([
        supabase.from("paper_accounts").select("balance").eq("user_id", user!.id).maybeSingle(),
        supabase
          .from("paper_positions")
          .select("margin,wallet_key")
          .eq("user_id", user!.id)
          .eq("status", "open"),
        paperWallet
          ? supabase
              .from("paper_wallets")
              .select("balance")
              .eq("user_id", user!.id)
              .eq("wallet_key", paperWallet)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (acct.error) throw acct.error;
      if (open.error) throw open.error;
      if (wallet.error) throw wallet.error;
      if (!acct.data) return null;
      const equity = Number(acct.data.balance ?? 0);
      const locked = (open.data ?? []).reduce((sum, r) => sum + Number(r.margin ?? 0), 0);
      const accountAvailable = Math.max(0, equity - locked);
      const walletReserved = (open.data ?? [])
        .filter((row) => row.wallet_key === paperWallet)
        .reduce((sum, row) => sum + Number(row.margin ?? 0), 0);
      return {
        equity,
        available: paperWallet
          ? paperTicketAvailable(accountAvailable, wallet.data?.balance, walletReserved)
          : accountAvailable,
      };
    },
  });

  if (book === "paper") {
    const d = paper.data;
    return {
      available: d ? d.available : null,
      equity: d ? d.equity : null,
      source: d ? "paper_account" : "unavailable",
      isLoading: paper.isLoading,
    };
  }

  const hasVenue = portfolio.exchangeSuccesses.length > 0;
  return {
    available: hasVenue ? portfolio.available : null,
    equity: hasVenue ? portfolio.exchangeUsd : null,
    source: hasVenue ? "exchange_account" : "unavailable",
    isLoading: portfolio.isLoading,
  };
}
