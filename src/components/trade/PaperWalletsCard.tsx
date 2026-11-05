import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { initializePaperPortfolio } from "@/lib/paper/portfolioWallets.functions";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { walletLogo } from "@/lib/wallet-logos";
import {
  PAPER_PORTFOLIO_WALLETS,
  PAPER_WALLET_PROVIDERS,
  paperWalletFunds,
} from "@/lib/paper/portfolioWallets";

type Preference = { wallet_key: string; simulated_provider: string };
const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Simulation profiles never connect a provider, request a key, or sign. */
export function PaperWalletsCard() {
  const { user } = useAuth();
  const client = useQueryClient();
  const initialize = useServerFn(initializePaperPortfolio);
  const fund = useMutation({
    mutationFn: () => initialize(),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["paper-portfolio-wallets"] }),
        client.invalidateQueries({ queryKey: ["trade-balance", "paper"] }),
      ]),
  });
  const key = ["paper-portfolio-wallets", user?.id];
  const query = useQuery({
    queryKey: key,
    enabled: !!user,
    refetchInterval: 20_000,
    queryFn: async () => {
      const [wallets, positions, preferences, funding] = await Promise.all([
        supabase
          .from("paper_wallets")
          .select("wallet_key,balance,realized_pnl,status,execution_enabled")
          .eq("user_id", user!.id),
        supabase
          .from("paper_positions")
          .select("wallet_key,margin")
          .eq("user_id", user!.id)
          .eq("status", "open"),
        supabase
          .from("paper_wallet_preferences" as never)
          .select("wallet_key,simulated_provider")
          .eq("user_id", user!.id)
          .returns<Preference[]>(),
        supabase
          .from("paper_portfolio_funding" as never)
          .select("funded_at")
          .eq("user_id", user!.id)
          .returns<{ funded_at: string }[]>()
          .maybeSingle(),
      ]);
      for (const response of [wallets, positions, preferences, funding])
        if (response.error) throw response.error;
      return {
        wallets: wallets.data ?? [],
        positions: positions.data ?? [],
        preferences: preferences.data ?? [],
        funded: !!funding.data,
      };
    },
  });
  const save = useMutation({
    mutationFn: async ({ wallet, provider }: { wallet: string; provider: string }) => {
      if (!user) throw new Error("Sign in to save a paper profile.");
      const result = await supabase.from("paper_wallet_preferences" as never).upsert(
        {
          user_id: user.id,
          wallet_key: wallet,
          simulated_provider: provider,
        } as never,
        { onConflict: "user_id,wallet_key" },
      );
      if (result.error) throw result.error;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return (
    <SurfaceCard as="section" className="min-w-0">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Six paper wallets</h3>
        <span className="text-xs text-violet-200">Simulated funds only</span>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        $2,500 initial allocation per wallet · $15,000 total. Balances change with paper results.
        Wallet brands below are simulation profiles, not connected wallets.
      </p>
      {query.isError ? (
        <p role="alert" className="text-xs text-amber-200">
          Paper wallets unavailable. No live balances are substituted.
        </p>
      ) : query.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading paper wallets…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {PAPER_PORTFOLIO_WALLETS.map((role) => {
            const wallet = query.data?.wallets.find((w) => w.wallet_key === role.key);
            const reserved =
              query.data?.positions
                .filter((p) => p.wallet_key === role.key)
                .reduce((sum, p) => sum + Number(p.margin), 0) ?? 0;
            const funds = paperWalletFunds(wallet?.balance, reserved);
            const provider =
              query.data?.preferences.find((p) => p.wallet_key === role.key)?.simulated_provider ??
              role.provider;
            const logo = walletLogo(provider);
            return (
              <article key={role.key} className="tb-neu-inset rounded-2xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">{role.label}</h4>
                  {logo ? (
                    <img src={logo} alt="" className="h-6 w-6 rounded-full object-contain" />
                  ) : (
                    <Wallet aria-hidden="true" className="h-5 w-5 text-violet-200" />
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {role.blockchain
                    ? "Not configured · blockchain simulator pending"
                    : wallet?.execution_enabled && wallet.status === "active"
                      ? "Paper route available · plan controls apply"
                      : "Paper route inactive"}
                </p>
                <div className="my-2 font-mono text-lg tabular-nums">
                  {funds ? usd(funds.settled) : "—"}
                </div>
                <p className="text-xs text-muted-foreground">
                  In trades {funds ? usd(funds.reserved) : "—"} · Uncommitted{" "}
                  {funds ? usd(funds.available) : "—"}
                </p>
                <label className="mt-3 block text-xs text-muted-foreground">
                  Simulation wallet brand
                  <select
                    aria-label={`${role.label} simulation wallet brand`}
                    value={provider}
                    disabled={!wallet || save.isPending}
                    onChange={(event) =>
                      save.mutate({ wallet: role.key, provider: event.target.value })
                    }
                    className="tb-neu-inset mt-1 w-full rounded-xl p-2 text-foreground"
                  >
                    {Object.entries(PAPER_WALLET_PROVIDERS).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </article>
            );
          })}
        </div>
      )}
      {query.data && !query.data.funded ? (
        <div className="mt-3">
          <p className="text-xs text-amber-200">
            One-time setup sets each paper wallet to $2,500. Historical P&amp;L and open positions
            are retained; the funding adjustment is recorded separately.
          </p>
          <button
            type="button"
            disabled={fund.isPending}
            onClick={() => fund.mutate()}
            className="tb-neu-inset mt-2 rounded-xl px-4 py-2 text-sm text-violet-200"
          >
            {fund.isPending
              ? "Initializing paper wallets…"
              : "Initialize six paper wallets · $15,000 simulated"}
          </button>
        </div>
      ) : null}
      {fund.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Paper allocation could not be initialized. Existing balances are unchanged.
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Could not save the simulation profile. Try again.
        </p>
      ) : null}
    </SurfaceCard>
  );
}
