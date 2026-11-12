import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { quorumarkApi, getWalletSession } from "@/lib/quorumark-api";
import { ensureBrowserPolyfills } from "@/lib/browser-polyfills";
import { getNearSelector } from "@/lib/wallet/near";
import { EVIDENCE_CONTRACT_ACCOUNT, EVIDENCE_CONTRACT_OWNER, prepareEvidenceContractDeployment } from "@/lib/near-evidence-contract-deployment";

export const Route = createFileRoute("/admin/evidence-deployment")({
  ssr: false,
  component: EvidenceDeploymentPage,
  head: () => ({ meta: [{ title: "Evidence deployment · Quorumark" }] }),
});

type DeploymentStatus = {
  authorized_account: string;
  account_id: string;
  balance_yocto: string | null;
  account_exists: boolean;
  code_hash: string | null;
  initialized: boolean;
  owner_id: string | null;
};

function EvidenceDeploymentPage() {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [message, setMessage] = useState("Checking the authorized wallet and testnet account...");
  const [busy, setBusy] = useState(false);
  const [lastTransaction, setLastTransaction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = getWalletSession();
    if (!session?.verified || session.address !== EVIDENCE_CONTRACT_OWNER) {
      setMessage("Verify estarkunmi.testnet first, then return to this page.");
      return;
    }
    await ensureBrowserPolyfills();
    const selector = await getNearSelector();
    const account = selector.store.getState().accounts?.[0];
    if (!account || account.accountId !== EVIDENCE_CONTRACT_OWNER) {
      setAccountId(account?.accountId ?? null);
      setMessage("Connect the authorized estarkunmi.testnet wallet to continue.");
      return;
    }
    setAccountId(account.accountId);
    const next = await quorumarkApi<DeploymentStatus>("/v1/admin/evidence-deployment/status", {
      method: "POST",
      body: JSON.stringify({}),
    });
    setStatus(next);
    setMessage(next.initialized ? "The evidence contract is initialized." : "The deployment checks are ready.");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : "We couldn't check the deployment status."));
  }, [refresh]);

  async function approveContractDeployment() {
    setBusy(true);
    setMessage("Review the deployment and initialization request in Meteor Wallet.");
    try {
      await ensureBrowserPolyfills();
      const response = await fetch("/quorumark_publication_evidence.wasm");
      if (!response.ok) throw new Error("The evidence contract package is unavailable.");
      const selector = await getNearSelector();
      const wallet = await selector.wallet();
      if (!wallet.signAndSendTransaction) throw new Error("The selected wallet cannot approve this NEAR testnet transaction.");
      const plan = prepareEvidenceContractDeployment(new Uint8Array(await response.arrayBuffer()));
      const outcome = await wallet.signAndSendTransaction(plan);
      const hash = outcome?.transaction?.hash;
      if (!hash) throw new Error("The wallet did not return a verifiable transaction outcome.");
      setLastTransaction(hash);
      setMessage("The transaction was approved. Verifying deployment through NEAR RPC...");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The deployment request was not completed.");
    } finally {
      setBusy(false);
    }
  }

  const ownerReady = accountId === EVIDENCE_CONTRACT_OWNER;

  return (
    <main className="q-connect-page">
      <header className="q-connect-header">
        <Link to="/" aria-label="Return to Quorumark home"><strong>QUORUMARK</strong></Link>
        <Link to="/verification" className="q-connect-back">Back to verification</Link>
      </header>
      <section className="q-connect-card" aria-labelledby="deployment-title">
        <p className="q-kicker">Owner-only testnet setup</p>
        <h1 id="deployment-title">Prepare the evidence contract</h1>
        <p>This temporary page is restricted to the verified estarkunmi.testnet account. It never asks for a private key.</p>
        <div className="q-connected-state" style={{ marginTop: 24 }}>
          {ownerReady ? <Check size={20} /> : <ShieldCheck size={20} />}
          <div><strong>{accountId ?? "Wallet not verified"}</strong><span>{message}</span></div>
          <button className="q-secondary" onClick={() => refresh().catch((error) => setMessage(error instanceof Error ? error.message : "We couldn't refresh the deployment checks."))} disabled={busy}>Refresh checks</button>
        </div>
        {status && !status.initialized && ownerReady && (
          <div className="q-wallet-primary" style={{ display: "grid", gap: 16, marginTop: 24 }}>
            <h2>Deploy and initialize the evidence contract</h2>
            <p>Signer: <strong>estarkunmi.testnet</strong><br />Receiver: <strong>estarkunmi.testnet</strong><br />Actions: <strong>DeployContract, then new</strong><br />Initialization: <strong>{`{"owner_id":"estarkunmi.testnet"}`}</strong><br />Deposit: <strong>0 NEAR</strong><br />Network: <strong>NEAR testnet</strong></p>
            <button className="q-primary q-full" onClick={approveContractDeployment} disabled={busy}>
              {busy ? <Loader2 className="q-spin" size={16} /> : <WalletCards size={16} />} Approve deployment and initialization
            </button>
          </div>
        )}
        {status?.initialized && <div className="q-connected-state" style={{ marginTop: 24 }}><Check size={20} /><div><strong>Contract ready</strong><span>Owner verified as {status.owner_id}</span></div></div>}
        {lastTransaction && <p className="q-connect-note">Transaction submitted for independent verification: {lastTransaction}</p>}
      </section>
    </main>
  );
}
