import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { WalletIdentity } from "@/components/exchanges/ConnectionIdentity";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { SectionHeading } from "./primitives";
import { supabase } from "@/integrations/supabase/client";
import {
  inspectSynFuturesSdk,
  inspectSynFuturesWallet,
} from "@/lib/exchanges/synfutures.functions";
import { venueLogo } from "@/lib/venue-logos";
import { SynFuturesQuotePanel } from "./SynFuturesQuotePanel";
import { SynFuturesAccountSetup } from "./SynFuturesAccountSetup";

const BLOCKERS: Record<string, string> = {
  SAFE_NOT_DEPLOYED: "The trading Safe must be deployed.",
  MODULE_NOT_DEPLOYED: "The trading module must be deployed.",
  COLLATERAL_UNVERIFIED: "Trading-account collateral could not be verified.",
  ENTRY_COLLATERAL_REQUIRED: "No unallocated entry collateral is recorded at the Gate.",
  SESSION_UNVERIFIED: "The operator session could not be verified.",
  MODULE_NOT_ENABLED: "The owner has not enabled the module.",
  OPERATOR_NOT_AUTHORIZED: "No operator is authorized on-chain.",
  ENTRY_SESSION_UNAVAILABLE: "The entry session is expired, disabled, or its margin budget is exhausted.",
  EXIT_SESSION_UNVERIFIED: "Operator permission to reduce positions could not be verified.",
  EXIT_SESSION_UNAVAILABLE: "This module blocks operator exits when its session expires or is revoked. Owner recovery is required then.",
  MARKET_LIMITS_UNVERIFIED: "Market permissions could not be verified.",
  MARKET_ENTRIES_DISABLED: "No market has complete entry limits.",
  OPERATOR_GAS_UNVERIFIED: "The operator's Base gas balance could not be verified.",
  OPERATOR_GAS_REQUIRED: "The operator needs Base ETH for transaction fees.",
  AUTONOMOUS_EXECUTION_UNAVAILABLE: "Autonomous worker execution still requires integration.",
  PROTECTIVE_EXIT_UNAVAILABLE: "Automatic protective exits still require integration.",
  RPC_CHAIN_MISMATCH: "The RPC returned the wrong network.",
  OBSERVER_GATE_MISMATCH: "The observer does not belong to the expected SynFutures gate.",
  SDK_CONTRACT_MISSING: "A contract configured by the SDK has no deployed bytecode.",
  INSTRUMENT_SCAN_LIMIT: "The registry exceeds this diagnostic's scan limit.",
  INSTRUMENT_READ_INCOMPLETE: "Some instrument reads failed; the count is incomplete.",
  NO_LISTED_EXPIRIES: "No listed expiries were found in the instrument registry.",
  OBSERVER_READ_INCOMPATIBLE: "The SDK observer read failed. Contract compatibility needs repair.",
  PUBLIC_READ_FAILED: "The public read failed. Retry the check before relying on these results.",
  EXECUTION_ADAPTER_NOT_CONFIGURED:
    "Automated signing, order tracking and reconciliation are not connected yet.",
};

export function SynFuturesSdkPanel({ activationFirst = false }: { activationFirst?: boolean } = {}) {
  const { user } = useAuth();
  const walletSelectId = useId();
  const [walletId, setWalletId] = useState("");
  const wallets = useQuery({
    queryKey: ["synfutures-preflight-wallets", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wallet_connections")
        .select("id,provider,label,public_address,status,is_active")
        .eq("user_id", user!.id)
        .eq("status", "verified")
        .eq("is_active", true)
        .eq("chain", "ethereum")
        .eq("network", "mainnet");
      if (error) throw error;
      return data ?? [];
    },
  });
  const effectiveWalletId = walletId || (wallets.data?.length === 1 ? wallets.data[0].id : "");
  const selectedWallet = wallets.data?.find((wallet) => wallet.id === effectiveWalletId);
  const walletCheck = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to check your wallet.");
      return inspectSynFuturesWallet({
        data: { walletId: id },
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    },
  });
  const walletResult =
    selectedWallet?.public_address.toLowerCase() === walletCheck.data?.wallet_address
      ? walletCheck.data
      : undefined;
  const probe = useMutation({
    mutationFn: async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to run the SDK check.");
      return inspectSynFuturesSdk({
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    },
  });
  const result = probe.data;
  return (
    <SurfaceCard>
      <SectionHeading
        title={activationFirst ? "SynFutures trading activation" : "SynFutures account"}
        subtitle="Base network · account status and activation"
        actions={<img src={venueLogo("synfutures")} alt="" className="h-7 w-7 object-contain" />}
      />
      {activationFirst && selectedWallet && user ? (
        <SynFuturesAccountSetup
          key={`activation:${user.id}:${effectiveWalletId}`}
          userId={user.id} walletId={effectiveWalletId}
          provider={selectedWallet.provider} owner={selectedWallet.public_address}
        />
      ) : null}
      <p className="text-xs leading-5 text-white/60">
        Check deployed contracts and instrument discovery using SDK 0.2.4. This check does not
        connect a wallet, approve tokens, transfer funds or submit orders.
      </p>
      <button
        type="button"
        disabled={probe.isPending}
        onClick={() => probe.mutate()}
        className="tb-neu-raised mt-3 rounded-xl px-4 py-2.5 text-xs text-violet-200 disabled:opacity-50"
      >
        {probe.isPending ? "Checking SynFutures contracts…" : "Check SynFutures SDK"}
      </button>
      {probe.isError ? (
        <p role="alert" className="mt-3 text-xs text-amber-200">
          SDK check unavailable. Confirm your owner/admin session, then retry.
        </p>
      ) : null}
      <div className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.03] p-3">
        <h3 className="text-sm font-medium text-cyan-200">Check a connected wallet on Base</h3>
        <label htmlFor={walletSelectId} className="mt-2 block text-xs text-white/65">
          Verified wallet
        </label>
        <select
          id={walletSelectId}
          value={effectiveWalletId}
          onChange={(event) => {
            setWalletId(event.target.value);
            walletCheck.reset();
          }}
          className="tb-neu-inset mt-1 w-full rounded-xl bg-[#101118] px-3 py-2 text-xs text-white"
        >
          <option value="">Choose a wallet</option>
          {(wallets.data ?? []).map((wallet) => (
            <option key={wallet.id} value={wallet.id}>
              {wallet.label || wallet.provider} · {wallet.public_address}
            </option>
          ))}
        </select>
        {wallets.isError ? (
          <p role="alert" className="mt-2 text-xs text-amber-200">
            Wallet list unavailable. Reload to retry.
          </p>
        ) : null}
        {!wallets.isLoading && !wallets.isError && !wallets.data?.length ? (
          <p className="mt-2 text-xs text-white/60">
            Connect and verify a wallet in Wallets first.
          </p>
        ) : null}
        {selectedWallet ? (
          <div className="mt-3">
            <WalletIdentity wallet={selectedWallet} />
          </div>
        ) : null}
        <button
          type="button"
          disabled={!selectedWallet || walletCheck.isPending}
          onClick={() => walletCheck.mutate(effectiveWalletId)}
          className="tb-neu-raised mt-3 rounded-xl px-4 py-2 text-xs text-cyan-200 disabled:opacity-50"
        >
          {walletCheck.isPending ? "Reading Base balances…" : "Check wallet readiness"}
        </button>
        {walletCheck.isError ? (
          <p role="alert" className="mt-2 text-xs text-amber-200">
            Wallet check unavailable. Confirm the wallet is still verified, then retry. No
            transaction was sent.
          </p>
        ) : null}
        {walletResult ? (
          <div aria-live="polite" className="mt-3 space-y-2 text-xs">
            <p className={walletResult.gas?.present ? "text-emerald-200" : "text-amber-200"}>
              Base gas:{" "}
              {walletResult.gas
                ? `${walletResult.gas.balance} ETH${walletResult.gas.present ? " (present; transaction cost not estimated)" : " — no gas balance"}`
                : "unavailable"}
            </p>
            {!walletResult.contracts_verified ? (
              <p className="text-amber-200">Contracts not verified; quote-token checks withheld.</p>
            ) : null}
            {walletResult.quotes.map((quote) => (
              <div key={quote.token} className="tb-neu-inset rounded-lg p-2">
                <p title={quote.token} className="font-mono text-white/80">
                  {quote.symbol || `${quote.token.slice(0, 6)}…${quote.token.slice(-4)}`}
                </p>
                <p className="mt-1 break-all text-white/65">
                  Wallet balance: {quote.balance ?? "unavailable"} · Gate allowance:{" "}
                  {quote.gate_allowance ?? "unavailable"}
                </p>
              </div>
            ))}
            <p className="leading-5 text-white/55">{walletResult.note}</p>
            {walletResult.trading_account ? <div>
              <p className="font-medium text-white/80">SynFutures positions</p>
              {walletResult.trading_account.positions ? <ul className="mt-1 space-y-1">
                {walletResult.trading_account.positions.map(position => <li key={position.symbol}>
                  {position.symbol}: {position.has_exposure ? `signed size ${position.base_size_signed}; position balance ${position.balance_usdc} USDC` : "no open exposure"}
                </li>)}
              </ul> : <p className="mt-1 text-amber-200">Position reads unavailable; the account is not assumed flat.</p>}
            </div> : null}
            {walletResult.trading_account?.readiness ? <div>
              <p className="font-medium text-amber-200">SynFutures activation requirements</p>
              <ul className="mt-1 space-y-1">
                {walletResult.trading_account.readiness.blockers.map(code => <li key={code}>{BLOCKERS[code] ?? code}</li>)}
              </ul>
              <p className="mt-2 text-white/45">Observed at Base block {walletResult.trading_account.observed_block}. Deployment alone does not enable trading.</p>
            </div> : null}
            <p className="text-white/45">
              Read {new Date(walletResult.checked_at).toLocaleString()} · no approval or transfer
              sent
            </p>
          </div>
        ) : null}
      </div>
      {!activationFirst && selectedWallet && user ? (
        <SynFuturesAccountSetup
          key={`account:${user.id}:${effectiveWalletId}`}
          userId={user.id}
          walletId={effectiveWalletId}
          provider={selectedWallet.provider}
          owner={selectedWallet.public_address}
        />
      ) : null}
      {result ? (
        <div className="mt-4 space-y-3" aria-live="polite">
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            {[
              ["Network", result.chain_id === 8453 ? "Base" : (result.chain_id ?? "Unknown")],
              ["Contracts", result.contracts_deployed ? "Bytecode found" : "Not verified"],
              ["Registered instruments", result.instrument_count ?? "Unknown"],
              ["With listed expiries", result.instruments_with_expiry ?? "Unknown"],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-white/45">{label}</dt>
                <dd className="mt-1 break-words text-white/85">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-white/45">
            Listed expiries do not prove liquidity or trade readiness.
          </p>
          {result.markets.length ? (
            <div className="flex flex-wrap gap-2" aria-label="Discovered SynFutures instruments">
              {result.markets.map((market) => (
                <span
                  key={market.instrument}
                  title={market.instrument}
                  className="rounded-lg bg-white/5 px-2 py-1 text-xs text-white/75"
                >
                  {market.symbol}
                </span>
              ))}
            </div>
          ) : null}
          {result.observer_read_compatible && result.markets.length ? (
            <SynFuturesQuotePanel markets={result.markets} />
          ) : null}
          <ul className="space-y-1 text-xs leading-5 text-amber-200">
            {result.blockers.map((code) => (
              <li key={code}>{BLOCKERS[code] ?? code}</li>
            ))}
          </ul>
          <p className="text-[10px] text-white/40">
            Checked {new Date(result.checked_at).toLocaleString()} · {result.latency_ms} ms
          </p>
        </div>
      ) : null}
    </SurfaceCard>
  );
}
