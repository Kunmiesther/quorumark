import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { recordOnboardingDiagnostic, useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { listProviders, connectProvider, signChallenge, subscribeProviders, WalletError, type WalletProviderId } from "@/lib/wallet/providers";
import { WalletMark } from "@/components/welcome/WalletMark";
import { ProgressDots } from "@/components/welcome/ProgressDots";

export const Route = createFileRoute("/welcome/wallet")({
  component: WalletStep,
  head: () => ({ meta: [{ title: "Connect wallet — Turtle Bot" }] }),
});

const ORDER: WalletProviderId[] = ["phantom", "coinbase", "bitget", "metamask", "trust", "rainbow", "walletconnect"];
function WalletStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [connectingId, setConnectingId] = useState<WalletProviderId | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "awaiting_signature" | "verifying">("idle");
  const [, force] = useState(0);
  useOnboardingRouteDiagnostics({ source: "wallet", loading, userId: user?.id });
  useEffect(() => subscribeProviders(() => force((n) => n + 1)), []);
  useEffect(() => { if (!loading && !user) navigate({ to: "/welcome" }); }, [loading, user, navigate]);
  const providers = useMemo(() => {
    const byId = new Map(listProviders().map((p) => [p.id, p]));
    return ORDER.map((id) => byId.get(id)).filter(Boolean) as ReturnType<typeof listProviders>;
  }, []);
  if (loading || !user) return null;

  async function handleConnect(id: WalletProviderId) {
    setConnectingId(id); setPhase("connecting");
    try {
      const conn = await connectProvider(id);
      const challenge = await supabase.functions.invoke("wallet-challenge", { body: { provider: conn.provider, chain: conn.chain, public_address: conn.publicAddress } });
      const payload = challenge.data as { ok?: boolean; message?: string; challenge_text?: string; nonce_hash?: string } | null;
      if (challenge.error || !payload?.ok || !payload.challenge_text || !payload.nonce_hash) throw new WalletError("CHALLENGE_FAILED", payload?.message ?? "Could not start verification.");
      setPhase("awaiting_signature");
      const signed = await signChallenge(conn.provider, conn.publicAddress, payload.challenge_text);
      setPhase("verifying");
      const verified = await supabase.functions.invoke("wallet-verify", { body: { provider: conn.provider, chain: conn.chain, public_address: conn.publicAddress, signature: signed.signature, nonce_hash: payload.nonce_hash } });
      const result = verified.data as { ok?: boolean; message?: string; code?: string } | null;
      if (verified.error || !result?.ok) throw new WalletError(result?.code ?? "VERIFY_FAILED", result?.message ?? "Verification failed.");
      toast.success(`${conn.provider} verified`);
      navigate({ to: "/welcome/notifications" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect wallet.");
    } finally { setConnectingId(null); setPhase("idle"); }
  }

  function skip() {
    recordOnboardingDiagnostic({ route: window.location.pathname, source: "wallet guard", status: "redirecting", detail: "Skipped; sending to /welcome/notifications" });
    navigate({ to: "/welcome/notifications" });
  }

  return <div className="flex flex-1 flex-col pb-3 pt-3">
    <ProgressDots step={4} total={9} />
    <h1 className="text-center font-display text-[28px] font-bold">Connect a wallet</h1>
    <p className="mt-3 text-center text-sm leading-relaxed text-purple-200/70">Sign a one-time message to prove ownership.<br/>No transfers, no transactions.</p>
    <div className="welcome-inset-panel mt-5 flex items-center gap-3 rounded-[22px] px-4 py-3 text-[11px] text-muted-foreground">
      <ShieldCheck className="h-5 w-5 shrink-0 text-purple-400" />
      <span>We never ask for seed phrases, private keys, or wallet passwords.</span>
    </div>
    <div className="mt-4 space-y-3">
      {providers.map((p) => {
        const configurable = p.status !== "needs_configuration" && p.status !== "coming_soon";
        const installed = p.status === "available";
        const label = installed ? "Connect" : p.status === "needs_configuration" ? "Needs configuration" : "Not installed";
        return <button key={p.id} type="button" onClick={() => {
          if (installed) void handleConnect(p.id);
          else if (p.status === "not_installed" && p.installUrl) window.open(p.installUrl, "_blank", "noopener,noreferrer");
          else if (!configurable) toast.error("This wallet needs configuration.");
        }} className="welcome-wallet-card flex w-full items-center gap-4 rounded-[24px] px-4 py-4 text-left" disabled={connectingId !== null}>
          <span className="welcome-wallet-icon flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <WalletMark id={p.id} />
          </span>
          <span className="min-w-0 flex-1"><strong className="block truncate text-[16px] text-white">{p.name}</strong><span className="mt-1 block text-xs text-purple-200/65">{p.chain === "solana" ? "Solana" : "EVM"}</span></span>
          <span className={installed ? "welcome-wallet-connect" : "welcome-wallet-status"}>{connectingId === p.id ? <RefreshCw className="h-4 w-4 animate-spin"/> : label}</span>
        </button>;
      })}
    </div>
    {connectingId && <p className="mt-3 text-center text-xs text-purple-300">{phase === "connecting" ? "Connecting…" : phase === "awaiting_signature" ? "Awaiting signature…" : "Verifying…"}</p>}
    <button type="button" onClick={skip} className="welcome-secondary-action mt-7 flex h-14 items-center justify-center text-sm">Skip for now</button>
  </div>;
}
