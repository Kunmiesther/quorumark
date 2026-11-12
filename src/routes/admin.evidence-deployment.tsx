import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { quorumarkApi, getWalletSession } from "@/lib/quorumark-api";
import { getNearSelector } from "@/lib/wallet/near";
import {
  EVIDENCE_CONTRACT_ACCOUNT,
  EVIDENCE_CONTRACT_OWNER,
  EVIDENCE_CONTRACT_FUNDING_YOCTO,
  assertChildSignerCapability,
  prepareEvidenceAccountCreation,
  prepareEvidenceContractDeployment,
} from "@/lib/near-evidence-contract-deployment";

export const Route = createFileRoute("/admin/evidence-deployment")({
  ssr: false,
  component: EvidenceDeploymentPage,
  head: () => ({ meta: [{ title: "Evidence deployment · Quorumark" }] }),
});

type DeploymentStatus = {
  authorized_account: string;
  child_account: string;
  parent_balance_yocto: string | null;
  child_exists: boolean;
  child_balance_yocto: string | null;
  wallet_full_access_key_matches: boolean;
  code_hash: string | null;
  initialized: boolean;
  owner_id: string | null;
};

function EvidenceDeploymentPage() {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [message, setMessage] = useState("Checking the authorized wallet and testnet account…");
  const [busy, setBusy] = useState<"account" | "contract" | null>(null);
  const [lastTransaction, setLastTransaction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = getWalletSession();
    if (!session?.verified || session.address !== EVIDENCE_CONTRACT_OWNER) {
      setMessage("Verify estarkunmi.testnet first, then return to this page.");
      return;
    }
    const selector = await getNearSelector();
    const account = selector.store.getState().accounts?.[0];
    if (!account || account.accountId !== EVIDENCE_CONTRACT_OWNER) {
      setAccountId(account?.accountId ?? null);
      setMessage("Connect the authorized estarkunmi.testnet wallet to continue.");
      return;
    }
    setAccountId(account.accountId);
    setPublicKey(account.publicKey ?? null);
    const next = await quorumarkApi<DeploymentStatus>("/v1/admin/evidence-deployment/status", {
      method: "POST",
      body: JSON.stringify({ public_key: account.publicKey }),
    });
    setStatus(next);
    setMessage(next.initialized ? "The evidence contract is initialized. This deployment page is no longer active." : "The deployment checks are ready.");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : "We couldn't check the deployment status."));
  }, [refresh]);

  async function approveAccountCreation() {
    if (!accountId || !publicKey) return;
    setBusy("account");
    setMessage("Review the account-creation request in Meteor Wallet.");
    try {
      const selector = await getNearSelector();
      const wallet = await selector.wallet();
      assertChildSignerCapability(wallet);
      const plan = prepareEvidenceAccountCreation(accountId, EVIDENCE_CONTRACT_ACCOUNT, publicKey);
      const outcomes = await wallet.signAndSendTransactions({ transactions: [plan] });
      const hash = outcomes?.[0]?.transaction?.hash;
      if (hash) setLastTransaction(hash);
      setMessage("Account creation was approved. Verifying the child account through NEAR RPC…");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The account-creation request was not completed.");
    } finally {
      setBusy(null);
    }
  }

  async function approveContractDeployment() {
    setBusy("contract");
    setMessage("Review the contract deployment and initialization request in Meteor Wallet.");
    try {
      const response = await fetch("/quorumark_publication_evidence.wasm");
      if (!response.ok) throw new Error("The evidence contract package is unavailable.");
      const selector = await getNearSelector();
      const wallet = await selector.wallet();
      assertChildSignerCapability(wallet);
      const plan = prepareEvidenceContractDeployment(new Uint8Array(await response.arrayBuffer()));
      const outcomes = await wallet.signAndSendTransactions({ transactions: [plan] });
      const hash = outcomes?.[0]?.transaction?.hash;
      if (hash) setLastTransaction(hash);
      setMessage("Deployment was approved. Verifying code and initialization through NEAR RPC…");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The deployment request was not completed.");
    } finally {
      setBusy(null);
    }
  }

  const ownerReady = accountId === EVIDENCE_CONTRACT_OWNER;
  const childReady = Boolean(status?.child_exists && status.wallet_full_access_key_matches);

  return (
    <main className="q-connect-page">
      <header className="q-connect-header">
        <Link to="/" aria-label="Return to Quorumark home"><strong>QUORUMARK</strong></Link>
        <Link to="/verification" className="q-connect-back">Back to verification</Link>
      </header>
      <section className="q-connect-card" aria-labelledby="deployment-title">
        <p className="q-kicker">Owner-only testnet setup</p>
        <h1 id="deployment-title">Prepare the evidence contract</h1>
        <p>This temporary page can only be used by the verified estarkunmi.testnet account. It never asks for a private key.</p>
        <div className="q-connected-state" style={{ marginTop: 24 }}>
          {ownerReady ? <Check size={20} /> : <ShieldCheck size={20} />}
          <div><strong>{accountId ?? "Wallet not verified"}</strong><span>{message}</span></div>
          <button className="q-secondary" onClick={() => refresh().catch((error) => setMessage(error instanceof Error ? error.message : "We couldn't refresh the deployment checks."))} disabled={busy !== null}>Refresh checks</button>
        </div>
        {status && !status.initialized && (
          <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
            <div className="q-wallet-primary">
              <h2>1. Create the contract account</h2>
              <p>Signer: <strong>estarkunmi.testnet</strong><br />Receiver: <strong>evidence.estarkunmi.testnet</strong><br />Funding: <strong>1.8 testnet NEAR</strong><br />Network: <strong>NEAR testnet</strong></p>
              <button className="q-primary q-full" onClick={approveAccountCreation} disabled={busy !== null || status.child_exists}>
                {busy === "account" ? <Loader2 className="q-spin" size={16} /> : <WalletCards size={16} />} {status.child_exists ? "Account already exists" : "Approve account creation"}
              </button>
            </div>
            <div className="q-wallet-primary">
              <h2>2. Deploy and initialize</h2>
              <p>Signer: <strong>evidence.estarkunmi.testnet</strong><br />Actions: <strong>DeployContract, then new</strong><br />Owner: <strong>estarkunmi.testnet</strong><br />Deposit: <strong>0 NEAR</strong></p>
              <button className="q-primary q-full" onClick={approveContractDeployment} disabled={busy !== null || !childReady || status.initialized}>
                {busy === "contract" ? <Loader2 className="q-spin" size={16} /> : <WalletCards size={16} />} Approve deployment and initialization
              </button>
              {!childReady && <small>Waiting for RPC confirmation that the child has the wallet-controlled FullAccess key.</small>}
            </div>
          </div>
        )}
        {status?.initialized && <div className="q-connected-state" style={{ marginTop: 24 }}><Check size={20} /><div><strong>Contract ready</strong><span>Owner verified as {status.owner_id}</span></div></div>}
        {lastTransaction && <p className="q-connect-note">Latest confirmed transaction: {lastTransaction}</p>}
      </section>
    </main>
  );
}
