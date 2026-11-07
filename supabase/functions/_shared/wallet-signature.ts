// Pure signature-verification helpers used by wallet-verify.
// No DB, no network — safe to unit test with synthetic keys.
import { ed25519 } from "https://esm.sh/@noble/curves@1.6.0/ed25519";
import bs58 from "https://esm.sh/bs58@6.0.0";
import { verifyMessage } from "https://esm.sh/viem@2.21.19";
import { serializeNep413 } from "https://esm.sh/@near-wallet-selector/core@10.1.4";

export const EVM_CHAINS = new Set([
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "bsc",
]);

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("BAD_HEX");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function decodeSignature(sig: string): Uint8Array {
  const s = sig.trim();
  if (s.startsWith("0x")) return hexToBytes(s);
  // Phantom returns base58; some wallets return base64. Base58 alphabet is a
  // subset of base64's, so only pick base64 when the string actually contains
  // a base64-specific char (+ / =). Otherwise decode as base58.
  const looksBase64 = /[+/=]/.test(s);
  if (looksBase64 && s.length % 4 === 0) {
    try {
      return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    } catch (_) { /* fallthrough */ }
  }
  return bs58.decode(s);
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function verifyWalletSignature(params: {
  chain: string;
  publicAddress: string;
  signature: string;
  challengeText: string;
  publicKey?: string;
  recipient?: string;
}): Promise<VerifyResult> {
  const { chain, publicAddress, signature, challengeText, publicKey, recipient } = params;
  try {
    if (chain === "near") {
      if (!publicKey?.startsWith("ed25519:") || !recipient) return { ok: false, code: "INVALID_PUBLIC_KEY", message: "NEAR public key is required." };
      const nonceLine = challengeText.split("\n").find((line) => line.startsWith("Nonce: "))?.slice(7).trim();
      const nonce = nonceLine ? hexToBytes(nonceLine) : new Uint8Array();
      if (nonce.length !== 32) return { ok: false, code: "INVALID_NONCE", message: "NEAR challenge nonce is invalid." };
      const payload = serializeNep413({ message: challengeText, recipient, nonce: Buffer.from(nonce) });
      const pub = bs58.decode(publicKey.slice("ed25519:".length));
      const sig = bs58.decode(signature);
      if (pub.length !== 32 || sig.length !== 64 || !ed25519.verify(sig, payload, pub)) return { ok: false, code: "INVALID_SIGNATURE", message: "Signature did not match NEAR wallet." };
      if (publicAddress.length < 2) return { ok: false, code: "INVALID_ADDRESS", message: "Invalid NEAR account." };
      return { ok: true };
    }
    if (chain === "solana") {
      const pubKey = bs58.decode(publicAddress);
      if (pubKey.length !== 32) {
        return { ok: false, code: "INVALID_ADDRESS", message: "Invalid Solana public key." };
      }
      const sig = decodeSignature(signature);
      if (sig.length !== 64) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Invalid ed25519 signature." };
      }
      const msg = new TextEncoder().encode(challengeText);
      const ok = ed25519.verify(sig, msg, pubKey);
      return ok
        ? { ok: true }
        : { ok: false, code: "INVALID_SIGNATURE", message: "Signature did not match wallet." };
    }
    if (EVM_CHAINS.has(chain)) {
      const sig = signature.startsWith("0x") ? signature : `0x${signature}`;
      const ok = await verifyMessage({
        address: publicAddress as `0x${string}`,
        message: challengeText,
        signature: sig as `0x${string}`,
      });
      return ok
        ? { ok: true }
        : { ok: false, code: "INVALID_SIGNATURE", message: "Signature did not match wallet." };
    }
    return { ok: false, code: "UNSUPPORTED_CHAIN", message: "Chain is not supported." };
  } catch {
    return { ok: false, code: "INVALID_SIGNATURE", message: "Signature could not be verified." };
  }
}
