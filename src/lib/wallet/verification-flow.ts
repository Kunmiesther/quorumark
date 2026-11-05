// Orchestrates the connect→challenge→sign→verify pipeline with phase callbacks.
// Extracted from the WalletConnectionsSheet so we can unit-test the state
// machine and failure cleanup without React.

import { WalletError, type WalletProviderId, type WalletChain } from "./providers";

export type VerificationPhase =
  | "idle"
  | "connecting"
  | "awaiting_signature"
  | "verifying"
  | "verified"
  | "error";

export type VerificationFlowDeps = {
  connect: (id: WalletProviderId) => Promise<{
    publicAddress: string;
    provider: WalletProviderId;
    chain: WalletChain;
    chainId?: string;
  }>;
  requestChallenge: (input: {
    provider: WalletProviderId;
    chain: WalletChain;
    public_address: string;
  }) => Promise<{ ok: boolean; challenge_text?: string; nonce_hash?: string; message?: string }>;
  sign: (id: WalletProviderId, address: string, challengeText: string) => Promise<{ signature: string }>;
  verify: (input: {
    provider: WalletProviderId;
    chain: WalletChain;
    public_address: string;
    signature: string;
    nonce_hash: string;
  }) => Promise<{ ok: boolean; code?: string; message?: string }>;
  onPhase?: (phase: VerificationPhase) => void;
};

export type VerificationResult = {
  ok: true;
  publicAddress: string;
  provider: WalletProviderId;
  chain: WalletChain;
};

export async function runVerificationFlow(
  id: WalletProviderId,
  deps: VerificationFlowDeps,
): Promise<VerificationResult> {
  const setPhase = (p: VerificationPhase) => deps.onPhase?.(p);
  setPhase("connecting");
  try {
    const conn = await deps.connect(id);

    const chal = await deps.requestChallenge({
      provider: conn.provider,
      chain: conn.chain,
      public_address: conn.publicAddress,
    });
    if (!chal.ok || !chal.challenge_text || !chal.nonce_hash) {
      throw new WalletError("CHALLENGE_FAILED", chal.message ?? "Could not start verification.");
    }

    setPhase("awaiting_signature");
    const signed = await deps.sign(conn.provider, conn.publicAddress, chal.challenge_text);

    setPhase("verifying");
    const v = await deps.verify({
      provider: conn.provider,
      chain: conn.chain,
      public_address: conn.publicAddress,
      signature: signed.signature,
      nonce_hash: chal.nonce_hash,
    });
    if (!v.ok) {
      throw new WalletError(v.code ?? "VERIFY_FAILED", v.message ?? "Verification failed.");
    }

    setPhase("verified");
    return {
      ok: true,
      publicAddress: conn.publicAddress,
      provider: conn.provider,
      chain: conn.chain,
    };
  } catch (e) {
    setPhase("error");
    if (e instanceof WalletError) throw e;
    throw new WalletError("UNKNOWN_ERROR", e instanceof Error ? e.message : "Something went wrong.");
  }
}
