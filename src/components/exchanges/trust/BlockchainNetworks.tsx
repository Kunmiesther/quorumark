import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Blocks, ExternalLink, RefreshCw } from "lucide-react";
import {
  BLOCKCHAINS,
  walletSupportsNetwork,
  type Blockchain,
  type NetworkWallet,
} from "@/lib/blockchain/catalog";
import { inspectBlockchainWallet } from "@/lib/blockchain/readiness.functions";
import { supabase } from "@/integrations/supabase/client";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { WalletIdentity } from "@/components/exchanges/ConnectionIdentity";
import { CoinBadge } from "@/components/trade/CoinBadge";
import { AddWalletModal } from "@/components/wallet/AddWalletModal";
import { SectionHeading, Eyebrow } from "./primitives";
import { walletLabel } from "@/lib/wallet-logos";
import { BlockchainSpotPanel } from "./BlockchainSpotPanel";

export function BlockchainNetworks({
  wallets,
  isLoading = false,
  isError = false,
}: {
  wallets: NetworkWallet[];
  isLoading?: boolean;
  isError?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();
  return (
    <SurfaceCard>
      <SectionHeading
        title="Blockchain networks"
        subtitle="Self-custody · network-specific wallets and gas · separate from CEX / DEX accounts"
        actions={<Eyebrow>Blockchain</Eyebrow>}
      />
      <p className="mb-3 text-xs leading-5 text-white/60">
        Choose the wallet for each network. The same verified EVM address can be checked on Base,
        BNB Smart Chain and Robinhood Chain. Solana requires a separately verified Solana address. A
        balance check does not switch your wallet, bridge funds or authorize trading.
      </p>
      {isLoading ? (
        <p role="status" className="mb-3 text-xs text-cyan-200">
          Loading verified wallets…
        </p>
      ) : null}
      {isError ? (
        <p role="alert" className="mb-3 text-xs text-amber-200">
          Wallet list unavailable. Refresh to retry.
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {BLOCKCHAINS.map((network) => (
          <NetworkCard
            key={network.id}
            network={network}
            wallets={
              isError ? [] : wallets.filter((wallet) => walletSupportsNetwork(wallet, network))
            }
            walletListUnavailable={isLoading || isError}
            onAdd={() => setAddOpen(true)}
          />
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-white/45">
        Base and BNB offer direct-pool quotes and individually reviewed wallet swaps. Blockchain
        automation is not activated. Solana and Robinhood remain network-read only. Non-custodial
        describes asset control, not jurisdiction or trading eligibility.
      </p>
      <AddWalletModal
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setAddOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["wallet-connections-full"] });
        }}
      />
    </SurfaceCard>
  );
}

function NetworkMark({ network }: { network: Blockchain }) {
  const [failed, setFailed] = useState(false);
  if (network.id === "solana" || network.id === "bnb")
    return <CoinBadge symbol={network.gas} size={28} />;
  const src =
    network.id === "robinhood"
      ? "https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/rh_favicon_32.png"
      : "https://docs.base.org/mintlify-assets/_mintlify/favicons/base-a060aa97/j9xtk5UEjYZZf8JS/_generated/favicon/favicon-32x32.png";
  return failed ? (
    <Blocks aria-hidden="true" className="h-7 w-7" style={{ color: network.accent }} />
  ) : (
    <img
      src={src}
      alt=""
      width={28}
      height={28}
      className="rounded-full"
      onError={() => setFailed(true)}
    />
  );
}

function NetworkCard({
  network,
  wallets,
  onAdd,
  walletListUnavailable,
}: {
  network: Blockchain;
  wallets: NetworkWallet[];
  onAdd: () => void;
  walletListUnavailable: boolean;
}) {
  const id = useId();
  const [walletId, setWalletId] = useState("");
  const wallet = wallets.find((item) => item.id === walletId);
  const check = useMutation({
    mutationFn: async (selectedId: string) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to inspect a wallet.");
      return inspectBlockchainWallet({
        data: { network: network.id, walletId: selectedId },
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    },
  });
  const result =
    wallet && check.data?.wallet_id === wallet.id && check.data.address === wallet.public_address
      ? check.data
      : null;
  return (
    <article
      id={`blockchain-${network.id}`}
      className="tb-neu-panel min-w-0 rounded-2xl p-3"
      aria-label={`${network.name} network`}
    >
      <div className="mb-3 flex items-center gap-2">
        <NetworkMark network={network} />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{network.name}</h3>
          <p className="text-[10px] text-white/50">
            Mainnet · {network.chainId ? `Chain ${network.chainId}` : "Solana"} · {network.gas} gas
          </p>
        </div>
      </div>
      <label htmlFor={id} className="block text-[11px] text-white/65">
        Wallet for {network.name}
      </label>
      <select
        id={id}
        value={wallet?.id ?? ""}
        onChange={(event) => {
          setWalletId(event.target.value);
          check.reset();
        }}
        className="tb-neu-inset my-2 w-full min-w-0 rounded-lg bg-[#101118] px-2 py-2 text-xs text-white"
      >
        <option value="">Choose a verified wallet</option>
        {wallets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label || walletLabel(item.provider)} · {item.public_address}
          </option>
        ))}
      </select>
      {wallet ? (
        <WalletIdentity wallet={wallet} />
      ) : (
        <p className="text-xs text-white/45">
          {walletListUnavailable
            ? "Awaiting wallet list."
            : wallets.length
              ? "Select a wallet to read this network."
              : "No compatible verified wallet yet."}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!wallet || check.isPending}
          onClick={() => wallet && check.mutate(wallet.id)}
          className="tb-neu-raised inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-cyan-200 disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${check.isPending ? "animate-spin" : ""}`} />
          {check.isPending ? "Reading…" : "Check network"}
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg px-2 py-2 text-xs text-violet-200"
        >
          Add wallet
        </button>
      </div>
      {check.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Network read unavailable. Retry later; no transaction was sent.
        </p>
      ) : null}
      {result && !check.isError ? (
        <div aria-live="polite" className="mt-3 space-y-1 text-xs">
          <p className="text-cyan-200">Mainnet verified · read-only</p>
          <p className={result.gas_present ? "text-emerald-200" : "text-amber-200"}>
            {result.native_balance} {result.gas_symbol} ·{" "}
            {result.gas_present ? "gas present, cost not estimated" : "no gas balance"}
          </p>
          <p className="text-[10px] text-white/45">
            Read {new Date(result.checked_at).toLocaleString()}
          </p>
          <a
            href={`${network.explorer}${encodeURIComponent(result.address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-cyan-200"
          >
            View address <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
      <p className="mt-3 text-[11px] leading-5 text-amber-100/70">{network.route}</p>
      {wallet && (network.id === "base" || network.id === "bnb") ? (
        <BlockchainSpotPanel
          key={`${network.id}:${wallet.id}:${wallet.public_address}`}
          network={network.id}
          wallet={wallet}
        />
      ) : null}
      <a
        href={network.docs}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-[10px] text-white/50 underline"
      >
        Official network setup
      </a>
    </article>
  );
}
