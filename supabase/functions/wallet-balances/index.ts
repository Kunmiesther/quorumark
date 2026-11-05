// Read on-chain balances for a user's verified wallet_connections.
// Read-only: hits public RPC endpoints with the wallet's public address.
// No user secrets are read, logged, or required. Users' API keys/private keys
// are never involved.
//
// To upgrade reliability, plug in a dedicated RPC provider key (Alchemy,
// Helius, QuickNode, Infura, Ankr…) at the RPC_URLS map below and swap the
// public endpoints for the authenticated ones. Nothing else needs to change.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// -----------------------------------------------------------------------------
// Chain config
// -----------------------------------------------------------------------------

// Public RPC endpoints, with fallbacks. Replace with an authenticated URL
// (Alchemy/Infura/etc.) via env var later. jsonRpc() tries each URL in order.
const RPC_URLS: Record<string, string[]> = {
  ethereum: [
    Deno.env.get("RPC_ETHEREUM") ?? "",
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
    "https://eth.llamarpc.com",
  ].filter(Boolean),
  base: [
    Deno.env.get("RPC_BASE") ?? "",
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
  ].filter(Boolean),
  arbitrum: [
    Deno.env.get("RPC_ARBITRUM") ?? "",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ].filter(Boolean),
  polygon: [
    Deno.env.get("RPC_POLYGON") ?? "",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-rpc.com",
  ].filter(Boolean),
  optimism: [
    Deno.env.get("RPC_OPTIMISM") ?? "",
    "https://optimism-rpc.publicnode.com",
    "https://mainnet.optimism.io",
  ].filter(Boolean),
  solana: [
    Deno.env.get("RPC_SOLANA") ?? "",
    "https://api.mainnet-beta.solana.com",
  ].filter(Boolean),
};

type EvmChain = "ethereum" | "base" | "arbitrum" | "polygon" | "optimism";

interface EvmChainCfg {
  nativeSymbol: string;
  nativePriceId: string; // coingecko id
  usdc?: { address: string; decimals: number };
  usdt?: { address: string; decimals: number };
}

const EVM_CFG: Record<EvmChain, EvmChainCfg> = {
  ethereum: {
    nativeSymbol: "ETH",
    nativePriceId: "ethereum",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  },
  base: {
    nativeSymbol: "ETH",
    nativePriceId: "ethereum",
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  },
  arbitrum: {
    nativeSymbol: "ETH",
    nativePriceId: "ethereum",
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    usdt: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
  },
  polygon: {
    nativeSymbol: "POL",
    nativePriceId: "matic-network",
    usdc: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    usdt: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  },
  optimism: {
    nativeSymbol: "ETH",
    nativePriceId: "ethereum",
    usdc: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    usdt: { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
  },
};

// SPL token mints on Solana mainnet
const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// -----------------------------------------------------------------------------
// RPC helpers
// -----------------------------------------------------------------------------

async function jsonRpc(urls: string | string[], method: string, params: unknown[]): Promise<unknown> {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr: Error | null = null;
  for (const url of list) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) {
        lastErr = new Error(`RPC_HTTP_${res.status}`);
        continue;
      }
      const j = await res.json();
      if (j.error) {
        lastErr = new Error(`RPC_ERROR:${j.error.message ?? "unknown"}`);
        continue;
      }
      return j.result;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("RPC_UNAVAILABLE");
}

function hexToBigInt(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function fromDecimals(raw: bigint, decimals: number): number {
  // Safe for values that fit in Number range after scaling. For very large
  // balances we'd lose precision at the tail, but USD display accepts that.
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  return Number(whole) + Number(frac) / Number(denom);
}

// eth_call data for balanceOf(address)
function encodeBalanceOf(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "").padStart(40, "0");
  // selector 0x70a08231 + 32-byte padded address
  return "0x70a08231" + "0".repeat(24) + clean;
}

async function readEvmBalances(chain: EvmChain, address: string): Promise<{
  balances: { asset: string; amount: number; contract?: string }[];
}> {
  const url = RPC_URLS[chain];
  const cfg = EVM_CFG[chain];
  const balances: { asset: string; amount: number; contract?: string }[] = [];

  // Native
  const nativeHex = (await jsonRpc(url, "eth_getBalance", [address, "latest"])) as string;
  const nativeAmt = fromDecimals(hexToBigInt(nativeHex), 18);
  balances.push({ asset: cfg.nativeSymbol, amount: nativeAmt });

  // ERC-20s
  for (const [sym, tok] of [
    ["USDC", cfg.usdc],
    ["USDT", cfg.usdt],
  ] as const) {
    if (!tok) continue;
    try {
      const data = encodeBalanceOf(address);
      const raw = (await jsonRpc(url, "eth_call", [
        { to: tok.address, data },
        "latest",
      ])) as string;
      const amt = fromDecimals(hexToBigInt(raw), tok.decimals);
      balances.push({ asset: sym, amount: amt, contract: tok.address });
    } catch (_) {
      // Skip token on failure; native + other tokens still return.
    }
  }

  return { balances };
}

async function readSolanaBalances(address: string): Promise<{
  balances: { asset: string; amount: number; mint?: string }[];
}> {
  const url = RPC_URLS.solana;
  const balances: { asset: string; amount: number; mint?: string }[] = [];

  // Native SOL (lamports, 9 decimals)
  const solRes = (await jsonRpc(url, "getBalance", [address])) as { value: number } | number;
  const lamports =
    typeof solRes === "number" ? solRes : Number((solRes as { value: number }).value ?? 0);
  balances.push({ asset: "SOL", amount: lamports / 1e9 });

  // SPL tokens (USDC, USDT)
  for (const [sym, mint] of [
    ["USDC", SOL_USDC_MINT],
    ["USDT", SOL_USDT_MINT],
  ] as const) {
    try {
      const res = (await jsonRpc(url, "getTokenAccountsByOwner", [
        address,
        { mint },
        { encoding: "jsonParsed" },
      ])) as { value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> };
      let total = 0;
      for (const acc of res?.value ?? []) {
        const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        total += ui ?? 0;
      }
      balances.push({ asset: sym, amount: total, mint });
    } catch (_) {
      // Skip token on failure
    }
  }

  return { balances };
}

// -----------------------------------------------------------------------------
// Pricing
// -----------------------------------------------------------------------------

let priceCache: { at: number; prices: Record<string, number> } | null = null;
const PRICE_TTL_MS = 60_000;

async function getPrices(ids: string[]): Promise<{ prices: Record<string, number>; ok: boolean }> {
  const unique = [...new Set(ids)];
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) {
    if (unique.every((id) => id in priceCache!.prices)) {
      return { prices: priceCache.prices, ok: true };
    }
  }
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${unique.join(",")}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`price_http_${res.status}`);
    const j = (await res.json()) as Record<string, { usd: number }>;
    const out: Record<string, number> = {};
    for (const id of unique) out[id] = j[id]?.usd ?? 0;
    priceCache = { at: Date.now(), prices: out };
    return { prices: out, ok: true };
  } catch (_) {
    return { prices: {}, ok: false };
  }
}

function priceIdFor(chain: string, asset: string): string | null {
  if (asset === "USDC" || asset === "USDT") return null; // stable = $1
  if (chain === "solana" && asset === "SOL") return "solana";
  if (asset === "ETH") return "ethereum";
  if (asset === "POL" || asset === "MATIC") return "matic-network";
  return null;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) return fail(500, "CONFIG_ERROR", "Backend is not configured.");

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return fail(401, "UNAUTHENTICATED", "Sign in required.");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return fail(401, "UNAUTHENTICATED", "Sign in required.");
  const userId = userData.user.id;

  const { data: rows, error: rowsErr } = await admin
    .from("wallet_connections")
    .select("id, chain, public_address, status")
    .eq("user_id", userId)
    .eq("status", "verified");
  if (rowsErr) return fail(500, "DB_ERROR", "Could not load wallet connections.");

  const wallets: Array<{
    id: string;
    chain: string;
    address: string;
    balances: { asset: string; amount: number; usdValue: number | null }[];
    walletUsdTotal: number;
    priceUnavailable: boolean;
    errors: { chain: string; code: string; message: string }[];
  }> = [];
  const errors: { chain: string; address: string; code: string; message: string }[] = [];

  // First pass: read raw on-chain amounts.
  const raw: Array<{
    id: string;
    chain: string;
    address: string;
    balances: { asset: string; amount: number }[];
    error?: { code: string; message: string };
  }> = [];

  for (const row of rows ?? []) {
    const chain = String(row.chain);
    const address = String(row.public_address);
    try {
      if (chain === "solana") {
        const { balances } = await readSolanaBalances(address);
        raw.push({ id: row.id, chain, address, balances });
      } else if (chain in EVM_CFG) {
        const { balances } = await readEvmBalances(chain as EvmChain, address);
        raw.push({ id: row.id, chain, address, balances });
      } else {
        raw.push({
          id: row.id,
          chain,
          address,
          balances: [],
          error: { code: "UNSUPPORTED_CHAIN", message: `Chain '${chain}' is not supported yet.` },
        });
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? "RPC read failed";
      raw.push({
        id: row.id,
        chain,
        address,
        balances: [],
        error: { code: "RPC_FAILED", message: msg },
      });
    }
  }

  // Collect price ids needed
  const priceIds = new Set<string>();
  for (const w of raw) {
    for (const b of w.balances) {
      if (b.amount <= 0) continue;
      const id = priceIdFor(w.chain, b.asset);
      if (id) priceIds.add(id);
    }
  }
  const { prices, ok: priceOk } = priceIds.size
    ? await getPrices([...priceIds])
    : { prices: {}, ok: true };

  let overallUsd = 0;

  for (const w of raw) {
    if (w.error) {
      errors.push({ chain: w.chain, address: w.address, code: w.error.code, message: w.error.message });
      wallets.push({
        id: w.id,
        chain: w.chain,
        address: w.address,
        balances: [],
        walletUsdTotal: 0,
        priceUnavailable: false,
        errors: [{ chain: w.chain, code: w.error.code, message: w.error.message }],
      });
      continue;
    }
    let walletUsd = 0;
    let priceMissing = false;
    const priced: { asset: string; amount: number; usdValue: number | null }[] = [];
    for (const b of w.balances) {
      let usd: number | null;
      if (b.asset === "USDC" || b.asset === "USDT") {
        usd = b.amount * 1.0;
      } else {
        const id = priceIdFor(w.chain, b.asset);
        const p = id ? prices[id] : undefined;
        if (!p || p <= 0) {
          usd = null;
          if (b.amount > 0) priceMissing = true;
        } else {
          usd = b.amount * p;
        }
      }
      priced.push({ asset: b.asset, amount: b.amount, usdValue: usd });
      if (usd) walletUsd += usd;
    }
    walletUsd = Math.round(walletUsd * 100) / 100;
    overallUsd += walletUsd;
    wallets.push({
      id: w.id,
      chain: w.chain,
      address: w.address,
      balances: priced,
      walletUsdTotal: walletUsd,
      priceUnavailable: priceMissing || !priceOk,
      errors: [],
    });
  }

  return json(200, {
    ok: true,
    wallets,
    overallUsdTotal: Math.round(overallUsd * 100) / 100,
    priceSource: priceOk ? "coingecko" : "unavailable",
    errors,
  });
});
