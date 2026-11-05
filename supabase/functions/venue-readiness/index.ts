// Owner/admin-only international venue evaluation.
//
// This function is deliberately read-only. It probes public, allowlisted
// endpoints and returns sanitized readiness facts. The selected jurisdiction
// is a planning scenario only: it never changes network routing, asserts legal
// eligibility, stores an attestation, or authorizes live execution.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getAdapter } from "../_shared/exchange-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Jurisdiction = "US" | "JM" | "MX";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function probeBaseRpc(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const url = Deno.env.get("RPC_BASE") ?? "https://mainnet.base.org";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = await response.json().catch(() => ({}));
    const chainIdHex = typeof body?.result === "string" ? body.result : null;
    const chainId = chainIdHex ? Number.parseInt(chainIdHex, 16) : null;
    return {
      reachable: response.ok && chainId === 8453,
      latency_ms: Date.now() - started,
      chain_id: chainId,
      network: "Base",
      sdk: "@synfutures/oyster-sdk",
      market_discovery: "SDK_SERVICE_REQUIRED",
      execution: "WALLET_APPROVAL_REQUIRED",
    };
  } catch {
    return {
      reachable: false,
      latency_ms: Date.now() - started,
      chain_id: null,
      network: "Base",
      sdk: "@synfutures/oyster-sdk",
      market_discovery: "SDK_SERVICE_REQUIRED",
      execution: "WALLET_APPROVAL_REQUIRED",
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json(500, { ok: false, code: "CONFIG_ERROR" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json(401, { ok: false, code: "UNAUTHENTICATED" });

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return json(401, { ok: false, code: "UNAUTHENTICATED" });

  const [{ data: owner }, { data: adminRole }] = await Promise.all([
    admin.rpc("has_role", { _user_id: userData.user.id, _role: "owner" }),
    admin.rpc("has_role", { _user_id: userData.user.id, _role: "admin" }),
  ]);
  if (owner !== true && adminRole !== true) {
    return json(403, { ok: false, code: "OWNER_OR_ADMIN_REQUIRED" });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return json(400, { ok: false, code: "INVALID_BODY" });
  }
  const jurisdiction = String(payload.jurisdiction ?? "US").toUpperCase() as Jurisdiction;
  if (!(["US", "JM", "MX"] as const).includes(jurisdiction)) {
    return json(400, { ok: false, code: "UNSUPPORTED_JURISDICTION" });
  }

  const aster = getAdapter("aster");
  if (!aster) return json(500, { ok: false, code: "ASTER_ADAPTER_MISSING" });
  const [health, markets, synfutures] = await Promise.all([
    aster.healthCheck({ apiKey: "", apiSecret: "" }),
    aster.fetchMarkets(),
    probeBaseRpc(),
  ]);

  const asterMarkets = markets.ok ? markets.data : [];
  const targetSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
  const available = new Set(asterMarkets.map((market) => market.symbol.toUpperCase()));

  return json(200, {
    ok: true,
    scenario: {
      jurisdiction,
      simulated_only: true,
      changes_network_route: false,
      authorizes_live_execution: false,
    },
    checked_at: new Date().toISOString(),
    venues: {
      aster: {
        api_version: "v3",
        public_data_reachable: health.ok && health.data.reachable,
        latency_ms: health.ok ? (health.data.latencyMs ?? null) : null,
        market_count: asterMarkets.length,
        target_symbols: Object.fromEntries(
          targetSymbols.map((symbol) => [symbol, available.has(symbol)]),
        ),
        public_data_error:
          health.ok && markets.ok
            ? null
            : !health.ok
              ? health.code
              : !markets.ok
                ? markets.code
                : null,
        execution: "AGENT_WALLET_SIGNER_REQUIRED",
      },
      synfutures,
    },
  });
});
