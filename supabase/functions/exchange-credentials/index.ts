// Secure credential flow for exchange connections.
// - Authenticated Turtle Bot users only (JWT verified via Supabase Auth).
// - Encrypts API key/secret/passphrase server-side with AES-256-GCM.
// - Never returns decrypted credentials. Never logs secrets.
// - Uses service role only inside this function.
// - Actions: connect | replace | disconnect.
// - Allowlist includes Kraken Spot and ApeX Omni.
// - Sets status='pending_verification' until server-side verification succeeds.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  getAdapter,
  type AdapterResult,
  type ExchangeErrorCode,
} from "../_shared/exchange-adapter.ts";
import {
  isQuorumarkMvpMode,
  quorumarkMvpDisabledResponse,
} from "../_shared/quorumark-mvp-guard.ts";

const SUPPORTED = new Set(["btcc", "bydfi", "kraken", "apex_omni", "apex_omni_testnet", "aster"]);
const TESTNET_EXCHANGES = new Set(["apex_omni_testnet"]);

function connectionEnvironment(exchange: string): string {
  return TESTNET_EXCHANGES.has(exchange) ? "testnet" : "production";
}

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
  // sanitized error - never includes credentials, IVs, or keys
  return json(status, { ok: false, code, message });
}

async function callPrivateSigner(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const baseUrl = (Deno.env.get("SIGNER_BASE_URL") ?? "").replace(/\/$/, "");
  const secret = Deno.env.get("SIGNER_SHARED_SECRET") ?? "";
  if (!baseUrl || !secret) {
    return { ok: false, status: 503, body: { detail: "SIGNER_NOT_CONFIGURED" } };
  }
  const bodyStr = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${ts}\n${nonce}\n${path}\n${bodyStr}`),
    ),
  );
  const signature = Array.from(signatureBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": signature,
      },
      body: bodyStr,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 503, body: { detail: "SIGNER_UNREACHABLE" } };
  } finally {
    clearTimeout(timeout);
  }
}

function signerAdapterCode(detail: unknown): ExchangeErrorCode {
  const code = String(detail ?? "").toUpperCase();
  if (code.includes("REGION") || code.includes("WAF")) return "IP_RESTRICTION";
  if (code.includes("RATE") || code.includes("429") || code.includes("418")) return "RATE_LIMITED";
  if (code.includes("AUTH") || code.includes("KEY") || code.includes("SIGNATURE")) {
    return "INVALID_SIGNATURE";
  }
  if (
    code.includes("UNREACHABLE") ||
    code.includes("UNAVAILABLE") ||
    code.includes("TIMEOUT") ||
    code.includes("503")
  ) {
    return "EXCHANGE_UNAVAILABLE";
  }
  return "UNKNOWN_ERROR";
}

async function deriveAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("TURTLE_CREDENTIAL_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error("MISSING_ENCRYPTION_KEY");
  }
  // Accept any secret with >= 32 bytes of entropy; normalize to a 32-byte
  // AES key with SHA-256. Fail closed if the raw secret is too short.
  const raw = new TextEncoder().encode(secret);
  if (raw.byteLength < 32) {
    throw new Error("SHORT_ENCRYPTION_KEY");
  }
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptField(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  // Store as "v1:<base64(iv)>:<base64(ciphertext||authTag)>".
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

async function decryptField(key: CryptoKey, packed: string): Promise<string> {
  const parts = packed.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("BAD_CIPHERTEXT");
  const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const iv = b64d(parts[1]);
  const ct = b64d(parts[2]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return fail(500, "CONFIG_ERROR", "Backend is not configured.");
  }

  // 1) Verify caller JWT (or diagnostic bypass for whoami_diag).
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const diagHeader = req.headers.get("x-whoami-diag-token") ?? "";
  const diagToken = Deno.env.get("WHOAMI_DIAG_TOKEN") ?? "";
  const isDiagBypass = diagHeader && diagToken && diagHeader === diagToken;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let userId = "";
  if (!isDiagBypass) {
    if (!token) return fail(401, "UNAUTHENTICATED", "Sign in required.");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return fail(401, "UNAUTHENTICATED", "Sign in required.");
    userId = userData.user.id;
  }

  if (isQuorumarkMvpMode()) {
    return quorumarkMvpDisabledResponse("exchange-credentials", corsHeaders);
  }

  // 2) Parse body.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "INVALID_BODY", "Invalid JSON body.");
  }

  const action = String(body.action ?? "");
  if (
    ![
      "connect",
      "replace",
      "disconnect",
      "test",
      "summary",
      "wallet_identities",
      "preflight_disconnect",
      "pause",
      "resume",
      "key_fingerprint",
      "key_parity",
      "register_account",
      "whoami_diag",
    ].includes(action)
  ) {
    return fail(400, "INVALID_ACTION", "Unknown action.");
  }

  if (action === "wallet_identities") {
    // Read-only account display metadata. Never accept a caller-supplied owner
    // or connection list, and never allow the diagnostic bypass on this path.
    if (!userId || isDiagBypass) return fail(401, "UNAUTHENTICATED", "Sign in required.");
    const { data: connections, error } = await admin
      .from("exchange_connections")
      .select("id,exchange,environment")
      .eq("user_id", userId)
      .eq("status", "verified");
    if (error) return fail(503, "IDENTITY_UNAVAILABLE", "Wallet identity unavailable.");
    const identities = await Promise.all(
      (connections ?? []).map(async (connection) => {
        let address: string | null = null;
        try {
          if (connection.exchange === "aster") {
            // Aster's api_key slot contains its PUBLIC master account address.
            // Do not select/decrypt the agent private key or passphrase here.
            const { data: credential } = await admin
              .from("exchange_credentials")
              .select("encrypted_api_key")
              .eq("connection_id", connection.id)
              .maybeSingle();
            if (credential?.encrypted_api_key) {
              const candidate = await decryptField(
                await deriveAesKey(),
                credential.encrypted_api_key,
              );
              if (/^0x[a-fA-F0-9]{40}$/.test(candidate)) address = candidate.toLowerCase();
            }
          } else if (["apex_omni", "apex_omni_testnet"].includes(connection.exchange)) {
            const environment = String(connection.environment).startsWith("test")
              ? "testnet"
              : "mainnet";
            const { data: credentials } = await admin
              .from("apex_execution_credentials")
              .select("wallet_address")
              .eq("exchange_connection_id", connection.id)
              .eq("user_id", userId)
              .eq("environment", environment)
              .eq("active", true)
              .is("revoked_at", null);
            const addresses = [
              ...new Set(
                (credentials ?? []).map((row) => String(row.wallet_address).toLowerCase()),
              ),
            ];
            if (addresses.length === 1 && /^0x[a-f0-9]{40}$/.test(addresses[0]))
              address = addresses[0];
          }
        } catch {
          // No decryption errors or stored material in logs/responses.
        }
        return {
          connection_id: connection.id,
          exchange: connection.exchange,
          account_address: address,
        };
      }),
    );
    return json(200, { ok: true, identities });
  }

  // Diagnostic: sha256(sha256(secret_utf8))[:8]. Reveals nothing about the key.
  async function edgeFingerprint(): Promise<string> {
    const secret = Deno.env.get("TURTLE_CREDENTIAL_ENCRYPTION_KEY");
    if (!secret) return "MISSING";
    const raw = new TextEncoder().encode(secret);
    if (raw.byteLength < 32) return "SHORT";
    const inner = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const outer = new Uint8Array(await crypto.subtle.digest("SHA-256", inner));
    return Array.from(outer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 8);
  }

  if (action === "key_fingerprint") {
    return json(200, { ok: true, key_fingerprint: await edgeFingerprint() });
  }

  if (action === "key_parity") {
    const connectionId = String(body.connection_id ?? "");
    const edgeFp = await edgeFingerprint();
    let signerFp: string | null = null;
    let signerStatus: string | null = null;
    let signerError: string | null = null;
    try {
      const baseUrl = (Deno.env.get("SIGNER_BASE_URL") ?? "").replace(/\/$/, "");
      const secret = Deno.env.get("SIGNER_SHARED_SECRET") ?? "";
      if (!baseUrl || !secret) {
        signerError = "SIGNER_NOT_CONFIGURED";
      } else {
        const path = "/v1/rest-decrypt-selftest";
        const bodyStr = JSON.stringify({ user_id: userId, exchange_connection_id: connectionId });
        const ts = String(Math.floor(Date.now() / 1000));
        const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
        const nonce = Array.from(nonceBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sigBytes = new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${ts}\n${nonce}\n${path}\n${bodyStr}`),
          ),
        );
        const sig = Array.from(sigBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-signer-timestamp": ts,
              "x-signer-nonce": nonce,
              "x-signer-signature": sig,
            },
            body: bodyStr,
            signal: controller.signal,
          });
          const text = await res.text().catch(() => "");
          let raw: Record<string, unknown> = {};
          try {
            raw = text ? JSON.parse(text) : {};
          } catch {
            /* ignore */
          }
          signerFp = typeof raw.key_fingerprint === "string" ? raw.key_fingerprint : null;
          signerStatus = typeof raw.status === "string" ? raw.status : null;
          if (!res.ok && !signerFp) {
            const detail = typeof raw.detail === "string" ? raw.detail : `HTTP_${res.status}`;
            signerError = detail;
          }
        } finally {
          clearTimeout(t);
        }
      }
    } catch (e) {
      signerError = e instanceof Error ? e.message : "SIGNER_CALL_FAILED";
    }
    return json(200, {
      ok: true,
      edge_key_fingerprint: edgeFp,
      signer_key_fingerprint: signerFp,
      signer_status: signerStatus,
      signer_error: signerError,
      match: !!signerFp && signerFp === edgeFp,
    });
  }

  if (action === "whoami_diag") {
    // TEMP READ-ONLY diagnostic. Decrypts stored REST creds, calls ApeX
    // /api/v3/user + /api/v3/account, returns identity + balance fields so
    // we can determine whether the funded account is registered / owned by
    // the wallet we sealed against.
    const connectionId = String(body.connection_id ?? "");
    if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
    const { data: conn } = await admin
      .from("exchange_connections")
      .select("id, user_id, exchange, environment")
      .eq("id", connectionId)
      .maybeSingle();
    if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
    if (!isDiagBypass && conn.user_id !== userId)
      return fail(404, "NOT_FOUND", "Connection not found.");
    const { data: credRow } = await admin
      .from("exchange_credentials")
      .select("encrypted_api_key, encrypted_api_secret, encrypted_passphrase")
      .eq("connection_id", connectionId)
      .maybeSingle();
    if (!credRow) return fail(404, "MISSING_CREDENTIALS", "No stored REST creds.");
    const aesKey = await deriveAesKey();
    let apiKey = "",
      apiSecret = "",
      passphrase = "";
    try {
      apiKey = await decryptField(aesKey, credRow.encrypted_api_key);
      apiSecret = await decryptField(aesKey, credRow.encrypted_api_secret);
      if (credRow.encrypted_passphrase)
        passphrase = await decryptField(aesKey, credRow.encrypted_passphrase);
    } catch {
      return fail(500, "DECRYPT_FAILED", "Could not decrypt.");
    }

    const base = String(conn.environment).toLowerCase().startsWith("test")
      ? "https://qa.omni.apex.exchange"
      : "https://omni.apex.exchange";
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    async function signGet(path: string): Promise<Response> {
      const ts = String(Date.now());
      const msg = `${ts}GET${path}`;
      const keyStr = btoa(unescape(encodeURIComponent(apiSecret)));
      const hk = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(keyStr),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = b64(
        new Uint8Array(await crypto.subtle.sign("HMAC", hk, new TextEncoder().encode(msg))),
      );
      return fetch(base + path, {
        headers: {
          "APEX-API-KEY": apiKey,
          "APEX-SIGNATURE": sig,
          "APEX-TIMESTAMP": ts,
          "APEX-PASSPHRASE": passphrase,
        },
      });
    }
    async function fetchJson(path: string) {
      try {
        const r = await signGet(path);
        const t = await r.text();
        let j: any = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch {
          j = { _raw: t.slice(0, 400) };
        }
        return { http: r.status, body: j };
      } catch (e) {
        return { http: 0, body: { error: String(e) } };
      }
    }
    const userRes = await fetchJson("/api/v3/user");
    const acctRes = await fetchJson("/api/v3/account");
    apiKey = "";
    apiSecret = "";
    passphrase = "";

    const u = (userRes.body?.data ?? userRes.body) || {};
    const a = (acctRes.body?.data ?? acctRes.body) || {};
    const subs = Array.isArray(u.subAccounts)
      ? u.subAccounts
      : Array.isArray(a.subAccounts)
        ? a.subAccounts
        : [];
    const pickBalance = (obj: any) => ({
      id: obj?.id ?? obj?.accountId ?? obj?.subAccountId ?? null,
      accountId: obj?.accountId ?? null,
      subAccountId: obj?.subAccountId ?? obj?.id ?? null,
      equity:
        obj?.equity ??
        obj?.totalEquity ??
        obj?.totalEquityValue ??
        obj?.balance ??
        obj?.walletBalance ??
        null,
      availableBalance: obj?.availableBalance ?? obj?.available ?? obj?.free ?? null,
      totalBalance: obj?.totalBalance ?? obj?.totalWalletBalance ?? null,
      usdtBalance: obj?.usdtBalance ?? obj?.USDT ?? null,
      initialMargin: obj?.initialMargin ?? obj?.usedMargin ?? null,
      marginBalance: obj?.marginBalance ?? null,
      currency: obj?.currency ?? obj?.token ?? obj?.asset ?? null,
      rawKeys: obj && typeof obj === "object" ? Object.keys(obj).slice(0, 30) : [],
    });
    const summarizeWallets = (value: any) =>
      Array.isArray(value) ? value.slice(0, 12).map((w: any) => pickBalance(w)) : [];
    const summarizeSubAccounts = (value: any) => {
      const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
      return rows.slice(0, 12).map((s: any) => ({
        ...pickBalance(s),
        wallets: summarizeWallets(s?.wallets ?? s?.assets ?? s?.balances),
      }));
    };
    const { data: aec } = await admin
      .from("apex_execution_credentials")
      .select("wallet_address, apex_account_id, environment, active, revoked_at")
      .eq("exchange_connection_id", connectionId)
      .eq("active", true)
      .is("revoked_at", null);
    return json(200, {
      ok: true,
      connection: { id: connectionId, environment: conn.environment, exchange: conn.exchange },
      apex_user_http: userRes.http,
      apex_user: {
        ethereumAddress: u.ethereumAddress ?? u.userAddress ?? null,
        email: u.email ?? null,
        isRegistered: u.isRegistered ?? u.registered ?? null,
        accountId: u.accountId ?? u.id ?? null,
        userId: u.userId ?? null,
        subAccountsCount: Array.isArray(subs) ? subs.length : 0,
        subAccounts: subs.slice(0, 5).map((s: any) => ({
          subAccountId: s.subAccountId ?? s.id ?? null,
          slotId: s.slotId ?? s.slot ?? null,
          nickname: s.nickname ?? null,
        })),
        rawKeys: Object.keys(u).slice(0, 30),
      },
      apex_account_http: acctRes.http,
      apex_account: {
        accountId: a.accountId ?? a.id ?? null,
        totalEquityValue: a.totalEquityValue ?? a.totalEquity ?? null,
        availableBalance: a.availableBalance ?? null,
        initialMargin: a.initialMargin ?? null,
        spotAccount: pickBalance(a.spotAccount),
        contractAccount: pickBalance(a.contractAccount),
        omniSwapAccount: pickBalance(a.omniSwapAccount),
        eventAccount: pickBalance(a.eventAccount),
        spotSubAccounts: summarizeSubAccounts(a.spotAccount?.subAccounts),
        contractSubAccounts: summarizeSubAccounts(
          a.contractAccount?.subAccountInfo ?? a.contractAccount?.subAccounts,
        ),
        contractSubAccountInfoType: Array.isArray(a.contractAccount?.subAccountInfo)
          ? "array"
          : a.contractAccount?.subAccountInfo === null
            ? "null"
            : typeof a.contractAccount?.subAccountInfo,
        contractSubAccountInfoKeys:
          a.contractAccount?.subAccountInfo && typeof a.contractAccount.subAccountInfo === "object"
            ? Object.keys(a.contractAccount.subAccountInfo).slice(0, 30)
            : [],
        spotWallets: summarizeWallets(a.spotWallets),
        contractWallets: summarizeWallets(a.contractWallets),
        omniSwapWallets: summarizeWallets(a.omniSwapWallets),
        eventWallets: summarizeWallets(a.eventWallets),
        rawKeys: Object.keys(a).slice(0, 30),
      },
      stored_stark: (aec ?? []).map((r: any) => ({
        wallet_address: r.wallet_address,
        apex_account_id: r.apex_account_id,
        environment: r.environment,
      })),
    });
  }

  if (action === "register_account") {
    // Auto-register: signer decrypts the STARK bundle we already onboarded and
    // signs ApeX's onboarding challenge (`/api/v3/generate-nonce` +
    // `/api/v3/new-onboarding`). This action MUST NOT overwrite the owner's
    // manually saved ApeX REST API key; that key is the read/trade authority
    // for the funded account shown in ApeX. Registration only proves/repairs
    // the STARK account side and keeps REST credentials untouched.
    const connectionId = String(body.connection_id ?? "");
    if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
    const { data: conn } = await admin
      .from("exchange_connections")
      .select("id, user_id, environment, exchange")
      .eq("id", connectionId)
      .maybeSingle();
    if (!conn || conn.user_id !== userId) {
      return fail(404, "NOT_FOUND", "Connection not found.");
    }
    if (conn.exchange !== "apex_omni" && conn.exchange !== "apex_omni_testnet") {
      return fail(400, "UNSUPPORTED_EXCHANGE", "Only ApeX Omni connections support auto-register.");
    }

    const baseUrl = (Deno.env.get("SIGNER_BASE_URL") ?? "").replace(/\/$/, "");
    const secret = Deno.env.get("SIGNER_SHARED_SECRET") ?? "";
    if (!baseUrl || !secret) return fail(500, "SIGNER_NOT_CONFIGURED", "Signer is not configured.");
    const path = "/v1/register-account";
    const forwardBody = {
      user_id: userId,
      exchange_connection_id: connectionId,
      environment: String(conn.environment ?? "mainnet"),
      caller_jwt: token,
    };
    const bodyStr = JSON.stringify(forwardBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(`${ts}\n${nonce}\n${path}\n${bodyStr}`),
      ),
    );
    const sig = Array.from(sigBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let signerRes: Response;
    try {
      signerRes = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": ts,
          "x-signer-nonce": nonce,
          "x-signer-signature": sig,
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as { name?: string })?.name === "AbortError";
      return fail(
        504,
        aborted ? "SIGNER_TIMEOUT" : "SIGNER_UNREACHABLE",
        "Could not reach signer.",
      );
    }
    clearTimeout(timer);
    const text = await signerRes.text().catch(() => "");
    let raw: Record<string, unknown> = {};
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      /* ignore */
    }
    if (!signerRes.ok) {
      const detail =
        typeof raw.detail === "string" ? raw.detail : `SIGNER_HTTP_${signerRes.status}`;
      return json(signerRes.status >= 400 && signerRes.status < 600 ? signerRes.status : 502, {
        ok: false,
        code: detail,
        message: "Signer refused registration.",
      });
    }
    // IMPORTANT: do not persist the onboarding `account_id` as an execution
    // fallback. The active ApeX REST key must be the account source of truth;
    // stale cached account IDs have caused valid funded accounts to be read as
    // "Account not found". Clear any legacy cached value for this connection.
    const connEnv = String(conn.environment ?? "").toLowerCase();
    const credentialEnvironments = ["mainnet", "production", "prod", "live"].includes(connEnv)
      ? ["mainnet", "production", "prod", "live"]
      : ["testnet", "sandbox", "staging", "qa", "dev", "development"].includes(connEnv)
        ? ["testnet", "sandbox", "staging", "qa", "dev", "development"]
        : [String(conn.environment ?? "")];
    const { error: accountErr } = await admin
      .from("apex_execution_credentials")
      .update({ apex_account_id: null })
      .eq("user_id", userId)
      .eq("exchange_connection_id", connectionId)
      .in("environment", credentialEnvironments)
      .eq("active", true)
      .is("revoked_at", null);
    if (accountErr) {
      return fail(500, "ACCOUNT_ID_CLEAR_FAILED", "Could not clear stale account id.");
    }

    // Registration success proves the signer could decrypt the active signing
    // bundle, ApeX accepted the wallet onboarding, and fresh REST credentials
    // were minted + stored. Promote this connection immediately; otherwise the
    // broker rejects proof-of-life with CONNECTION_NOT_VERIFIED even though the
    // account is now registered.
    const now = new Date().toISOString();
    await admin
      .from("exchange_connections")
      .update({
        status: "verified",
        permission_read: true,
        permission_trade: true,
        permissions_verified: true,
        permission_verified_at: now,
        last_verified_at: now,
        last_health_check_at: now,
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", connectionId);

    await admin.from("connection_audit_events").insert({
      user_id: userId,
      connection_id: connectionId,
      event: "account_registered",
      reason: null,
      metadata: {
        account_id: raw.account_id ?? null,
        environment: conn.environment,
        rest_credentials_preserved: true,
        cached_account_id_cleared: true,
      },
    });

    return json(200, {
      ok: true,
      status: "verified",
      connection_id: connectionId,
      account_id: raw.account_id ?? null,
    });
  }

  // 3) Validate encryption key up front (fail closed).
  let aesKey: CryptoKey;
  try {
    aesKey = await deriveAesKey();
  } catch (e) {
    const code = e instanceof Error ? e.message : "ENCRYPTION_KEY_ERROR";
    return fail(
      500,
      code === "MISSING_ENCRYPTION_KEY" ? "MISSING_ENCRYPTION_KEY" : "ENCRYPTION_KEY_ERROR",
      "Server credential encryption is not configured.",
    );
  }

  // Helper: assert caller owns this connection.
  async function ownedConn(id: string) {
    if (!id) return null;
    const { data } = await admin
      .from("exchange_connections")
      .select("id, user_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!data || data.user_id !== userId) return null;
    return data;
  }
  // Helper: count open positions the venue still reports for this connection.
  // Fail-closed: on any error, return null so caller treats state as unknown.
  async function openPositionCount(id: string): Promise<number | null> {
    const { count, error } = await admin
      .from("positions")
      .select("id", { head: true, count: "exact" })
      .eq("user_id", userId)
      .eq("connection_id", id)
      .eq("status", "open");
    if (error) return null;
    return count ?? 0;
  }
  async function audit(
    event: string,
    connectionId: string | null,
    reason: string | null,
    metadata: Record<string, unknown>,
  ) {
    await admin.from("connection_audit_events").insert({
      user_id: userId,
      connection_id: connectionId,
      event,
      reason,
      metadata,
    });
  }

  try {
    if (action === "preflight_disconnect") {
      const connectionId = String(body.connection_id ?? "");
      const conn = await ownedConn(connectionId);
      if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
      const openCount = await openPositionCount(connectionId);
      await audit("disconnect_preflight", connectionId, null, { open_positions: openCount });
      return json(200, {
        ok: true,
        connection_id: connectionId,
        open_positions: openCount,
        // fail-closed hint: null means we could not verify
        can_verify: openCount !== null,
      });
    }

    if (action === "pause") {
      const connectionId = String(body.connection_id ?? "");
      const reason = body.reason ? String(body.reason).slice(0, 500) : null;
      const conn = await ownedConn(connectionId);
      if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
      // Insert (or refresh) a connection-scope kill switch.
      const { error: ksErr } = await admin
        .from("kill_switches")
        .upsert(
          {
            scope: "connection",
            user_id: userId,
            connection_id: connectionId,
            active: true,
            reason,
          },
          { onConflict: "connection_id" },
        );
      if (ksErr) return fail(500, "PAUSE_FAILED", "Could not pause the connection.");
      await admin.from("exchange_connections").update({ status: "paused" }).eq("id", connectionId);
      await audit("pause", connectionId, reason, {});
      return json(200, { ok: true, connection_id: connectionId, status: "paused" });
    }

    if (action === "resume") {
      const connectionId = String(body.connection_id ?? "");
      const conn = await ownedConn(connectionId);
      if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
      const { error: ksErr } = await admin
        .from("kill_switches")
        .delete()
        .eq("scope", "connection")
        .eq("connection_id", connectionId);
      if (ksErr) return fail(500, "RESUME_FAILED", "Could not resume the connection.");
      // Downgrade the visible status back to a neutral state; a subsequent
      // `test` call will re-verify and promote it to 'verified'.
      await admin
        .from("exchange_connections")
        .update({ status: "pending_verification" })
        .eq("id", connectionId);
      await audit("resume", connectionId, null, {});
      return json(200, { ok: true, connection_id: connectionId, status: "pending_verification" });
    }

    if (action === "disconnect") {
      const connectionId = String(body.connection_id ?? "");
      if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
      const acknowledgePositions = body.acknowledge_positions === true;
      const reason = body.reason ? String(body.reason).slice(0, 500) : null;
      const conn = await ownedConn(connectionId);
      if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");

      // Safe Disconnect preflight — fail closed. We NEVER close positions on
      // the user's behalf. If we cannot verify the position count, or open
      // positions exist without explicit acknowledgement, refuse.
      const openCount = await openPositionCount(connectionId);
      if (openCount === null) {
        await audit("disconnect_blocked", connectionId, reason, { code: "POSITION_CHECK_FAILED" });
        return fail(
          409,
          "POSITION_CHECK_FAILED",
          "We could not verify open positions. Try again in a moment.",
        );
      }
      if (openCount > 0 && !acknowledgePositions) {
        await audit("disconnect_blocked", connectionId, reason, {
          code: "OPEN_POSITIONS",
          open_positions: openCount,
        });
        return fail(
          409,
          "OPEN_POSITIONS",
          `You have ${openCount} open position${openCount === 1 ? "" : "s"} on this connection. Close them on the exchange, or confirm you want to disconnect anyway.`,
        );
      }

      // Irreversibly disable the credential row (delete) and mark disconnected.
      await admin.from("exchange_credentials").delete().eq("connection_id", connectionId);
      const { error: upErr } = await admin
        .from("exchange_connections")
        .update({
          status: "disconnected",
          permissions_verified: false,
          last_verified_at: null,
          last_error_code: null,
          last_error_message: null,
        })
        .eq("id", connectionId);
      if (upErr) return fail(500, "UPDATE_FAILED", "Could not disconnect.");
      // Clear any lingering pause switch so a future reconnect starts clean.
      await admin
        .from("kill_switches")
        .delete()
        .eq("scope", "connection")
        .eq("connection_id", connectionId);
      await audit("disconnect_committed", connectionId, reason, {
        open_positions_at_disconnect: openCount,
        acknowledged: acknowledgePositions,
      });
      return json(200, { ok: true, connection_id: connectionId, status: "disconnected" });
    }

    if (action === "test") {
      // READ-ONLY verification. Decrypts credentials in memory only, calls
      // the adapter's healthCheck + validateCredentials, updates status/error
      // fields. NEVER places an order, NEVER changes leverage/margin, NEVER
      // returns decrypted material.
      const connectionId = String(body.connection_id ?? "");
      if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
      const { data: conn } = await admin
        .from("exchange_connections")
        .select("id, user_id, exchange")
        .eq("id", connectionId)
        .maybeSingle();
      if (!conn || conn.user_id !== userId) {
        return fail(404, "NOT_FOUND", "Connection not found.");
      }
      const adapter = getAdapter(conn.exchange);
      if (!adapter) {
        await admin
          .from("exchange_connections")
          .update({
            status: "unsupported",
            last_error_code: "UNSUPPORTED_EXCHANGE",
            last_error_message: "Exchange is not supported.",
            last_health_check_at: new Date().toISOString(),
          })
          .eq("id", connectionId);
        return fail(400, "UNSUPPORTED_EXCHANGE", "Exchange is not supported.");
      }

      // Mark verifying so the UI reflects the in-flight check.
      await admin
        .from("exchange_connections")
        .update({ status: "verifying", last_health_check_at: new Date().toISOString() })
        .eq("id", connectionId);

      const { data: credRow, error: credErr } = await admin
        .from("exchange_credentials")
        .select("encrypted_api_key, encrypted_api_secret, encrypted_passphrase")
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (credErr || !credRow) {
        await admin
          .from("exchange_connections")
          .update({
            status: "needs_attention",
            last_error_code: "MISSING_CREDENTIALS",
            last_error_message: "Stored credentials not found. Reconnect the exchange.",
          })
          .eq("id", connectionId);
        // Return 200 so supabase.functions.invoke doesn't throw; UI handles
        // the ok:false payload and prompts the owner to reconnect.
        return json(200, {
          ok: false,
          code: "MISSING_CREDENTIALS",
          message: "Stored credentials not found. Reconnect the exchange.",
        });
      }

      let apiKey = "";
      let apiSecret = "";
      let passphrase: string | null = null;
      try {
        apiKey = await decryptField(aesKey, credRow.encrypted_api_key);
        apiSecret = await decryptField(aesKey, credRow.encrypted_api_secret);
        if (credRow.encrypted_passphrase) {
          passphrase = await decryptField(aesKey, credRow.encrypted_passphrase);
        }
      } catch {
        await admin
          .from("exchange_connections")
          .update({
            status: "needs_attention",
            last_error_code: "DECRYPT_FAILED",
            last_error_message: "Could not decrypt stored credentials.",
          })
          .eq("id", connectionId);
        // This is an expected repair state after the wrapping key changes.
        // Return a handled payload instead of a function 500 so client routes
        // do not blank-screen from Supabase's EdgeFunctionError wrapper.
        return json(200, {
          ok: false,
          code: "DECRYPT_FAILED",
          message: "Could not decrypt stored credentials.",
          remediation: "Re-save the ApeX API key after the credential key is aligned.",
          connection_id: connectionId,
          status: "needs_attention",
        });
      }

      let result: AdapterResult<unknown>;
      let venueWithdrawEnabled: boolean | null = null;
      let verifiedPermissions: { read: boolean; trade: boolean; withdraw: boolean } | null = null;
      try {
        if (conn.exchange === "aster") {
          const signer = await callPrivateSigner("/v1/verify-credentials", {
            user_id: userId,
            exchange_connection_id: connectionId,
          });
          result =
            signer.ok && signer.body.verified === true
              ? {
                  ok: true,
                  data: { permissions: { read: true, trade: true, withdraw: false } },
                }
              : {
                  ok: false,
                  code: signerAdapterCode(
                    signer.body.reject_reason ?? signer.body.detail ?? "SIGNER_UNREACHABLE",
                  ),
                  message: "Aster agent-wallet verification failed.",
                };
        } else {
          const health = await adapter.healthCheck({ apiKey, apiSecret, passphrase });
          result = health.ok
            ? await adapter.validateCredentials({ apiKey, apiSecret, passphrase })
            : health;
        }
        // Non-custodial scope check. When the venue exposes key permissions
        // (ApeX Omni does via account snapshot), REJECT any key that carries
        // withdrawal capability. Where the venue does not expose it, we fall
        // back to the connect-time attestation stored on the row.
        if (result.ok) {
          const verified = result.data as {
            permissions?: { read: boolean; trade: boolean; withdraw: boolean };
          };
          verifiedPermissions = verified.permissions ?? null;
          venueWithdrawEnabled = verifiedPermissions?.withdraw ?? null;
          // Older adapters return permissions only with the account summary.
          // Avoid repeating Kraken's permission and balance requests after its
          // validation result has already supplied the authoritative scopes.
          if (!verifiedPermissions) {
            try {
              const summary = await adapter.fetchAccountSummary({ apiKey, apiSecret, passphrase });
              if (summary.ok) {
                const perms = (summary.data as { permissions?: { withdraw?: boolean } })
                  .permissions;
                if (perms && typeof perms.read === "boolean" && typeof perms.trade === "boolean") {
                  verifiedPermissions = {
                    read: perms.read,
                    trade: perms.trade,
                    withdraw: perms.withdraw === true,
                  };
                }
                if (perms && typeof perms.withdraw === "boolean") {
                  venueWithdrawEnabled = perms.withdraw;
                }
              }
            } catch {
              venueWithdrawEnabled = null;
            }
          }
        }
      } catch {
        result = { ok: false, code: "UNKNOWN_ERROR", message: "Verification failed." };
      } finally {
        // Wipe plaintext buffers ASAP.
        apiKey = "";
        apiSecret = "";
        passphrase = null;
      }

      const now = new Date().toISOString();
      if (result.ok && venueWithdrawEnabled === true) {
        await admin
          .from("exchange_connections")
          .update({
            status: "needs_attention",
            permissions_verified: false,
            withdrawals_disabled: false,
            last_health_check_at: now,
            last_error_code: "WITHDRAWAL_SCOPE_PRESENT",
            last_error_message:
              "This key has withdrawal access. Turtle Bot is non-custodial and only accepts trade-only keys. Please disable withdrawals and re-create the key.",
          })
          .eq("id", connectionId);
        return json(200, {
          ok: false,
          code: "WITHDRAWAL_SCOPE_PRESENT",
          message:
            "This key has withdrawal access. Turtle Bot is non-custodial and only accepts trade-only keys. Please disable withdrawals and re-create the key.",
          connection_id: connectionId,
          status: "needs_attention",
        });
      }
      if (result.ok) {
        const permissionRead = verifiedPermissions?.read ?? true;
        const permissionTrade = verifiedPermissions?.trade ?? false;
        await admin
          .from("exchange_connections")
          .update({
            status: "verified",
            permission_read: permissionRead,
            permission_trade: permissionTrade,
            permissions_verified: true,
            permission_verified_at: now,
            permission_scopes: {
              read: permissionRead,
              trade: permissionTrade,
              withdraw: false,
            },
            last_verified_at: now,
            last_health_check_at: now,
            last_error_code: null,
            last_error_message: null,
          })
          .eq("id", connectionId);
        return json(200, { ok: true, connection_id: connectionId, status: "verified" });
      }

      // INTEGRATION_PENDING keeps status pending_verification. Real error
      // codes flip to needs_attention.
      const nextStatus =
        result.code === "INTEGRATION_PENDING" ? "pending_verification" : "needs_attention";
      await admin
        .from("exchange_connections")
        .update({
          status: nextStatus,
          permissions_verified: false,
          last_health_check_at: now,
          last_error_code: result.code,
          last_error_message: result.message,
        })
        .eq("id", connectionId);
      return json(200, {
        ok: false,
        code: result.code,
        message: result.message,
        connection_id: connectionId,
        status: nextStatus,
      });
    }

    if (action === "summary") {
      // READ-ONLY balance fetch. Decrypts credentials in memory only, calls
      // the adapter's fetchAccountSummary. Never writes orders/leverage.
      // Never returns decrypted material.
      const connectionId = String(body.connection_id ?? "");
      if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
      const { data: conn } = await admin
        .from("exchange_connections")
        .select("id, user_id, exchange, status")
        .eq("id", connectionId)
        .maybeSingle();
      if (!conn || conn.user_id !== userId) {
        return fail(404, "NOT_FOUND", "Connection not found.");
      }
      const adapter = getAdapter(conn.exchange);
      if (!adapter) return fail(400, "UNSUPPORTED_EXCHANGE", "Exchange is not supported.");

      const { data: credRow } = await admin
        .from("exchange_credentials")
        .select("encrypted_api_key, encrypted_api_secret, encrypted_passphrase")
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (!credRow) {
        return json(200, {
          ok: false,
          code: "MISSING_CREDENTIALS",
          message: "Stored credentials not found. Reconnect the exchange.",
        });
      }

      let apiKey = "",
        apiSecret = "",
        passphrase: string | null = null;
      try {
        apiKey = await decryptField(aesKey, credRow.encrypted_api_key);
        apiSecret = await decryptField(aesKey, credRow.encrypted_api_secret);
        if (credRow.encrypted_passphrase) {
          passphrase = await decryptField(aesKey, credRow.encrypted_passphrase);
        }
      } catch {
        // Account summary is a read-only UI convenience. A decrypt failure here
        // means stored credentials need to be re-saved with the active key; it
        // should not surface as an unhandled function 500 / blank screen.
        return json(200, {
          ok: false,
          code: "DECRYPT_FAILED",
          message: "Could not decrypt stored credentials.",
          remediation: "Re-save the ApeX API key after the credential key is aligned.",
        });
      }

      let result;
      try {
        if (conn.exchange === "aster") {
          const signer = await callPrivateSigner("/v1/read-account", {
            user_id: userId,
            exchange_connection_id: connectionId,
          });
          result =
            signer.ok && signer.body.status === "ok" && signer.body.account
              ? { ok: true, data: signer.body.account }
              : {
                  ok: false,
                  code: signerAdapterCode(
                    signer.body.reject_reason ?? signer.body.detail ?? "SIGNER_UNREACHABLE",
                  ),
                  message: "Aster account read failed.",
                };
        } else {
          result = await adapter.fetchAccountSummary({ apiKey, apiSecret, passphrase });
        }
      } catch (e) {
        console.error("[summary] adapter threw", {
          exchange: conn.exchange,
          connection_id: connectionId,
          message: e instanceof Error ? e.message : String(e),
        });
        result = { ok: false as const, code: "UNKNOWN_ERROR", message: "Summary failed." };
      } finally {
        apiKey = "";
        apiSecret = "";
        passphrase = null;
      }
      if (!result.ok) {
        console.warn("[summary] adapter returned error", {
          exchange: conn.exchange,
          connection_id: connectionId,
          code: result.code,
          message: result.message,
        });
        return json(200, { ok: false, code: result.code, message: result.message });
      }
      // Flag suspiciously-empty successful reads (e.g. adapter parsed no
      // fields from a shape-mismatched 200 response). Do NOT change the
      // response — this is diagnostic only.
      const s = result.data as {
        totalEquity?: number;
        availableBalance?: number;
        inTrades?: number;
      };
      if (
        (s.totalEquity === undefined || s.totalEquity === 0) &&
        (s.availableBalance === undefined || s.availableBalance === 0) &&
        (s.inTrades === undefined || s.inTrades === 0)
      ) {
        console.warn("[summary] adapter parsed empty balance", {
          exchange: conn.exchange,
          connection_id: connectionId,
          parsed: s,
        });
      }
      return json(200, { ok: true, connection_id: connectionId, summary: result.data });
    }

    const exchange = String(body.exchange ?? "").toLowerCase();
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    const apiSecret = typeof body.api_secret === "string" ? body.api_secret.trim() : "";
    const passphrase = typeof body.passphrase === "string" ? body.passphrase.trim() : "";
    // ApeX Omni Key seed. OPTIONAL at connect time; required later for L2/zk
    // order signing. Encrypted with the SAME AES-GCM scheme as api_secret and
    // NEVER returned to clients. Treated at equal-or-higher care than api_secret.
    const omniSeed = typeof body.omni_seed === "string" ? body.omni_seed.trim() : "";
    // NON-CUSTODIAL guarantee: TurtleBot only accepts trade-only keys. The
    // UI collects an explicit user attestation; we refuse to persist the
    // credential without it. See docs/ONBOARDING_SECURITY.md §8.
    const withdrawalsAttested = body.withdrawals_disabled_attestation === true;
    const displayName =
      typeof body.display_name === "string" ? body.display_name.trim().slice(0, 60) : null;

    if (!SUPPORTED.has(exchange)) {
      return fail(400, "UNSUPPORTED_EXCHANGE", "Exchange is not supported.");
    }
    if (apiKey.length < 5 || apiSecret.length < 5) {
      return fail(400, "INVALID_INPUT", "API key and secret are required.");
    }
    if (!withdrawalsAttested) {
      return fail(
        400,
        "WITHDRAWAL_ATTESTATION_REQUIRED",
        "Turtle Bot is non-custodial. Create a trade-only API key with withdrawals disabled, then confirm the checkbox.",
      );
    }

    const encKey = await encryptField(aesKey, apiKey);
    const encSecret = await encryptField(aesKey, apiSecret);
    const encPass = passphrase ? await encryptField(aesKey, passphrase) : null;
    // Only apex_omni currently uses the Omni Key seed for L2 signing.
    const encOmniSeed =
      omniSeed && exchange === "apex_omni" ? await encryptField(aesKey, omniSeed) : null;

    let connectionId: string;

    if (action === "replace") {
      const replaceId = String(body.connection_id ?? "");
      if (!replaceId) return fail(400, "INVALID_INPUT", "connection_id required.");
      const { data: existing } = await admin
        .from("exchange_connections")
        .select("id, user_id")
        .eq("id", replaceId)
        .maybeSingle();
      if (!existing || existing.user_id !== userId) {
        return fail(404, "NOT_FOUND", "Connection not found.");
      }
      connectionId = replaceId;
      const { error: upErr } = await admin
        .from("exchange_connections")
        .update({
          exchange,
          display_name: displayName,
          environment: connectionEnvironment(exchange),
          permissions_verified: false,
          status: "pending_verification",
          withdrawals_disabled: true,
          last_verified_at: null,
          last_error_code: null,
          last_error_message: null,
        })
        .eq("id", connectionId);
      if (upErr) return fail(500, "UPDATE_FAILED", "Could not update connection.");
      // Rotate ciphertext.
      await admin.from("exchange_credentials").delete().eq("connection_id", connectionId);
      const { error: credErr } = await admin.from("exchange_credentials").insert({
        connection_id: connectionId,
        user_id: userId,
        encrypted_api_key: encKey,
        encrypted_api_secret: encSecret,
        encrypted_passphrase: encPass,
        encrypted_omni_seed: encOmniSeed,
        encryption_version: 1,
        rotated_at: new Date().toISOString(),
      });
      if (credErr) return fail(500, "CRED_WRITE_FAILED", "Could not store credentials.");
      // A newly saved REST API key is authoritative for the funded ApeX
      // account. Clear any legacy cached account id so reads/orders resolve
      // account context from the key itself rather than a stale onboarding id.
      await admin
        .from("apex_execution_credentials")
        .update({ apex_account_id: null })
        .eq("user_id", userId)
        .eq("exchange_connection_id", connectionId)
        .eq("active", true)
        .is("revoked_at", null);
    } else {
      // connect: insert a new connection row.
      const { data: inserted, error: insErr } = await admin
        .from("exchange_connections")
        .insert({
          user_id: userId,
          exchange,
          display_name: displayName,
          environment: connectionEnvironment(exchange),
          permissions_verified: false,
          status: "pending_verification",
          withdrawals_disabled: true,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        const msg = insErr?.message ?? "";
        if (msg.includes("exchange_connections_one_active_per_exchange")) {
          return fail(
            409,
            "ALREADY_CONNECTED",
            "You already have an active connection for this exchange. Replace it instead.",
          );
        }
        return fail(500, "INSERT_FAILED", "Could not create connection.");
      }
      connectionId = inserted.id;
      const { error: credErr } = await admin.from("exchange_credentials").insert({
        connection_id: connectionId,
        user_id: userId,
        encrypted_api_key: encKey,
        encrypted_api_secret: encSecret,
        encrypted_passphrase: encPass,
        encrypted_omni_seed: encOmniSeed,
        encryption_version: 1,
      });
      if (credErr) {
        // roll back the connection row so we never orphan a connection without creds
        await admin.from("exchange_connections").delete().eq("id", connectionId);
        return fail(500, "CRED_WRITE_FAILED", "Could not store credentials.");
      }
    }

    return json(200, {
      ok: true,
      connection_id: connectionId,
      exchange,
      status: "pending_verification",
    });
  } catch {
    // Never leak internal detail. No secret is ever included in errors.
    return fail(500, "INTERNAL_ERROR", "Something went wrong.");
  }
});
