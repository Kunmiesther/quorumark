// Automated signature + nonce-lifecycle tests for wallet verification.
// Uses synthetic keys — no live wallets required.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ed25519 } from "https://esm.sh/@noble/curves@1.6.0/ed25519";
import bs58 from "https://esm.sh/bs58@6.0.0";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.21.19/accounts";
import { verifyWalletSignature } from "../_shared/wallet-signature.ts";

const challengeText = [
  "Quorumark",
  "Wallet connection request",
  "",
  "Nonce: 0123456789abcdef",
  "Issued: 2026-07-14T00:00:00.000Z",
  "Expires: 2026-07-14T00:05:00.000Z",
].join("\n");

function nearPayload(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const encoder = new TextEncoder();
  const u32 = (value: number) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
  const string = (value: string) => { const bytes = encoder.encode(value); return new Uint8Array([...u32(bytes.length), ...bytes]); };
  return new Uint8Array([...u32(2147484061), ...string(message), ...nonce, ...string(recipient), 0]);
}

// ---------- Solana / ed25519 ----------
Deno.test("solana: valid ed25519 signature accepted", async () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = bs58.encode(pub);
  const sig = ed25519.sign(new TextEncoder().encode(challengeText), priv);
  const signature = bs58.encode(sig);
  const res = await verifyWalletSignature({
    chain: "solana",
    publicAddress: address,
    signature,
    challengeText,
  });
  assertEquals(res.ok, true);
});

Deno.test("solana: tampered signature rejected", async () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = bs58.encode(pub);
  const sig = ed25519.sign(new TextEncoder().encode(challengeText), priv);
  sig[0] ^= 0xff; // flip a byte
  const res = await verifyWalletSignature({
    chain: "solana",
    publicAddress: address,
    signature: bs58.encode(sig),
    challengeText,
  });
  assertEquals(res.ok, false);
});

Deno.test("solana: signer ≠ bound address rejected", async () => {
  const signerPriv = ed25519.utils.randomPrivateKey();
  const otherPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const boundAddress = bs58.encode(otherPub);
  const sig = ed25519.sign(new TextEncoder().encode(challengeText), signerPriv);
  const res = await verifyWalletSignature({
    chain: "solana",
    publicAddress: boundAddress,
    signature: bs58.encode(sig),
    challengeText,
  });
  assertEquals(res.ok, false);
});

// ---------- EVM / EIP-191 ----------
Deno.test("evm: valid personal_sign signature accepted", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: challengeText });
  const res = await verifyWalletSignature({
    chain: "ethereum",
    publicAddress: account.address,
    signature,
    challengeText,
  });
  assertEquals(res.ok, true);
});

Deno.test("evm: tampered signature rejected", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: challengeText });
  const firstByte = signature.slice(2, 4);
  const tampered = `${signature.slice(0, 2)}${firstByte === "00" ? "01" : "00"}${signature.slice(4)}`;
  const res = await verifyWalletSignature({
    chain: "ethereum",
    publicAddress: account.address,
    signature: tampered,
    challengeText,
  });
  assertEquals(res.ok, false);
});

Deno.test("evm: signer ≠ bound address rejected", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const signature = await signer.signMessage({ message: challengeText });
  const res = await verifyWalletSignature({
    chain: "ethereum",
    publicAddress: other.address,
    signature,
    challengeText,
  });
  assertEquals(res.ok, false);
});

Deno.test("near: valid NEP-413 signature accepted", async () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const nonce = new Uint8Array(32);
  nonce.fill(7);
  const message = `Quorumark\nNonce: ${Array.from(nonce).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const payload = nearPayload(message, nonce, "app.example");
  const signature = bs58.encode(ed25519.sign(payload, priv));
  const res = await verifyWalletSignature({ chain: "near", publicAddress: "alice.testnet", publicKey: `ed25519:${bs58.encode(pub)}`, signature, challengeText: message, recipient: "app.example" });
  assertEquals(res.ok, true);
});

Deno.test("near: tampered NEP-413 signature rejected", async () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const nonce = new Uint8Array(32);
  const message = `Quorumark\nNonce: ${Array.from(nonce).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const signature = ed25519.sign(nearPayload(message, nonce, "app.example"), priv);
  signature[0] ^= 1;
  const res = await verifyWalletSignature({ chain: "near", publicAddress: "alice.testnet", publicKey: `ed25519:${bs58.encode(pub)}`, signature: bs58.encode(signature), challengeText: message, recipient: "app.example" });
  assertEquals(res.ok, false);
});

// ---------- Nonce lifecycle (pure logic, mirrors index.ts checks) ----------
type Challenge = {
  used_at: string | null;
  expires_at: string;
  nonce_hash: string;
};
function checkChallenge(
  chal: Challenge | null,
  nonceHash: string,
  now = Date.now(),
): { ok: boolean; code?: string } {
  if (!chal) return { ok: false, code: "CHALLENGE_NOT_FOUND" };
  if (chal.nonce_hash !== nonceHash) return { ok: false, code: "CHALLENGE_NOT_FOUND" };
  if (chal.used_at) return { ok: false, code: "CHALLENGE_ALREADY_USED" };
  if (new Date(chal.expires_at).getTime() < now) return { ok: false, code: "CHALLENGE_EXPIRED" };
  return { ok: true };
}

Deno.test("nonce: reused challenge rejected", () => {
  const res = checkChallenge(
    { used_at: "2026-07-14T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", nonce_hash: "abc" },
    "abc",
  );
  assertEquals(res, { ok: false, code: "CHALLENGE_ALREADY_USED" });
});

Deno.test("nonce: expired challenge rejected", () => {
  const res = checkChallenge(
    { used_at: null, expires_at: "2000-01-01T00:00:00Z", nonce_hash: "abc" },
    "abc",
  );
  assertEquals(res, { ok: false, code: "CHALLENGE_EXPIRED" });
});

Deno.test("nonce: unknown / mismatched hash rejected", () => {
  const res = checkChallenge(null, "abc");
  assertEquals(res, { ok: false, code: "CHALLENGE_NOT_FOUND" });
  const res2 = checkChallenge(
    { used_at: null, expires_at: "2999-01-01T00:00:00Z", nonce_hash: "xyz" },
    "abc",
  );
  assertEquals(res2.ok, false);
});

Deno.test("nonce: fresh unused matching hash accepted", () => {
  const res = checkChallenge(
    { used_at: null, expires_at: "2999-01-01T00:00:00Z", nonce_hash: "abc" },
    "abc",
  );
  assertEquals(res, { ok: true });
});
