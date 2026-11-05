// Per-user wallet list with joined live balance data.
// Reads:
//   - public.wallet_connections (via Supabase, RLS-scoped to auth.uid())
//   - supabase.functions.invoke("wallet-balances") which returns per-wallet
//     balances/USD totals (already user-scoped server-side).
//
// Returns rich per-wallet objects for the wallet management UI, plus
// aggregates (portfolio summary).

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { WalletBalancesPayload, WalletEntry } from "@/hooks/usePortfolioTotals";

export type WalletRow = {
  id: string;
  provider: string;
  public_address: string;
  chain: string;
  network: string;
  label: string | null;
  status: string;
  is_active: boolean;
  is_default: boolean;
  apex_authorized: boolean;
  assigned_exchange_connection_id: string | null;
  verified_at: string | null;
  connected_at: string | null;
  last_seen_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
};

export type WalletHealth =
  "connected" | "syncing" | "network_mismatch" | "auth_required" | "disconnected" | "error";

export type WalletWithBalance = {
  row: WalletRow;
  balances: WalletEntry | undefined;
  usdTotal: number;
  health: WalletHealth;
  balanceLoading: boolean;
  balanceError: string | null;
};

function computeHealth(row: WalletRow, entry: WalletEntry | undefined): WalletHealth {
  if (row.status === "disconnected") return "disconnected";
  if (row.status === "pending" || row.status === "challenge_issued") return "auth_required";
  if (row.last_error) return "error";
  if (!entry) return "syncing";
  if (entry.errors && entry.errors.length > 0) return "error";
  return "connected";
}

export function useWalletList() {
  const { user } = useAuth();

  const walletsQ = useQuery({
    queryKey: ["wallet-connections-full", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wallet_connections")
        .select(
          "id, provider, public_address, chain, network, label, status, is_active, is_default, apex_authorized, assigned_exchange_connection_id, verified_at, connected_at, last_seen_at, disconnected_at, last_error, last_error_at, created_at",
        )
        .eq("user_id", user!.id)
        .neq("status", "disconnected")
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WalletRow[];
    },
  });

  const balancesQ = useQuery({
    queryKey: ["wallet-balances-full", user?.id],
    enabled: !!user && (walletsQ.data?.length ?? 0) > 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async () => {
      // Ensure a live session exists before hitting the edge function; a
      // stale/expired session results in no Authorization header being
      // attached, and the function returns 401 UNAUTHENTICATED.
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session?.access_token) {
        return {
          ok: false,
          wallets: [],
          overallUsdTotal: 0,
          errors: [
            { chain: "*", address: "", code: "UNAUTHENTICATED", message: "Sign in required." },
          ],
        } as WalletBalancesPayload;
      }
      const { data, error } = await supabase.functions.invoke("wallet-balances", { body: {} });
      if (error) {
        return {
          ok: false,
          wallets: [],
          overallUsdTotal: 0,
          errors: [
            {
              chain: "*",
              address: "",
              code: "REQUEST_FAILED",
              message: error.message || "Could not reach wallet balance service.",
            },
          ],
        } as WalletBalancesPayload;
      }
      return (data ?? {}) as WalletBalancesPayload;
    },
  });

  const wallets = walletsQ.data ?? [];
  const entriesByKey = new Map<string, WalletEntry>();
  for (const e of balancesQ.data?.wallets ?? []) {
    entriesByKey.set(`${e.chain}:${e.address.toLowerCase()}`, e);
  }

  const items: WalletWithBalance[] = wallets.map((row) => {
    const key = `${row.chain}:${row.public_address.toLowerCase()}`;
    const entry = entriesByKey.get(key);
    const health = computeHealth(row, entry);
    return {
      row,
      balances: entry,
      usdTotal: entry?.walletUsdTotal ?? 0,
      health,
      balanceLoading: balancesQ.isFetching && !entry,
      balanceError:
        entry?.errors && entry.errors.length > 0
          ? entry.errors[0].message
          : (row.last_error ?? null),
    };
  });

  const totalUsd = items.reduce((s, i) => s + i.usdTotal, 0);
  const healthyCount = items.filter((i) => i.health === "connected").length;
  const needAttentionCount = items.filter(
    (i) => i.health === "error" || i.health === "network_mismatch" || i.health === "auth_required",
  ).length;

  return {
    items,
    totalUsd,
    walletCount: items.length,
    healthyCount,
    needAttentionCount,
    isLoading: walletsQ.isLoading,
    isError: walletsQ.isError,
    balancesFetching: balancesQ.isFetching,
    balancesUpdatedAt: balancesQ.dataUpdatedAt,
    refetchAll: async () => {
      await Promise.all([walletsQ.refetch(), balancesQ.refetch()]);
    },
  };
}
