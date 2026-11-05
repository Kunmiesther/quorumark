import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownUp, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inspectSpotSwap, inspectBlockchainToken } from "@/lib/blockchain/spot.functions";
import { tokenFromSearch } from "@/lib/blockchain/tokenSelection";
import { SPOT_ROUTES, type SpotNetwork, type SpotRequest } from "@/lib/blockchain/spot";
import { type NetworkWallet } from "@/lib/blockchain/catalog";
import { CoinBadge } from "@/components/trade/CoinBadge";
import { BlockchainSwapExecution } from "./BlockchainSwapExecution";

/** Mainnet quotes plus a separately reviewed, user-confirmed wallet transaction flow. */
export function BlockchainSpotPanel({
  network,
  wallet,
}: {
  network: SpotNetwork;
  wallet: NetworkWallet;
}) {
  const id = useId();
  const config = SPOT_ROUTES[network];
  const [direction, setDirection] = useState<SpotRequest["direction"]>("native_to_stable");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [custom, setCustom] = useState(false);
  const [tokenAddress, setTokenAddress] = useState("");
  useEffect(() => {
    const address = tokenFromSearch(window.location.search, network);
    if (address) {
      setTokenAddress(address);
      setCustom(true);
    }
  }, [network]);
  const tokenLookup = useMutation({
    mutationFn: async (address: string) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to inspect this token.");
      return inspectBlockchainToken({
        data: { network, address },
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    },
  });
  const token =
    custom &&
    tokenLookup.data?.address === tokenAddress.toLowerCase() &&
    tokenLookup.data.chainId === config.chainId
      ? tokenLookup.data
      : undefined;
  const input = {
    network,
    walletId: wallet.id,
    direction,
    amount,
    slippageBps,
    ...(token ? { token } : {}),
  };
  const key = JSON.stringify(input);
  const preview = useMutation({
    mutationFn: async (request: SpotRequest) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to preview a swap.");
      const result = await inspectSpotSwap({
        data: request,
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      return { key: JSON.stringify(request), result };
    },
  });
  const result = (!custom || token) && preview.data?.key === key ? preview.data.result : null;
  const tokenSymbol = custom ? (token?.symbol ?? "Selected token") : config.stableSymbol;
  const sell = direction === "native_to_stable" ? config.gas : tokenSymbol;
  const buy = direction === "native_to_stable" ? tokenSymbol : config.gas;
  const validAmount =
    (!custom || !!token) &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) &&
    Number(amount) > 0 &&
    Number.isFinite(Number(amount));
  return (
    <section
      aria-label={`${config.name} spot swap preflight`}
      className="tb-neu-inset mt-3 space-y-3 rounded-xl p-3"
    >
      <div className="flex items-center gap-2 text-xs text-cyan-200">
        <ArrowDownUp className="h-4 w-4" aria-hidden="true" />
        <h4>Spot swap · mainnet preflight</h4>
      </div>
      <p className="text-[11px] leading-5 text-white/60">
        Uniswap v3 · native asset ↔ selected token · direct pools only. Not limited to four symbols.
        No leverage or cross-chain transfers. Other DEXs and multi-hop routes are not supported here
        yet.
      </p>
      <label htmlFor={`${id}-token-mode`} className="block text-xs text-white/70">
        Token selection
      </label>
      <select
        id={`${id}-token-mode`}
        value={custom ? "custom" : "default"}
        onChange={(e) => {
          setCustom(e.target.value === "custom");
          setAmount("");
          preview.reset();
        }}
        className="tb-neu-inset w-full rounded-lg bg-[#101118] p-2 text-xs"
      >
        <option value="default">
          {config.stableName} ({config.stableSymbol})
        </option>
        <option value="custom">Choose another token by contract address</option>
      </select>
      {custom ? (
        <div className="space-y-2">
          <label htmlFor={`${id}-token-address`} className="block text-xs text-white/70">
            Token contract on {config.name}
          </label>
          <input
            id={`${id}-token-address`}
            value={tokenAddress}
            maxLength={42}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setTokenAddress(e.target.value.trim());
              tokenLookup.reset();
              preview.reset();
              setAmount("");
            }}
            placeholder="0x…"
            className="tb-neu-inset w-full rounded-lg bg-[#101118] p-2 font-mono text-xs"
          />
          <button
            type="button"
            disabled={tokenLookup.isPending || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)}
            onClick={() => tokenLookup.mutate(tokenAddress)}
            className="tb-neu-raised min-h-11 rounded-xl px-3 text-xs text-cyan-200 disabled:opacity-40"
          >
            {tokenLookup.isPending ? "Reading token…" : "Inspect token contract"}
          </button>
          {tokenLookup.isError ? (
            <p role="alert" className="text-xs text-amber-200">
              {tokenLookup.error.message}
            </p>
          ) : null}
          {token ? (
            <p className="break-all text-xs text-cyan-200">
              {token.symbol} · {token.decimals} decimals · chain {token.chainId}
              <br />
              {token.address}
            </p>
          ) : null}
          <p className="text-[11px] text-amber-200">
            Contract metadata is not a safety check. Token names can be copied; inspect the address.
            Quotes and simulations do not guarantee future sellability. Transfer-tax and rebasing
            tokens are not supported by this route.
          </p>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {custom && direction === "stable_to_native" ? (
          <span
            aria-label="Unverified token identity"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-400/15 text-xs text-violet-200"
          >
            ?
          </span>
        ) : (
          <CoinBadge symbol={sell} size={22} />
        )}
        <span className="text-xs">
          {sell} → {buy}
        </span>
        {custom && direction === "native_to_stable" ? (
          <span
            aria-label="Unverified token identity"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-400/15 text-xs text-violet-200"
          >
            ?
          </span>
        ) : (
          <CoinBadge symbol={buy} size={22} />
        )}
      </div>
      <label htmlFor={`${id}-direction`} className="block text-xs text-white/70">
        Swap direction
      </label>
      <select
        id={`${id}-direction`}
        value={direction}
        onChange={(e) => {
          setDirection(e.target.value as typeof direction);
          setAmount("");
          preview.reset();
        }}
        className="tb-neu-inset w-full rounded-lg bg-[#101118] p-2 text-xs"
      >
        <option value="native_to_stable">
          {config.gas} → {tokenSymbol}
        </option>
        <option value="stable_to_native">
          {tokenSymbol} → {config.gas}
        </option>
      </select>
      <label htmlFor={`${id}-amount`} className="block text-xs text-white/70">
        Amount to sell ({sell})
      </label>
      <input
        id={`${id}-amount`}
        inputMode="decimal"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          preview.reset();
        }}
        placeholder="0.00"
        maxLength={48}
        className="tb-neu-inset w-full rounded-lg bg-[#101118] p-2 text-xs"
      />
      <label htmlFor={`${id}-slippage`} className="block text-xs text-white/70">
        Slippage tolerance
      </label>
      <select
        id={`${id}-slippage`}
        value={slippageBps}
        onChange={(e) => {
          setSlippageBps(Number(e.target.value));
          preview.reset();
        }}
        className="tb-neu-inset w-full rounded-lg bg-[#101118] p-2 text-xs"
      >
        <option value={10}>0.1%</option>
        <option value={50}>0.5%</option>
        <option value={100}>1%</option>
        <option value={300}>3%</option>
        <option value={500}>5%</option>
      </select>
      <button
        type="button"
        disabled={!validAmount || preview.isPending}
        onClick={() => preview.mutate(input)}
        className="tb-neu-raised min-h-11 w-full rounded-xl px-3 py-2 text-xs text-cyan-100 disabled:opacity-40"
      >
        {preview.isPending ? "Checking pools and wallet…" : "Preview swap & check wallet"}
      </button>
      {preview.isError ? (
        <p role="alert" className="text-xs text-amber-200">
          {preview.error instanceof Error
            ? preview.error.message
            : "Network preflight unavailable. Retry."}
        </p>
      ) : null}
      {result ? (
        <div aria-live="polite" className="space-y-2 text-xs">
          <p className="text-cyan-200">
            Quote: {result.buyAmount} {result.buySymbol}
          </p>
          <p>
            Minimum: {result.minimumReceived} {result.buySymbol}
          </p>
          <p className="text-white/60">
            Pool fee {result.feeBps / 100}% · best output from {result.quotedPools} quotable direct
            pools, before gas
          </p>
          <p className="text-white/60">
            Wallet: {result.nativeBalance} {config.gas} · {result.stableBalance}{" "}
            {result.token.symbol}
          </p>
          <p className={result.simulation === "passed" ? "text-emerald-200" : "text-amber-200"}>
            Transaction simulation: {result.simulation}
          </p>
          {result.estimatedNetworkFee ? (
            <p className="text-white/60">
              Estimated execution gas: {result.estimatedNetworkFee} {config.gas}
              {network === "base" ? " (L1 data fee not included)" : ""}. Not a guaranteed fee.
            </p>
          ) : null}
          {result.blockers.length ? (
            <ul className="space-y-1 text-amber-200">
              {result.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-[10px] text-white/50">
            Block {result.block} · {new Date(result.checkedAt).toLocaleString()}. Snapshot only;
            always refresh before execution.
          </p>
          <a
            href={`${config.explorer}${result.pool}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-cyan-200"
          >
            Inspect quoted pool <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
      <BlockchainSwapExecution request={input} provider={wallet.provider} valid={validAmount} />
    </section>
  );
}
