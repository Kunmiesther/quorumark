import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { readSynFuturesRegistration } from "@/lib/exchanges/synfutures/registration.functions";
import { connectSynFuturesAccount, readSynFuturesConnection } from "@/lib/exchanges/synfutures/connection.functions";
import { SynFuturesSetupForm } from "./SynFuturesSetupForm";
import { SynFuturesRecovery } from "./SynFuturesRecovery";
import { SynFuturesActivation } from "./SynFuturesActivation";
import { SynFuturesDeployment } from "./SynFuturesDeployment";

/** Resolve owned registration before offering any deployment flow. */
export function SynFuturesAccountSetup({
  userId, walletId, provider, owner,
}: {
  userId: string; walletId: string; provider: string; owner: string;
}) {
  const client = useQueryClient();
  const connectionKey = ["synfutures-account-connection", userId, walletId];
  const headers = async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Sign in to connect SynFutures.");
    return { Authorization: `Bearer ${data.session.access_token}` };
  };
  const connection = useQuery({
    queryKey: connectionKey,
    queryFn: async () => readSynFuturesConnection({ data: { walletId }, headers: await headers() }),
    retry: false,
  });
  const connect = useMutation({
    mutationFn: async () => connectSynFuturesAccount({ data: { walletId }, headers: await headers() }),
    retry: false,
    onSuccess: (value) => {
      client.setQueryData(connectionKey, value);
      for (const key of ["exchange-connections", "exchange-connections-full", "exchange-health",
        "exchange-wallet-identities", "trade-bays-connections", "portfolio-totals"]) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  const connected = connection.data?.status === "verified" && connection.data.permission_read === true;
  const registration = useQuery({
    queryKey: ["synfutures-account-registration", userId, walletId],
    queryFn: async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to load your SynFutures account.");
      const value = await readSynFuturesRegistration({
        data: { walletId },
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      if (value && (value.wallet_id !== walletId ||
          value.owner_address.toLowerCase() !== owner.toLowerCase() || value.chain_id !== 8453)) {
        throw new Error("Account identity mismatch. Reload before continuing.");
      }
      return value;
    },
    retry: false,
  });

  // Loading, failed, or missing data are never treated as an undeployed account.
  if (registration.isPending || registration.isError || registration.data === undefined) {
    return <div className="mt-4 border-t border-white/10 pt-3">
      <p role={registration.isError ? "alert" : "status"} className="text-xs text-amber-200">
        {registration.isError
          ? "Existing account status unavailable. Retry before continuing; deployment is withheld."
          : "Checking your existing SynFutures account…"}
      </p>
      {registration.isError ? <button type="button" onClick={() => void registration.refetch()}
        disabled={registration.isFetching}
        className="tb-neu-raised mt-2 rounded-xl px-3 py-2 text-xs text-white/65">
        Retry account lookup
      </button> : null}
    </div>;
  }
  if (registration.data) {
    return <div className="mt-4 border-t border-white/10 pt-3">
      <h3 className="text-sm font-medium text-cyan-200">Existing SynFutures account</h3>
      <p role="status" className="mt-2 text-xs text-cyan-200">
        {connected ? connection.data?.is_live ? "SynFutures connected · trading enabled" : "SynFutures connected · account reads enabled · trading off" : "Account registered · not connected"}
      </p>
      <button type="button" onClick={() => connect.mutate()}
        disabled={connect.isPending || connection.isPending || connection.isError}
        className="tb-neu-raised mt-3 rounded-xl px-4 py-2 text-xs text-violet-200 disabled:opacity-50">
        {connect.isPending ? "Verifying and connecting…" : connected ? "Refresh SynFutures connection" : "Connect SynFutures"}
      </button>
      {connection.isError ? <div role="alert" className="mt-2 text-xs text-amber-200">
        Connection status unavailable.
        <button type="button" onClick={() => void connection.refetch()} className="ml-2 underline">Retry connection status</button>
      </div> : null}
      {connect.isError ? <p role="alert" className="mt-2 text-xs text-amber-200">{connect.error.message}</p> : null}
      <div className="mt-2 space-y-1 break-all text-xs text-white/60">
        <p>Trading account: {registration.data.safe_address}</p>
        <p>Module: {registration.data.module_address}</p>
        <p>Registered {new Date(registration.data.verified_at).toLocaleString()}</p>
      </div>
      <p className="mt-2 text-xs leading-5 text-white/65">
        Use “Check wallet readiness” above to refresh balances, positions and activation requirements.
        Your existing account does not need redeployment.
      </p>
      <p className="mt-2 text-xs leading-5 text-amber-200">
        {connection.data?.is_live ? "Trading is enabled. The operator session, gas reserve and campaign limits are checked again before every entry."
          : "Complete the activation flow below to fund the account, authorize the operator and verify live trading."}
      </p>
      {connected && connection.data?.id ? <SynFuturesRecovery userId={userId} connectionId={connection.data.id}
        provider={provider} owner={owner} safe={registration.data.safe_address} module={registration.data.module_address} /> : null}
      {connected && connection.data?.id ? <SynFuturesActivation userId={userId} walletId={walletId} connectionId={connection.data.id}
        provider={provider} owner={owner} safe={registration.data.safe_address} module={registration.data.module_address} live={connection.data.is_live === true} /> : null}
      <button type="button" onClick={() => void registration.refetch()}
        disabled={registration.isFetching}
        className="tb-neu-raised mt-2 rounded-xl px-3 py-2 text-xs text-white/65">
        {registration.isFetching ? "Refreshing account…" : "Refresh account registration"}
      </button>
    </div>;
  }
  return <>
    <SynFuturesSetupForm walletId={walletId} userId={userId} />
    <SynFuturesDeployment userId={userId} walletId={walletId} provider={provider} owner={owner} />
  </>;
}
