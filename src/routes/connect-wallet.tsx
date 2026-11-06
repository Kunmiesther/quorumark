import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Check, ChevronLeft, Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";
import { connectProvider, listProviders, signChallenge, type WalletProviderId } from "@/lib/wallet/providers";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/connect-wallet")({ component: ConnectWalletPage, head: () => ({ meta: [{ title: "Connect wallet · Quorumark" }, { name: "description", content: "Connect a NEAR or compatible EVM wallet to Quorumark." }] }) });

function ConnectWalletPage() {
  const navigate = useNavigate();
  const providers = useMemo(() => listProviders(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ address: string; chain: string } | null>(null);
  async function connectNear() {
    setBusy("near");
    try {
      const near = (window as Window & { near?: { signIn?: () => Promise<{ accountId?: string }> } }).near;
      if (!near?.signIn) throw new Error("Native NEAR wallet selector is not configured for this environment yet");
      const result = await near.signIn();
      if (!result.accountId) throw new Error("NEAR wallet did not return an account");
      toast.message("NEAR wallet connected. A native signing adapter is required to finish authentication.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "NEAR wallet connection failed"); } finally { setBusy(null); }
  }
  async function connectEvm(provider: WalletProviderId) {
    setBusy(provider);
    try {
      const result = await connectProvider(provider);
      const challenge = await supabase.functions.invoke("wallet-challenge", { body: { provider: result.provider, chain: result.chain, public_address: result.publicAddress } });
      if (challenge.error || !challenge.data?.challenge_text) throw new Error("Wallet challenge service is not configured");
      const signed = await signChallenge(result.provider, result.publicAddress, challenge.data.challenge_text);
      const verified = await supabase.functions.invoke("wallet-verify", { body: { provider: result.provider, chain: result.chain, public_address: result.publicAddress, signature: signed.signature, nonce_hash: challenge.data.nonce_hash } });
      if (verified.error || !verified.data?.ok) throw new Error("Signature verification failed");
      setConnected({ address: result.publicAddress, chain: result.chain });
      toast.success("Wallet authenticated");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Wallet authentication failed"); } finally { setBusy(null); }
  }
  return <main className="q-connect-page"><header className="q-connect-header"><Link to="/"><QuorumarkLogo compact/></Link><Link to="/marketplace" className="q-connect-back"><ChevronLeft size={15}/> Back to marketplace</Link></header><section className="q-connect-card"><div className="q-connect-intro"><p className="q-kicker">Quorumark identity</p><h1>Connect a wallet.<br/><span>Keep the keys.</span></h1><p>Wallet connection is separate from authentication. Quorumark asks for a signed, expiring challenge and never asks for a private key or seed phrase.</p></div>{connected ? <div className="q-connected-state"><Check size={20}/><div><strong>{connected.address}</strong><span>{connected.chain} wallet authenticated</span></div><Link className="q-primary" to="/marketplace">Continue to exchange</Link></div> : <div className="q-wallet-options"><div className="q-wallet-primary"><div className="q-wallet-option-head"><WalletCards size={18}/><div><h2>Connect NEAR Wallet</h2><p>Primary identity for Quorumark</p></div><span className="q-near-badge">NEAR</span></div><button className="q-primary q-full" onClick={connectNear} disabled={!!busy}>{busy === "near" ? <Loader2 className="q-spin" size={16}/> : <WalletCards size={16}/>} {busy === "near" ? "Opening wallet" : "Connect NEAR Wallet"}</button><small>Compatible native NEAR wallet selector required</small></div><div className="q-wallet-secondary"><div className="q-wallet-option-head"><ShieldCheck size={18}/><div><h2>Connect EVM Wallet</h2><p>For compatible cross chain functions</p></div></div><div className="q-provider-list">{providers.filter((provider) => provider.chain === "ethereum").map((provider) => <button key={provider.id} onClick={() => connectEvm(provider.id)} disabled={!!busy || provider.status === "not_installed"}><span>{provider.name}</span><small>{provider.status === "available" ? "Available" : provider.status === "not_installed" ? "Install" : "Configure"}</small></button>)}</div></div></div>}<p className="q-connect-note">Paper and sandbox environments only. Wallet connection never activates live trading.</p></section></main>;
}
