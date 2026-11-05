/**
 * "Activate live signing" panel for an ApeX Omni connection.
 *
 * Flow:
 *   1. User clicks activate.
 *   2. Connect wallet (EVM: MetaMask / Rabby / etc). Address is
 *      canonicalized to EIP-55 checksum so the signed bytes are
 *      byte-for-byte identical to the signer's canonical construction.
 *   3. Wallet signs the exact ApeX Omni onboarding message for the
 *      connection's environment.
 *   4. Signature is POSTed to the broker via the signerOnboard server
 *      function; the broker forwards to the private signer.
 *   5. Sanitized result (credential fingerprint) is rendered.
 *
 * SECURITY:
 *   - Nothing derived from the signature (seed, l2Key, pubKeyHash) is
 *     ever seen by the browser; the signer computes and encrypts it
 *     server-side and returns metadata only.
 *   - Broker and signer verify that the selected connection belongs to the
 *     signed-in user before any credential is stored.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress } from "viem";
import {
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  connectProvider,
  signChallenge,
  type WalletProviderId,
} from "@/lib/wallet/providers";

import { signerOnboard } from "@/lib/apex/onboard.functions";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type Environment = "mainnet" | "testnet";

interface Props {
  connectionId: string;
  environment: Environment;
  currentFingerprint?: string | null;
  hasMainnetSigner?: boolean;
  hasTestnetSigner?: boolean;
}

const MAINNET_HEADER = "ApeX Omni Mainnet";
const TESTNET_HEADER = "ApeX Omni Testnet";
const ACTION_TEXT = "ApeX Omni Onboarding";
const METAMASK_APP_URL = "https://metamask.app.link/dapp/www.turtlebot.app/exchanges";

function buildOnboardingMessage(checksumAddress: string, env: Environment): string {
  const header = env === "mainnet" ? MAINNET_HEADER : TESTNET_HEADER;
  return `${header}\nAddress: ${checksumAddress}\nAction: ${ACTION_TEXT}`;
}

type Phase = "idle" | "connecting" | "signing" | "submitting" | "done";

async function submitOnboarding(input: {
  connection_id: string;
  wallet_address: string;
  environment: Environment;
  signature: string;
}) {
  try {
    return await signerOnboard({ data: input });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("INVALID_JWT")) throw error;

    // A wallet handoff can leave the browser tab open long enough for its
    // access token to expire. Refresh exactly once, then let the global
    // server-function middleware attach the new bearer on the retry.
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) throw error;
    return signerOnboard({ data: input });
  }
}

export function ApexActivateSigning({
  connectionId,
  environment,
  currentFingerprint,
  hasMainnetSigner = false,
  hasTestnetSigner = false,
}: Props) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(
    currentFingerprint ?? null,
  );

  useEffect(() => {
    setFingerprint(currentFingerprint ?? null);
    setPhase("idle");
    setError(null);
  }, [connectionId, currentFingerprint]);

  async function activate() {
    setError(null);
    try {
      setPhase("connecting");
      const providerId: WalletProviderId = "metamask";
      const conn = await connectProvider(providerId);
      const checksum = getAddress(conn.publicAddress);

      setPhase("signing");
      const message = buildOnboardingMessage(checksum, environment);
      const { signature } = await signChallenge(providerId, checksum, message);

      setPhase("submitting");
      const res = await submitOnboarding({
        connection_id: connectionId,
        wallet_address: checksum,
        environment,
        signature,
      });
      setFingerprint(res.credential_fingerprint ?? null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["exchange-connections-full"] }),
        queryClient.invalidateQueries({ queryKey: ["execution-status"] }),
        queryClient.invalidateQueries({ queryKey: ["mainnet-accumulator-connection"] }),
      ]);
      setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ACTIVATION_FAILED";
      setError(msg);
      setPhase("idle");
    }
  }

  const busy = phase !== "idle" && phase !== "done";

  return (
    <SurfaceCard>
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "rgba(153,69,255,0.15)", color: "var(--accent)" }}
        >
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-white">
            {hasMainnetSigner ? "Live signing active" : "Activate live signing"} ({environment})
          </p>
          <p className="mt-0.5 text-[11.5px] text-white/55">
            Wallet signs the ApeX Omni onboarding message; the derived key is
            encrypted server-side. No secret ever reaches this browser.
          </p>
        </div>
      </div>

      {fingerprint && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-500/[0.08] p-2.5 text-[11.5px] text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            Credential fingerprint{" "}
            <code className="font-mono text-emerald-200">{fingerprint}</code>
          </span>
        </div>
      )}

      {!hasMainnetSigner && hasTestnetSigner && environment === "mainnet" ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/[0.08] p-2.5 text-[11.5px] text-amber-100">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            Testnet signer proof exists. Mainnet needs a fresh MetaMask signature.
          </span>
        </div>
      ) : null}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/[0.08] p-2.5 text-[11.5px] text-red-200">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      <button
        type="button"
        onClick={activate}
        disabled={busy}
        className={cn(
          "mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-semibold text-white transition",
          busy
            ? "bg-white/[0.06] text-white/60"
            : "bg-[color:var(--accent)] hover:brightness-110",
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
        {phase === "connecting" && "Connect wallet…"}
        {phase === "signing" && "Sign message in wallet…"}
        {phase === "submitting" && "Submitting to signer…"}
        {phase === "done" && "Re-run activation"}
        {phase === "idle" && (hasMainnetSigner ? "Re-run activation" : "Sign mainnet onboarding")}
      </button>

      <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
        <p className="text-[11px] leading-relaxed text-white/55">
          No MetaMask message? Wallet extensions cannot open inside an embedded browser. On
          desktop, open <span className="text-white/80">www.turtlebot.app/exchanges</span> in the
          browser where MetaMask is installed. On mobile, use the button below.
        </p>
        <a
          href={METAMASK_APP_URL}
          target="_self"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-[color:var(--accent)]/20"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in MetaMask mobile
        </a>
      </div>
    </SurfaceCard>
  );
}
