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

const SUPPORTED_PROVIDERS = new Set(["phantom", "coinbase", "bitget", "walletconnect", "metamask", "trust", "rainbow"]);

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



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
  const nonceHash = String(body.nonce_hash ?? "");
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) : null;

  if (!SUPPORTED_PROVIDERS.has(provider)) return fail(400, "UNSUPPORTED_PROVIDER", "Provider is not supported.");
  if (!publicAddress || !signature || !nonceHash) return fail(400, "INVALID_INPUT", "Missing fields.");

  // Look up the challenge by its one-time hash.
  const { data: chal } = await admin
    .from("wallet_connection_challenges")
    .select("id, provider, chain, public_address, challenge_text, expires_at, used_at")
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
  });
  if (!vres.ok) return fail(400, vres.code, vres.message);

  // Single-use: mark challenge consumed before writing the wallet row.
  const now = new Date().toISOString();
  await admin.from("wallet_connection_challenges").update({ used_at: now }).eq("id", chal.id);

  // Look for an existing row for this chain and address; reactivate or insert.
  const { data: existing } = await admin
    .from("wallet_connections")
    .select("id, is_active")
    .eq("chain", chain)
    .ilike("public_address", publicAddress)
    .maybeSingle();

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

  return json(200, { ok: true, connection_id: connectionId, status: "verified" });
});
