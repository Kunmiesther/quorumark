// Issues a single-use, short-TTL signing challenge that a user's wallet
// must sign to prove ownership of a public address.
// - Stores only SHA-256(nonce), never the raw nonce.
// - Never returns anything about other users' challenges.
// - Signing this challenge does NOT authorize any transaction or transfer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPPORTED_PROVIDERS = new Set(["near-wallet-selector", "phantom", "coinbase", "bitget", "walletconnect", "metamask", "trust", "rainbow"]);
const SUPPORTED_CHAINS = new Set(["near", "solana", "ethereum", "base", "polygon", "arbitrum", "optimism", "bsc"]);
const CHALLENGE_TTL_SECONDS = 5 * 60;

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return fail(500, "CONFIG_ERROR", "Backend is not configured.");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "INVALID_BODY", "Invalid JSON body.");
  }

  const provider = String(body.provider ?? "").toLowerCase();
  const chain = String(body.chain ?? "").toLowerCase();
  const publicAddress = String(body.public_address ?? "").trim();

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return fail(400, "UNSUPPORTED_PROVIDER", "Provider is not supported.");
  }
  if (!SUPPORTED_CHAINS.has(chain)) {
    return fail(400, "UNSUPPORTED_CHAIN", "Chain is not supported.");
  }
  if (chain === "near" && !/^[a-z0-9._-]{2,64}$/.test(publicAddress)) {
    return fail(400, "INVALID_ADDRESS", "Invalid NEAR testnet account.");
  }
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicAddress)) {
    return fail(400, "INVALID_ADDRESS", "Invalid Solana address.");
  }
  if (chain !== "solana" && !/^0x[0-9a-fA-F]{40}$/.test(publicAddress)) {
    return fail(400, "INVALID_ADDRESS", "Invalid EVM address.");
  }

  const nonce = randomNonce();
  const nonceHash = await sha256Hex(nonce);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000);

  const recipient = new URL(Deno.env.get("QUORUMARK_APP_URL") ?? SUPABASE_URL).hostname;
  const challengeText = [
    "Quorumark",
    "Wallet authentication request",
    "",
    "By signing this message you prove ownership of the wallet below.",
    "This signature does NOT authorize any transaction, transfer, or spend.",
    "",
    `Address: ${publicAddress}`,
    `Chain: ${chain}`,
    `Provider: ${provider}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt.toISOString()}`,
    `Expires: ${expiresAt.toISOString()}`,
    `Recipient: ${recipient}`,
  ].join("\n");

  const { error: insErr } = await admin.from("wallet_connection_challenges").insert({
    provider,
    chain,
    public_address: publicAddress,
    nonce_hash: nonceHash,
    challenge_text: challengeText,
    expires_at: expiresAt.toISOString(),
    recipient,
    network: chain === "near" ? "testnet" : "testnet",
  });
  if (insErr) return fail(500, "INSERT_FAILED", "Could not create challenge.");

  return json(200, {
    ok: true,
    challenge_text: challengeText,
    expires_at: expiresAt.toISOString(),
    nonce_hash: nonceHash,
    nonce,
    recipient,
  });
});
