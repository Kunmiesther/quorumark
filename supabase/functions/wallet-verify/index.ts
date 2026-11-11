// Verifies a wallet signature server-side and attaches the wallet to the
// authenticated user on success.
// - Looks up the challenge by SHA-256(nonce). Rejects expired/used/mismatched
//   provider or chain or address.
// - Verifies the signature with the correct scheme:
//   * solana: ed25519 (@noble/curves)
//   * ethereum/base/polygon/arbitrum/optimism/bsc: EIP-191 personal_sign
//     (viem verifyMessage — supports EOA + ERC-1271 smart-wallet signatures).
// - Never stores or returns anything but sanitized status. No seed phrases,
//   no private keys, no wallet passwords.
// - On success: marks challenge used, upserts a verified wallet_connections
//   row, and sets is_active if it's the user's only active wallet.
// - On any failure: NO verified wallet row is written.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyWalletSignature } from "../_shared/wallet-signature.ts";

const SUPPORTED_PROVIDERS = new Set(["near-wallet-selector", "phantom", "coinbase", "bitget", "walletconnect", "metamask", "trust", "rainbow"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
function fail(status: number, code: string, message: string) {
  return json(status, { ok: false, code, message });
}

async function identityEmail(chain: string, address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${chain}:${address.toLowerCase()}`));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `wallet-${hex}@auth.quorumark.local`;
}

function serviceRoleKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { default?: unknown };
    return typeof parsed.default === "string" ? parsed.default : undefined;
  } catch {
    return undefined;
  }
}

async function nearKeyBelongsToAccount(accountId: string, publicKey: string): Promise<boolean> {
  const rpcUrl = Deno.env.get("VITE_NEAR_RPC_URL") ?? "https://rpc.testnet.near.org";
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "quorumark-wallet-key", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { result?: { permission?: unknown }; error?: unknown };
    return payload.result?.permission !== undefined && payload.error === undefined;
  } catch {
    return false;
  }
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = serviceRoleKey();
  if (!SUPABASE_URL || !SERVICE_ROLE) return fail(500, "CONFIG_ERROR", "Backend is not configured.");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, "INVALID_BODY", "Invalid JSON body."); }

  const provider = String(body.provider ?? "").toLowerCase();
  const chain = String(body.chain ?? "").toLowerCase();
  const publicAddress = String(body.public_address ?? "").trim();
  const signature = String(body.signature ?? "");
  const publicKey = String(body.public_key ?? "");
  const nonceHash = String(body.nonce_hash ?? "");
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) : null;

  if (!SUPPORTED_PROVIDERS.has(provider)) return fail(400, "UNSUPPORTED_PROVIDER", "Provider is not supported.");
  if (!publicAddress || !signature || !nonceHash) return fail(400, "INVALID_INPUT", "Missing fields.");

  // Look up the challenge by its one-time hash.
  const { data: chal } = await admin
    .from("wallet_connection_challenges")
    .select("id, provider, chain, public_address, challenge_text, expires_at, used_at, recipient")
    .eq("nonce_hash", nonceHash)
    .maybeSingle();
  if (!chal) return fail(404, "CHALLENGE_NOT_FOUND", "Challenge not found.");
  if (chal.used_at) return fail(400, "CHALLENGE_ALREADY_USED", "Challenge already used.");
  if (new Date(chal.expires_at).getTime() < Date.now()) return fail(400, "CHALLENGE_EXPIRED", "Challenge expired.");
  if (chal.provider !== provider) return fail(400, "PROVIDER_MISMATCH", "Provider does not match challenge.");
  if (chal.chain !== chain) return fail(400, "CHAIN_MISMATCH", "Chain does not match challenge.");
  if (chal.public_address.toLowerCase() !== publicAddress.toLowerCase()) {
    return fail(400, "ADDRESS_CHANGED", "Address changed during verification.");
  }

  // Verify the signature via shared helper.
  const vres = await verifyWalletSignature({
    chain,
    publicAddress,
    signature,
    challengeText: chal.challenge_text,
    publicKey,
    recipient: chal.recipient ?? new URL(SUPABASE_URL).hostname,
  });
  if (!vres.ok) return fail(400, vres.code, vres.message);
  if (chain === "near" && !(await nearKeyBelongsToAccount(publicAddress, publicKey))) {
    return fail(400, "ACCOUNT_KEY_NOT_FOUND", "The signing key is not registered on this NEAR account.");
  }

  const now = new Date().toISOString();
  // Look for an existing row for this chain and address; reactivate or insert.
  const { data: existing } = await admin
    .from("wallet_connections")
    .select("id, is_active, user_id")
    .eq("chain", chain)
    .ilike("public_address", publicAddress)
    .maybeSingle();

  const { data: identity } = await admin
    .from("wallet_identities")
    .select("user_id")
    .eq("chain", chain)
    .ilike("public_address", publicAddress)
    .maybeSingle();
  let userId = existing?.user_id ?? identity?.user_id ?? null;
  if (!userId) {
    const email = await identityEmail(chain, publicAddress);
    const { data: created, error: createUserError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { wallet_chain: chain, wallet_address: publicAddress },
      app_metadata: { auth_method: "wallet" },
    });
    if (createUserError || !created.user) return fail(500, "IDENTITY_CREATE_FAILED", "Could not create the Quorumark wallet identity.");
    userId = created.user.id;
    const { error: identityError } = await admin.from("wallet_identities").insert({ user_id: userId, chain, public_address: publicAddress });
    if (identityError) return fail(500, "IDENTITY_LINK_FAILED", "Could not link the wallet identity.");
  }

  // Single-use: consume only after signature and identity binding succeed.
  const { data: consumed } = await admin.from("wallet_connection_challenges").update({ used_at: now }).eq("id", chal.id).is("used_at", null).select("id");
  if (!consumed?.length) return fail(400, "CHALLENGE_ALREADY_USED", "Challenge already used.");

  // Keep one active verified wallet per address in this wallet-first identity layer.
  const { count: activeCount } = await admin
    .from("wallet_connections")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  const shouldActivate = (activeCount ?? 0) === 0;

  let connectionId: string;
  if (existing) {
    const { error: upErr } = await admin
      .from("wallet_connections")
      .update({
        provider,
        user_id: userId,
        network: "testnet",
        label,
        status: "verified",
        verified_at: now,
        is_active: existing.is_active || shouldActivate,
      })
      .eq("id", existing.id);
    if (upErr) return fail(500, "UPDATE_FAILED", "Could not update wallet connection.");
    connectionId = existing.id;
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("wallet_connections")
      .insert({
        provider,
        user_id: userId,
        public_address: publicAddress,
        chain,
        network: "testnet",
        label,
        status: "verified",
        verified_at: now,
        is_active: shouldActivate,
      })
      .select("id")
      .single();
    if (insErr || !inserted) return fail(500, "INSERT_FAILED", "Could not save wallet connection.");
    connectionId = inserted.id;
  }

  const secret = Deno.env.get("QUORUMARK_SESSION_SECRET");
  if (!secret) return fail(500, "CONFIG_ERROR", "Session signing is not configured.");
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  const payload = btoa(JSON.stringify({ sub: userId, wallet_address: publicAddress, chain, aud: "quorumark", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  const token = btoa(String.fromCharCode(...new Uint8Array(mac))).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  return json(200, { ok: true, connection_id: connectionId, status: "verified", session_token: `${input}.${token}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
});
