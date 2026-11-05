import { useEffect, useId, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  prepareBlockchainSwap,
  claimBlockchainSwap,
  trackBlockchainSwap,
  listBlockchainSwaps,
  declineBlockchainSwap,
} from "@/lib/blockchain/transactions.functions";
import { getTransactionProvider } from "@/lib/wallet/providers";
import {
  checkSigningWallet,
  submitReviewedTransaction,
  WalletSubmissionError,
} from "@/lib/blockchain/walletTransaction";
import { SPOT_ROUTES, spotToken, type SpotRequest } from "@/lib/blockchain/spot";
import { sameSwapRequest, type SwapRecord } from "@/lib/blockchain/transactions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in to review this swap.");
  return { Authorization: `Bearer ${data.session.access_token}` };
}
const buttonClass =
  "tb-neu-raised min-h-11 rounded-xl px-3 py-2 text-xs text-cyan-100 disabled:opacity-40";
const actionText = {
  swap: "Swap",
  approve: "Approve exact amount",
  reset_approval: "Reset existing allowance to zero",
};
function recoveryKey(id: string) {
  return `turtlebot:swap-hash:v1:${id}`;
}

/** Wallet-owned signing, with no automatic execution from renders, effects or callbacks. */
export function BlockchainSwapExecution({
  request,
  provider,
  valid,
}: {
  request: SpotRequest;
  provider: string;
  valid: boolean;
}) {
  const id = useId();
  const [record, setRecord] = useState<SwapRecord | null>(null);
  const [history, setHistory] = useState<SwapRecord[]>([]);
  const [historyScope, setHistoryScope] = useState("");
  const scope = `${request.network}:${request.walletId}`;
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const reviewLifetime = useRef({ current: true });
  // This effect only invalidates work; it never starts a wallet operation.
  useEffect(() => {
    const lifetime = { current: true };
    reviewLifetime.current = lifetime;
    return () => {
      lifetime.current = false;
    };
  }, [
    request.network,
    request.walletId,
    request.direction,
    request.amount,
    request.slippageBps,
    request.token?.address,
    request.token?.decimals,
    request.token?.symbol,
    request.token?.chainId,
    provider,
    valid,
    acknowledged,
  ]);
  // History remains inspectable even if the amount/direction in the form changed.
  // Signing still requires an exact match with the current form.
  const active =
    record?.plan.request.walletId === request.walletId &&
    record.plan.request.network === request.network
      ? record
      : null;
  const config = SPOT_ROUTES[active?.plan.request.network ?? request.network];
  const selectedToken = active ? spotToken(active.plan.request) : null;
  const matches = !!active && sameSwapRequest(active.plan.request, request);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Request unavailable. Check wallet activity before retrying.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    const rows = await listBlockchainSwaps({
      data: { walletId: request.walletId, network: request.network },
      headers: await authHeaders(),
    });
    setHistory(rows);
    setHistoryScope(scope);
  }
  async function track(row: SwapRecord, hash: string) {
    const updated = await trackBlockchainSwap({
      data: { id: row.id, hash },
      headers: await authHeaders(),
    });
    setRecord(updated);
    await refresh();
    if (["confirmed", "reverted", "cancelled"].includes(updated.status)) {
      try {
        localStorage.removeItem(recoveryKey(row.id));
      } catch {
        /* optional recovery cache */
      }
    }
  }
  return (
    <div className="space-y-3 border-t border-white/10 pt-3 text-xs">
      <p className="text-white/65">
        Manual wallet trading · no leverage. Each approval and swap requires its own wallet
        confirmation.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!valid || busy}
          onClick={() =>
            void run(async () => {
              setAcknowledged(false);
              setRecord(null);
              const row = await prepareBlockchainSwap({
                data: { ...request, requestId: crypto.randomUUID() },
                headers: await authHeaders(),
              });
              setRecord(row);
              setRecoveryHash("");
            })
          }
        >
          {busy ? "Working…" : "Prepare wallet review"}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          Transaction journal
        </button>
      </div>
      {message ? (
        <p role="alert" className="break-words text-amber-200">
          {message}
        </p>
      ) : null}
      {active ? (
        <div
          className="tb-neu-inset space-y-2 rounded-xl p-3"
          aria-label="Wallet transaction review"
        >
          <p className="text-cyan-200">
            {actionText[active.plan.action]} · {config.name}
          </p>
          <p className="break-all">Wallet: {active.plan.owner}</p>
          <p>
            {active.plan.request.amount}{" "}
            {active.plan.request.direction === "native_to_stable"
              ? config.gas
              : selectedToken?.symbol}
          </p>
          {active.plan.action === "swap" ? (
            <p>
              Minimum received: {active.plan.minimumReceived}{" "}
              {active.plan.request.direction === "native_to_stable"
                ? selectedToken?.symbol
                : config.gas}
            </p>
          ) : (
            <p className="text-amber-200">
              Approval is not a swap. Prepare again after confirmation. Resetting allowance grants
              no spending permission.
            </p>
          )}
          <p className="break-all text-white/55">Token contract: {selectedToken?.address}</p>
          <p className="break-all text-white/55">
            {active.plan.action === "swap" ? "Router" : "Token"}: {active.plan.transaction.to}
          </p>
          <p>
            Estimated execution gas: {active.plan.estimatedNetworkFee} {config.gas}
            {request.network === "base" ? " · L1 fee additional" : ""}. Your wallet shows the final
            fee.
          </p>
          {active.plan.review ? (
            <div className="space-y-2">
              <p className="text-violet-200">
                Council called · {active.plan.review.availableRoles.length}/3 seats answered ·
                advisory only
              </p>
              {active.plan.review.outcomes.map((outcome) => (
                <p key={outcome.role}>
                  <strong>{outcome.role}:</strong>{" "}
                  {outcome.available ? outcome.response.summary : `Unavailable: ${outcome.reason}`}
                </p>
              ))}
            </div>
          ) : null}
          <p>Status: {active.status}</p>
          {active.status === "prepared" ? (
            <>
              {!matches ? (
                <p className="text-amber-200">
                  The form differs from this saved review. Prepare a new review to sign your current
                  amount and direction.
                </p>
              ) : null}
              <p className="text-white/55">
                Review valid until {new Date(active.plan.expiresAt).toLocaleTimeString()}.
              </p>
              <label htmlFor={`${id}-confirm`} className="flex items-start gap-2">
                <input
                  id={`${id}-confirm`}
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I reviewed the chain, wallet, amount, fees and{" "}
                {active.plan.action === "swap" ? "Council responses" : "router allowance"}. This
                uses real funds.
              </label>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !acknowledged || !matches || !valid}
                onClick={() =>
                  void run(async () => {
                    if (!matches || !valid) throw new Error("Form changed. Prepare a new review.");
                    const lifetime = reviewLifetime.current;
                    const walletProvider = await getTransactionProvider(provider);
                    await checkSigningWallet(walletProvider, active.plan);
                    const plan = await claimBlockchainSwap({
                      data: { id: active.id },
                      headers: await authHeaders(),
                    });
                    const claimed: SwapRecord = { ...active, status: "signing" };
                    setRecord(claimed);
                    let hash: `0x${string}`;
                    try {
                      hash = await submitReviewedTransaction(
                        walletProvider,
                        plan,
                        () => lifetime.current,
                      );
                    } catch (error) {
                      if (error instanceof WalletSubmissionError && error.definitelyNotSent) {
                        await declineBlockchainSwap({
                          data: { id: active.id },
                          headers: await authHeaders(),
                        });
                        setRecord({ ...claimed, status: "declined" });
                      }
                      throw error;
                    }
                    setRecoveryHash(hash);
                    setRecord({ ...claimed, status: "submitted", tx_hash: hash });
                    try {
                      localStorage.setItem(recoveryKey(active.id), hash);
                    } catch {
                      /* hash remains visible */
                    }
                    await track(claimed, hash);
                  })
                }
              >
                Confirm in {provider} wallet
              </button>
            </>
          ) : null}
          {active.status === "signing" || active.status === "submitted" ? (
            <>
              <p className="text-amber-200">
                Check your wallet activity. Paste its transaction hash to recover tracking,
                including a wallet speed-up or cancellation hash. Do not send the swap again.
              </p>
              <label htmlFor={`${id}-hash`}>Transaction hash</label>
              <input
                id={`${id}-hash`}
                className="tb-neu-inset w-full rounded-lg p-2"
                value={recoveryHash}
                onChange={(event) => setRecoveryHash(event.target.value.trim())}
              />
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)}
                onClick={() => void run(() => track(active, recoveryHash))}
              >
                Recover receipt
              </button>
            </>
          ) : null}
          {active.tx_hash ? (
            <>
              {!active.hash_verified ? (
                <p className="text-amber-200">
                  Reported hash · transaction identity not yet verified on chain.
                </p>
              ) : null}
              <a
                className="block break-all text-cyan-200 underline"
                target="_blank"
                rel="noopener noreferrer"
                href={`${config.explorer.replace("/address/", "/tx/")}${active.tx_hash}`}
              >
                {active.tx_hash}
              </a>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => void run(() => track(active, active.tx_hash!))}
              >
                Check receipt
              </button>
            </>
          ) : null}
          {active.previous_hashes.map((hash) => (
            <a
              key={hash}
              className="block break-all text-white/55 underline"
              target="_blank"
              rel="noopener noreferrer"
              href={`${config.explorer.replace("/address/", "/tx/")}${hash}`}
            >
              Previous hash: {hash}
            </a>
          ))}
          {active.receipt ? (
            <p>
              Block {active.receipt.block} · {active.receipt.confirmations} confirmations ·{" "}
              {active.receipt.feeComplete
                ? "recorded network fee"
                : "execution fee only; L1 data fee unavailable"}{" "}
              {active.receipt.feeNative} {config.gas}. Confirmation is not a profitability result.
            </p>
          ) : null}
        </div>
      ) : null}
      {historyScope === scope && !history.length ? (
        <p role="status" className="text-white/60">
          No wallet transactions recorded on {config.name} yet.
        </p>
      ) : null}
      {historyScope === scope && history.length ? (
        <ul aria-label="Recent wallet transactions" className="space-y-2">
          {history.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="w-full rounded-lg border border-white/10 p-2 text-left"
                disabled={busy}
                onClick={() => {
                  setRecord(row);
                  setAcknowledged(false);
                  try {
                    setRecoveryHash(localStorage.getItem(recoveryKey(row.id)) ?? "");
                  } catch {
                    setRecoveryHash("");
                  }
                  setMessage("");
                }}
              >
                {actionText[row.plan.action]} · {row.plan.request.amount} · {row.status}
              </button>
              {row.tx_hash ? (
                <a
                  className="text-cyan-200 underline"
                  target="_blank"
                  rel="noopener noreferrer"
                  href={`${config.explorer.replace("/address/", "/tx/")}${row.tx_hash}`}
                >
                  View transaction
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-white/50">
        Autonomous blockchain strategies are not armed by these controls. A submitted hash is not
        confirmation. Status checks verify the exact wallet transaction on the selected chain.
      </p>
    </div>
  );
}
