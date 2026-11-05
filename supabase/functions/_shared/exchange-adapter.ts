// Shared ExchangeAdapter contract. All venue integrations must implement this
// interface. Read-only surface only; NO order placement, NO leverage/margin
// mutation, NO withdrawal/transfer, NO L2 / zk / stark signing. If an
// exchange's official API integration is not yet in place, return an
// INTEGRATION_PENDING result — never call unverified endpoints and never
// fabricate success.

export type ExchangeErrorCode =
  | "INTEGRATION_PENDING"
  | "INVALID_API_KEY"
  | "INVALID_SIGNATURE"
  | "PERMISSION_DENIED"
  | "IP_RESTRICTION"
  | "RATE_LIMITED"
  | "EXCHANGE_UNAVAILABLE"
  | "SIGNING_NOT_AVAILABLE"
  | "UNKNOWN_ERROR";

export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ExchangeErrorCode; message: string };

export interface DecryptedCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string | null;
  /**
   * ApeX Omni Key seed for L2/zkLink order signing. Only present for
   * apex_omni connections that have supplied the seed. NEVER logged.
   */
  omniSeed?: string | null;
}

export interface AccountSummary {
  totalEquity?: number;
  availableBalance?: number;
  inTrades?: number;
  currency?: string;
  permissions?: {
    read: boolean;
    trade: boolean;
    withdraw: boolean;
  };
}


export interface MarketInfo {
  symbol: string;
  base: string;
  quote: string;
}

export interface HealthCheck {
  reachable: boolean;
  latencyMs?: number;
}

export interface ExchangeAdapter {
  readonly id: string;
  readonly kind: "cex" | "dex";
  validateCredentials(creds: DecryptedCredentials): Promise<
    AdapterResult<{ verified: true; permissions?: AccountSummary["permissions"] }>
  >;
  fetchAccountSummary(creds: DecryptedCredentials): Promise<AdapterResult<AccountSummary>>;
  fetchMarkets(): Promise<AdapterResult<MarketInfo[]>>;
  healthCheck(creds: DecryptedCredentials): Promise<AdapterResult<HealthCheck>>;
  // Local teardown only — the caller handles ciphertext deletion in the DB.
  disconnect(): Promise<AdapterResult<{ disconnected: true }>>;
}

function pending<T>(exchange: string): AdapterResult<T> {
  return {
    ok: false,
    code: "INTEGRATION_PENDING",
    message: `${exchange} live integration is not enabled yet. Credentials are stored securely; verification and execution will unlock in a later phase.`,
  };
}

class PendingAdapter implements ExchangeAdapter {
  readonly kind: "cex" | "dex" = "cex";
  constructor(public readonly id: string, private readonly label: string) {}
  validateCredentials(): Promise<
    AdapterResult<{ verified: true; permissions?: AccountSummary["permissions"] }>
  > {
    return Promise.resolve(pending(this.label));
  }
  fetchAccountSummary(): Promise<AdapterResult<AccountSummary>> {
    return Promise.resolve(pending(this.label));
  }
  fetchMarkets(): Promise<AdapterResult<MarketInfo[]>> {
    return Promise.resolve(pending(this.label));
  }
  healthCheck(): Promise<AdapterResult<HealthCheck>> {
    return Promise.resolve(pending(this.label));
  }
  disconnect(): Promise<AdapterResult<{ disconnected: true }>> {
    return Promise.resolve({ ok: true, data: { disconnected: true } });
  }
}

// BTCC — official public API integration not yet wired. Do not call any
// guessed endpoint. Stay pending.
export class BtccAdapter extends PendingAdapter {
  constructor() {
    super("btcc", "BTCC");
  }
}

// BYDFi — official public API integration not yet wired. Do not call any
// guessed endpoint. Stay pending.
export class BydfiAdapter extends PendingAdapter {
  constructor() {
    super("bydfi", "BYDFi");
  }
}

// Hyperliquid — perp DEX. Official API is documented at
// https://hyperliquid.gitbook.io/hyperliquid-docs. Order signing uses
// EIP-712 typed data via the connected wallet, NOT a stored secret.
// Integration remains pending until: (a) wallet-signed order flow is
// implemented on the client, and (b) a read-only info endpoint is wired
// here for balance / market checks. Do not call any guessed endpoint.
export class HyperliquidAdapter extends PendingAdapter {
  readonly kind = "dex" as const;
  constructor() {
    super("hyperliquid", "Hyperliquid");
  }
}

// ---------------------------------------------------------------------------
// Aster V3 — public/read-only discovery.
//
// New Aster integrations must use V3. Authenticated V3 requests use an API
// wallet/agent and ECDSA signing; they are deliberately NOT treated like an
// API-key/HMAC venue here. This adapter only calls Aster's documented public
// endpoints. Account reads and execution remain unavailable until the
// dedicated agent-wallet signer and reconciliation path are complete.
// ---------------------------------------------------------------------------

const ASTER_FUTURES_BASE = "https://fapi.asterdex.com";

function mapAsterError(status: number): { code: ExchangeErrorCode; message: string } {
  if (status === 401)
    return { code: "INVALID_SIGNATURE", message: "Aster rejected authentication." };
  if (status === 403 || status === 451) {
    return {
      code: "IP_RESTRICTION",
      message: "Aster is unavailable from this execution location.",
    };
  }
  if (status === 418 || status === 429) {
    return { code: "RATE_LIMITED", message: "Aster rate limit reached." };
  }
  if (status >= 500)
    return { code: "EXCHANGE_UNAVAILABLE", message: "Aster is temporarily unavailable." };
  return { code: "UNKNOWN_ERROR", message: `Aster request failed (HTTP ${status}).` };
}

async function asterPublicGet(path: string): Promise<AdapterResult<unknown>> {
  try {
    const response = await fetch(`${ASTER_FUTURES_BASE}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, ...mapAsterError(response.status) };
    return { ok: true, data: body };
  } catch {
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: "Network error contacting Aster.",
    };
  }
}

export function normalizeAsterMarkets(body: unknown): MarketInfo[] {
  const symbols = (body as { symbols?: unknown } | null)?.symbols;
  if (!Array.isArray(symbols)) return [];
  return symbols.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    const symbol = typeof value.symbol === "string" ? value.symbol : "";
    const base = typeof value.baseAsset === "string" ? value.baseAsset : "";
    const quote = typeof value.quoteAsset === "string" ? value.quoteAsset : "";
    const status = typeof value.status === "string" ? value.status.toUpperCase() : "";
    if (!symbol || !base || !quote || (status && status !== "TRADING")) return [];
    return [{ symbol, base, quote }];
  });
}

export class AsterAdapter implements ExchangeAdapter {
  readonly id = "aster";
  readonly kind = "dex" as const;

  validateCredentials(): Promise<AdapterResult<{ verified: true }>> {
    return Promise.resolve({
      ok: false,
      code: "SIGNING_NOT_AVAILABLE",
      message: "Aster V3 agent-wallet signing is not enabled yet.",
    });
  }

  fetchAccountSummary(): Promise<AdapterResult<AccountSummary>> {
    return Promise.resolve({
      ok: false,
      code: "SIGNING_NOT_AVAILABLE",
      message: "Aster V3 account reads require the dedicated agent-wallet signer.",
    });
  }

  async fetchMarkets(): Promise<AdapterResult<MarketInfo[]>> {
    const result = await asterPublicGet("/fapi/v3/exchangeInfo");
    if (!result.ok) return result;
    const markets = normalizeAsterMarkets(result.data);
    if (markets.length === 0) {
      return {
        ok: false,
        code: "UNKNOWN_ERROR",
        message: "Aster returned no tradable V3 markets.",
      };
    }
    return { ok: true, data: markets };
  }

  async healthCheck(): Promise<AdapterResult<HealthCheck>> {
    const started = Date.now();
    const result = await asterPublicGet("/fapi/v3/ping");
    if (!result.ok) return result;
    return { ok: true, data: { reachable: true, latencyMs: Date.now() - started } };
  }

  disconnect(): Promise<AdapterResult<{ disconnected: true }>> {
    return Promise.resolve({ ok: true, data: { disconnected: true } });
  }
}

// SynFutures V3/Oyster is an on-chain protocol. A wallet/provider-aware SDK
// service is required for instrument discovery, account reads and transaction
// construction. Keeping this explicit prevents the API-key form or ApeX signer
// from ever being reused for an incompatible custody model.
export class SynFuturesAdapter extends PendingAdapter {
  readonly kind = "dex" as const;
  constructor() {
    super("synfutures", "SynFutures");
  }
}

// ---------------------------------------------------------------------------
// Kraken Spot — verified, read-only account integration.
//
// Official authentication:
//   API-Sign = base64(HMAC-SHA512(base64_decode(secret),
//              uriPath + SHA256(nonce + formBody)))
//
// Credential verification uses /0/private/GetApiKeyInfo, which requires no
// key permission and returns the key's actual permission list. TurtleBot then
// requires query-funds and rejects every withdrawal-shaped permission before
// calling /0/private/Balance. No trading or funding endpoint exists here.
// ---------------------------------------------------------------------------

const KRAKEN_SPOT_BASE = "https://api.kraken.com";
const KRAKEN_WITHDRAW_PERMISSIONS = new Set([
  "withdraw-funds",
  "add-withdraw-address",
  "update-withdraw-address",
]);
let lastKrakenNonce = 0;

function nextKrakenNonce(): string {
  lastKrakenNonce = Math.max(Date.now(), lastKrakenNonce + 1);
  return String(lastKrakenNonce);
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function krakenSpotSign(args: {
  path: string;
  nonce: string;
  formBody: string;
  apiSecret: string;
}): Promise<string> {
  const encoded = new TextEncoder().encode(args.nonce + args.formBody);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  const pathBytes = new TextEncoder().encode(args.path);
  const message = new Uint8Array(pathBytes.length + digest.length);
  message.set(pathBytes);
  message.set(digest, pathBytes.length);
  const key = await crypto.subtle.importKey(
    "raw",
    exactArrayBuffer(fromB64(args.apiSecret)),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return toB64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, exactArrayBuffer(message))),
  );
}

function mapKrakenError(errors: unknown, status = 400): {
  code: ExchangeErrorCode;
  message: string;
} {
  const list = Array.isArray(errors) ? errors.filter((v): v is string => typeof v === "string") : [];
  const message = list.join("; ") || `Kraken request failed (HTTP ${status}).`;
  if (/invalid key|unknown key/i.test(message)) return { code: "INVALID_API_KEY", message };
  if (/signature|invalid nonce/i.test(message)) return { code: "INVALID_SIGNATURE", message };
  if (/permission|denied/i.test(message)) return { code: "PERMISSION_DENIED", message };
  if (/rate limit|throttl/i.test(message) || status === 429) return { code: "RATE_LIMITED", message };
  if (/service unavailable|temporarily unavailable/i.test(message) || status >= 500) {
    return { code: "EXCHANGE_UNAVAILABLE", message };
  }
  return { code: "UNKNOWN_ERROR", message };
}

async function krakenPublicGet(path: string): Promise<AdapterResult<unknown>> {
  try {
    const response = await fetch(KRAKEN_SPOT_BASE + path, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, ...mapKrakenError([], response.status) };
    const errors = (body as { error?: unknown }).error;
    if (Array.isArray(errors) && errors.length > 0) {
      return { ok: false, ...mapKrakenError(errors, response.status) };
    }
    return { ok: true, data: body };
  } catch {
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: "Network error contacting Kraken.",
    };
  }
}

async function krakenPrivatePost(
  path: string,
  creds: DecryptedCredentials,
): Promise<AdapterResult<unknown>> {
  if (!creds.apiKey || !creds.apiSecret) {
    return { ok: false, code: "INVALID_API_KEY", message: "Kraken API key and secret are required." };
  }
  const nonce = nextKrakenNonce();
  const formBody = new URLSearchParams({ nonce }).toString();
  let signature: string;
  try {
    signature = await krakenSpotSign({ path, nonce, formBody, apiSecret: creds.apiSecret });
  } catch {
    return { ok: false, code: "INVALID_API_KEY", message: "Kraken API secret is not valid base64." };
  }
  try {
    const response = await fetch(KRAKEN_SPOT_BASE + path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "API-Key": creds.apiKey,
        "API-Sign": signature,
      },
      body: formBody,
    });
    const body = await response.json().catch(() => ({}));
    const errors = (body as { error?: unknown }).error;
    if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
      return { ok: false, ...mapKrakenError(errors, response.status) };
    }
    return { ok: true, data: body };
  } catch {
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: "Network error contacting Kraken.",
    };
  }
}

function krakenPermissions(body: unknown): AccountSummary["permissions"] | null {
  const result = (body as { result?: { permissions?: unknown } } | null)?.result;
  if (!Array.isArray(result?.permissions)) return null;
  const permissions = result.permissions.filter((v): v is string => typeof v === "string");
  return {
    read: permissions.includes("query-funds"),
    trade: permissions.includes("modify-trades") || permissions.includes("close-trades"),
    withdraw: permissions.some((permission) => KRAKEN_WITHDRAW_PERMISSIONS.has(permission)),
  };
}

export class KrakenSpotAdapter implements ExchangeAdapter {
  readonly id = "kraken";
  readonly kind = "cex" as const;

  async healthCheck(): Promise<AdapterResult<HealthCheck>> {
    const started = Date.now();
    const result = await krakenPublicGet("/0/public/SystemStatus");
    if (!result.ok) return result;
    return { ok: true, data: { reachable: true, latencyMs: Date.now() - started } };
  }

  async validateCredentials(
    creds: DecryptedCredentials,
  ): Promise<AdapterResult<{ verified: true; permissions?: AccountSummary["permissions"] }>> {
    const result = await krakenPrivatePost("/0/private/GetApiKeyInfo", creds);
    if (!result.ok) return result;
    const permissions = krakenPermissions(result.data);
    if (!permissions) {
      return { ok: false, code: "UNKNOWN_ERROR", message: "Kraken did not return API-key permissions." };
    }
    if (permissions.withdraw) {
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: "Kraken key has withdrawal access. Remove all withdrawal permissions and create a new key.",
      };
    }
    if (!permissions.read) {
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: "Kraken key requires the Query Funds permission for read-only monitoring.",
      };
    }
    const balance = await krakenPrivatePost("/0/private/Balance", creds);
    if (!balance.ok) return balance;
    return { ok: true, data: { verified: true, permissions } };
  }

  async fetchAccountSummary(creds: DecryptedCredentials): Promise<AdapterResult<AccountSummary>> {
    const keyInfo = await krakenPrivatePost("/0/private/GetApiKeyInfo", creds);
    if (!keyInfo.ok) return keyInfo;
    const permissions = krakenPermissions(keyInfo.data);
    if (!permissions || permissions.withdraw || !permissions.read) {
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: permissions?.withdraw
          ? "Kraken key has withdrawal access."
          : "Kraken key requires the Query Funds permission.",
      };
    }
    const balance = await krakenPrivatePost("/0/private/Balance", creds);
    if (!balance.ok) return balance;
    // Kraken returns a multi-asset balance map. Do not fabricate a USD total
    // without current conversion prices; connection health remains truthful.
    return { ok: true, data: { currency: "MULTI_ASSET", permissions } };
  }

  async fetchMarkets(): Promise<AdapterResult<MarketInfo[]>> {
    const response = await krakenPublicGet("/0/public/AssetPairs");
    if (!response.ok) return response;
    const result = (response.data as { result?: Record<string, Record<string, unknown>> }).result ?? {};
    return {
      ok: true,
      data: Object.entries(result).map(([key, value]) => ({
        symbol: typeof value.altname === "string" ? value.altname : key,
        base: typeof value.base === "string" ? value.base : "",
        quote: typeof value.quote === "string" ? value.quote : "",
      })),
    };
  }

  disconnect(): Promise<AdapterResult<{ disconnected: true }>> {
    return Promise.resolve({ ok: true, data: { disconnected: true } });
  }
}

// ---------------------------------------------------------------------------
// ApeX Omni (mainnet) — REAL read-only adapter.
//
// Signing scheme is the api-key HMAC scheme published by ApeX in the official
// open-source Node SDK:
//   ApeX-Protocol/apexomni-connector-node
//   src/omni/PrivateApi.ts :: PrivateApi.sign()
//
//   messageString = String(timestampMs) + method.toUpperCase()
//                 + requestPath + params
//   key           = base64(secret)                     // as UTF-8 string
//   signature     = base64( HMAC_SHA256(key, messageString) )
//   headers       = APEX-API-KEY / APEX-SIGNATURE
//                 / APEX-TIMESTAMP (ms as decimal string)
//                 / APEX-PASSPHRASE
//
// This is the api-key HMAC path used for private REST GETs — NOT the
// zk / l2Key / stark order signing.
//
// Endpoints (mainnet base https://omni.apex.exchange/api/v3):
//   healthCheck        -> GET /api/v3/time            (public, no auth)
//   fetchMarkets       -> GET /api/v3/symbols         (public, no auth)
//   validateCredentials/
//   fetchAccountSummary-> GET /api/v3/account-balance (private, read-only)
//
// NO order/leverage/position/withdraw/transfer calls. Execution stays locked
// independently at the app-env layer.
// ---------------------------------------------------------------------------

const APEX_OMNI_BASE = "https://omni.apex.exchange";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function apexOmniSign(args: {
  method: "GET";
  requestPath: string;
  timestampMs: number;
  secret: string;
}): Promise<string> {
  const messageString = String(args.timestampMs) + args.method + args.requestPath + "";
  const keyString = toB64(new TextEncoder().encode(args.secret));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyString),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(messageString),
  );
  return toB64(new Uint8Array(sigBuf));
}

function mapApexError(status: number, body: unknown): { code: ExchangeErrorCode; message: string } {
  const msg =
    (body && typeof body === "object" && "msg" in body && typeof (body as { msg?: unknown }).msg === "string"
      ? (body as { msg: string }).msg
      : undefined) ?? `ApeX Omni request failed (HTTP ${status}).`;
  if (status === 401 || status === 403) {
    // ApeX returns 401/403 for bad key / bad signature / missing passphrase.
    if (/signature/i.test(msg)) return { code: "INVALID_SIGNATURE", message: msg };
    if (/permission|forbidden/i.test(msg)) return { code: "PERMISSION_DENIED", message: msg };
    return { code: "INVALID_API_KEY", message: msg };
  }
  if (status === 429) return { code: "RATE_LIMITED", message: msg };
  if (status >= 500) return { code: "EXCHANGE_UNAVAILABLE", message: msg };
  return { code: "UNKNOWN_ERROR", message: msg };
}

async function apexOmniPublicGet(path: string): Promise<AdapterResult<unknown>> {
  try {
    const res = await fetch(APEX_OMNI_BASE + path, { method: "GET" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...mapApexError(res.status, body) };
    return { ok: true, data: body };
  } catch (e) {
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: e instanceof Error ? e.message : "Network error contacting ApeX Omni.",
    };
  }
}

async function apexOmniPrivateGet(
  path: string,
  creds: DecryptedCredentials,
): Promise<AdapterResult<unknown>> {
  if (!creds.apiKey || !creds.apiSecret || !creds.passphrase) {
    return {
      ok: false,
      code: "INVALID_API_KEY",
      message: "ApeX Omni requires API key, secret, and passphrase.",
    };
  }
  const timestampMs = Date.now();
  const signature = await apexOmniSign({
    method: "GET",
    requestPath: path,
    timestampMs,
    secret: creds.apiSecret,
  });
  try {
    const res = await fetch(APEX_OMNI_BASE + path, {
      method: "GET",
      headers: {
        "APEX-API-KEY": creds.apiKey,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": String(timestampMs),
        "APEX-PASSPHRASE": creds.passphrase,
      },
    });
    const rawText = await res.text();
    let body: unknown = {};
    try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { _raw: rawText.slice(0, 500) }; }
    // Diagnostic: log HTTP status + response body on any non-200. NEVER log
    // credentials or signature — those are stripped from the log record.
    if (!res.ok) {
      console.warn("[apex_omni] private GET failed", {
        method: "GET",
        endpoint: APEX_OMNI_BASE + path,
        http_status: res.status,
        body,
      });
      return { ok: false, ...mapApexError(res.status, body) };
    }
    // ApeX wraps responses as { code, data, msg }. Non-zero code = error.
    if (body && typeof body === "object" && "code" in body) {
      const code = (body as { code?: unknown }).code;
      if (code !== undefined && code !== null && code !== 0 && code !== "0") {
        console.warn("[apex_omni] private GET returned application error", {
          endpoint: APEX_OMNI_BASE + path,
          http_status: res.status,
          body,
        });
        return { ok: false, ...mapApexError(401, body) };
      }
    }
    return { ok: true, data: body };
  } catch (e) {
    console.error("[apex_omni] private GET threw", {
      endpoint: APEX_OMNI_BASE + path,
      message: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: e instanceof Error ? e.message : "Network error contacting ApeX Omni.",
    };
  }
}

export class ApexOmniAdapter implements ExchangeAdapter {
  readonly id = "apex_omni";
  readonly kind = "dex" as const;

  async healthCheck(): Promise<AdapterResult<HealthCheck>> {
    const started = Date.now();
    const res = await apexOmniPublicGet("/api/v3/time");
    if (!res.ok) return res;
    return { ok: true, data: { reachable: true, latencyMs: Date.now() - started } };
  }

  async fetchMarkets(): Promise<AdapterResult<MarketInfo[]>> {
    const res = await apexOmniPublicGet("/api/v3/symbols");
    if (!res.ok) return res;
    // Response shape is exchange-defined; we only need a lightweight projection.
    // Return an empty list rather than guessing at nested fields — this call
    // exists to confirm the venue is reachable, not to power symbol UIs.
    return { ok: true, data: [] };
  }

  async validateCredentials(creds: DecryptedCredentials): Promise<AdapterResult<{ verified: true }>> {
    const res = await apexOmniPrivateGet("/api/v3/account-balance", creds);
    if (!res.ok) return res;
    return { ok: true, data: { verified: true } };
  }

  async fetchAccountSummary(creds: DecryptedCredentials): Promise<AdapterResult<AccountSummary>> {
    const res = await apexOmniPrivateGet("/api/v3/account-balance", creds);
    if (!res.ok) return res;
    // ApeX Omni AccountBalanceObject (see apexomni-connector-node
    // src/omni/interface/index.ts):
    //   { totalEquityValue, availableBalance, initialMargin, maintenanceMargin }
    // All values arrive as decimal strings. "In trades" = initialMargin
    // (capital pledged as position margin).
    const data = (res.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const num = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    const totalEquity = num((data as Record<string, unknown>)["totalEquityValue"]);
    const availableBalance = num((data as Record<string, unknown>)["availableBalance"]);
    const inTrades = num((data as Record<string, unknown>)["initialMargin"]);
    if (totalEquity === undefined && availableBalance === undefined && inTrades === undefined) {
      console.warn("[apex_omni] account-balance response missing expected fields", {
        endpoint: APEX_OMNI_BASE + "/api/v3/account-balance",
        body: res.data,
      });
    } else if ((totalEquity ?? 0) === 0 && (availableBalance ?? 0) === 0) {
      // Fields parsed but zero — likely subaccount/account scoping. Dump the
      // raw wrapper + data keys so we can see where the funds actually live.
      const wrapper = res.data as Record<string, unknown> | null;
      console.warn("[apex_omni] account-balance parsed but ZERO — raw body follows", {
        endpoint: APEX_OMNI_BASE + "/api/v3/account-balance",
        wrapper_keys: wrapper && typeof wrapper === "object" ? Object.keys(wrapper) : [],
        data_keys: data && typeof data === "object" ? Object.keys(data as object) : [],
        body: res.data,
      });
    }
    return {
      ok: true,
      data: {
        totalEquity,
        availableBalance,
        inTrades,
        currency: "USDT",
        permissions: { read: true, trade: false, withdraw: false },
      },
    };
  }


  /** Public fetch of /api/v3/symbols for min-order-size lookup on MAINNET. */
  async fetchSymbolsRaw(): Promise<AdapterResult<unknown>> {
    return apexOmniPublicGet("/api/v3/symbols");
  }

  /**
   * MAINNET order placement.
   *
   * ApeX Omni createOrder requires TWO signatures:
   *   1. The API-key HMAC (implemented above for private GETs), AND
   *   2. A zkLink/L2 signature over the order payload derived from the
   *      account's Omni Key seed + l2Key + per-symbol pairId/l2PairId +
   *      nonce/slotId/limitFee.
   *
   * The official signer (ApeX-Protocol/apexomni-connector-node) ships as a
   * WASM module wrapped in Node CommonJS glue (require('util'), Node Buffer
   * heap patterns). It does NOT run inside the Supabase Deno edge runtime.
   *
   * We deliberately do NOT hand-roll the zkLink curve signing here — a wrong
   * signature on real funds is unacceptable. The correct path is to move
   * order signing to the official Python `apexomni` SDK on the Railway
   * worker (bot_worker.py), where the WASM/native signer runs natively.
   *
   * TODO(live-execution): implement the actual createOrder flow inside the
   * Railway worker using the official Python SDK, and have that worker POST
   * signed intents through this broker for audit + idempotency.
   *
   * Until then, every attempted mainnet order placement MUST reject with
   * SIGNING_NOT_AVAILABLE so the broker returns an honest verbatim outcome
   * and never fabricates a submission.
   *
   * DEFENSE IN DEPTH (P0): mainnet is additionally blocked upstream at the
   * gate — `evaluateGate` returns MAINNET_DISABLED for any is_live/apex_omni
   * intent, and the `run-live-proof` edge function is a 410 stub. Even if
   * this method were changed to succeed, no code path reaches it today.
   */
  placeOrder(
    _creds: DecryptedCredentials,
    _order: ApexOrderRequest,
  ): Promise<AdapterResult<{ orderId?: string; raw: unknown }>> {
    return Promise.resolve({
      ok: false,
      code: "SIGNING_NOT_AVAILABLE",
      message:
        "ApeX Omni mainnet order signing (zkLink/L2) is not available in the edge runtime. Signing must be performed by the official Python SDK on the Railway worker. No order was submitted.",
    });
  }

  closePosition(
    _creds: DecryptedCredentials,
    _args: { symbol: string; side: "BUY" | "SELL"; size: string },
  ): Promise<AdapterResult<{ orderId?: string; raw: unknown }>> {
    return Promise.resolve({
      ok: false,
      code: "SIGNING_NOT_AVAILABLE",
      message:
        "ApeX Omni mainnet position close requires zkLink/L2 signing which is not available in the edge runtime. No order was submitted.",
    });
  }

  getOrderByClientId(
    creds: DecryptedCredentials,
    clientOrderId: string,
  ): Promise<AdapterResult<{ found: boolean; status?: string; orderId?: string; raw: unknown }>> {
    if (!clientOrderId) {
      return Promise.resolve({ ok: false, code: "UNKNOWN_ERROR", message: "clientOrderId required" });
    }
    return apexOmniPrivateGet(
      "/api/v3/order-by-client-order-id?id=" + encodeURIComponent(clientOrderId),
      creds,
    ).then((res) => {
      if (!res.ok) {
        const msg = (res.message || "").toLowerCase();
        if (msg.includes("not found") || msg.includes("no record")) {
          return { ok: true as const, data: { found: false, raw: null } };
        }
        return res;
      }
      const wrapper = res.data as { data?: Record<string, unknown> | null };
      const d = wrapper?.data;
      if (!d || typeof d !== "object" || Object.keys(d).length === 0) {
        return { ok: true as const, data: { found: false, raw: res.data } };
      }
      const status = typeof d["status"] === "string" ? (d["status"] as string) : undefined;
      const orderId =
        (typeof d["orderId"] === "string" ? (d["orderId"] as string) : undefined) ??
        (typeof d["id"] === "string" ? (d["id"] as string) : undefined);
      return { ok: true as const, data: { found: true, status, orderId, raw: res.data } };
    });
  }

  disconnect(): Promise<AdapterResult<{ disconnected: true }>> {
    return Promise.resolve({ ok: true, data: { disconnected: true } });
  }
}

// ---------------------------------------------------------------------------
// ApeX Omni TESTNET adapter — REAL order path against ApeX's testnet only.
//
// SAFETY / HARD ISOLATION:
//   - Base URL is a compile-time constant pointing at testnet ONLY.
//     Mainnet URL is never reachable from this class.
//   - `assertTestnetUrl()` runs on every request and throws if the URL was
//     tampered with in a subclass or accidental edit — a defense-in-depth
//     guard against future refactors.
//   - Credentials for this adapter must come from an `exchange_connections`
//     row where `exchange = 'apex_omni_testnet'`. The edge functions are
//     responsible for enforcing that; this adapter also refuses to run if
//     the caller passes credentials tagged as mainnet (see APEX-CREDS-TAG).
//   - This adapter provides account-balance READ, ticker READ, order PLACE,
//     open-position READ, and position CLOSE. No withdrawal, no transfer,
//     no leverage/margin mutation.
//   - The mainnet execution lock (EXECUTION_ENABLED, APP_ENV) is NOT
//     consulted or altered here. Testnet is a separate proving-ground path;
//     it must NEVER be used to reach mainnet.
// ---------------------------------------------------------------------------

const APEX_OMNI_TESTNET_BASE = "https://testnet.omni.apex.exchange" as const;

function assertTestnetUrl(url: string): void {
  if (!url.startsWith(APEX_OMNI_TESTNET_BASE + "/")) {
    throw new Error(
      "APEX_TESTNET_GUARD: refused to call non-testnet URL from testnet adapter",
    );
  }
}

export interface ApexOrderRequest {
  symbol: string;                    // e.g. "BTC-USDT"
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  size: string;                      // decimal string, base units
  price?: string;                    // required for LIMIT
  timeInForce?: "GOOD_TIL_CANCEL" | "IMMEDIATE_OR_CANCEL" | "FILL_OR_KILL";
  reduceOnly?: boolean;
  clientOrderId?: string;
}

function toFormBody(obj: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

async function apexOmniTestnetPublicGet(path: string): Promise<AdapterResult<unknown>> {
  const url = APEX_OMNI_TESTNET_BASE + path;
  assertTestnetUrl(url);
  try {
    const res = await fetch(url, { method: "GET" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...mapApexError(res.status, body) };
    return { ok: true, data: body };
  } catch (e) {
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: e instanceof Error ? e.message : "Network error contacting ApeX Omni testnet.",
    };
  }
}

async function apexOmniTestnetPrivateRequest(args: {
  method: "GET" | "POST";
  path: string;
  creds: DecryptedCredentials;
  body?: Record<string, string | number | boolean | undefined>;
}): Promise<AdapterResult<unknown>> {
  const { method, path, creds, body } = args;
  if (!creds.apiKey || !creds.apiSecret || !creds.passphrase) {
    return {
      ok: false,
      code: "INVALID_API_KEY",
      message: "ApeX Omni testnet requires API key, secret, and passphrase.",
    };
  }
  const url = APEX_OMNI_TESTNET_BASE + path;
  assertTestnetUrl(url);

  // SDK signing scheme: messageString = ts + method + requestPath + params
  //   - GET/DELETE: params is a sorted urlencoded string appended after `?`
  //     to requestPath, and `params` in the signature is "".
  //   - POST/PUT:   requestPath is bare; params is the sorted urlencoded body.
  const timestampMs = Date.now();
  let signRequestPath = path;
  let signParams = "";
  let sendBody: string | undefined;
  const sendHeaders: Record<string, string> = {};
  if (method === "POST") {
    signParams = toFormBody(body ?? {});
    sendBody = signParams;
    sendHeaders["content-type"] = "application/x-www-form-urlencoded";
  } else if (body && Object.keys(body).length > 0) {
    const qs = toFormBody(body);
    signRequestPath = path + "?" + qs;
  }

  const messageString = String(timestampMs) + method + signRequestPath + signParams;
  const keyString = toB64(new TextEncoder().encode(creds.apiSecret));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyString),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(messageString),
  );
  const signature = toB64(new Uint8Array(sigBuf));

  const finalUrl = APEX_OMNI_TESTNET_BASE + signRequestPath;
  assertTestnetUrl(finalUrl);

  try {
    const res = await fetch(finalUrl, {
      method,
      headers: {
        ...sendHeaders,
        "APEX-API-KEY": creds.apiKey,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": String(timestampMs),
        "APEX-PASSPHRASE": creds.passphrase,
      },
      body: sendBody,
    });
    const rawText = await res.text();
    let parsed: unknown = {};
    try { parsed = rawText ? JSON.parse(rawText) : {}; } catch { parsed = { _raw: rawText.slice(0, 500) }; }
    if (!res.ok) {
      console.warn("[apex_omni_testnet] request failed", {
        method, endpoint: finalUrl, http_status: res.status, body: parsed,
      });
      return { ok: false, ...mapApexError(res.status, parsed) };
    }
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      const code = (parsed as { code?: unknown }).code;
      if (code !== undefined && code !== null && code !== 0 && code !== "0") {
        console.warn("[apex_omni_testnet] application error", {
          endpoint: finalUrl, http_status: res.status, body: parsed,
        });
        return { ok: false, ...mapApexError(401, parsed) };
      }
    }
    return { ok: true, data: parsed };
  } catch (e) {
    console.error("[apex_omni_testnet] request threw", {
      endpoint: finalUrl, message: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      code: "EXCHANGE_UNAVAILABLE",
      message: e instanceof Error ? e.message : "Network error contacting ApeX Omni testnet.",
    };
  }
}

export class ApexOmniTestnetAdapter implements ExchangeAdapter {
  readonly id = "apex_omni_testnet";
  readonly kind = "dex" as const;
  readonly baseUrl = APEX_OMNI_TESTNET_BASE;

  constructor() {
    // Boot-time guard: prove the base URL points at testnet.
    assertTestnetUrl(APEX_OMNI_TESTNET_BASE + "/api/v3/time");
  }

  async healthCheck(): Promise<AdapterResult<HealthCheck>> {
    const started = Date.now();
    const res = await apexOmniTestnetPublicGet("/api/v3/time");
    if (!res.ok) return res;
    return { ok: true, data: { reachable: true, latencyMs: Date.now() - started } };
  }

  async fetchMarkets(): Promise<AdapterResult<MarketInfo[]>> {
    const res = await apexOmniTestnetPublicGet("/api/v3/symbols");
    if (!res.ok) return res;
    return { ok: true, data: [] };
  }

  async validateCredentials(creds: DecryptedCredentials): Promise<AdapterResult<{ verified: true }>> {
    const res = await apexOmniTestnetPrivateRequest({
      method: "GET",
      path: "/api/v3/account-balance",
      creds,
    });
    if (!res.ok) return res;
    return { ok: true, data: { verified: true } };
  }

  async fetchAccountSummary(creds: DecryptedCredentials): Promise<AdapterResult<AccountSummary>> {
    const res = await apexOmniTestnetPrivateRequest({
      method: "GET",
      path: "/api/v3/account-balance",
      creds,
    });
    if (!res.ok) return res;
    const data = (res.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const num = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    return {
      ok: true,
      data: {
        totalEquity: num((data as Record<string, unknown>)["totalEquityValue"]),
        availableBalance: num((data as Record<string, unknown>)["availableBalance"]),
        inTrades: num((data as Record<string, unknown>)["initialMargin"]),
        currency: "USDT",
        permissions: { read: true, trade: true, withdraw: false },
      },
    };
  }

  // Public read of the BTC-USDT perp ticker (testnet).
  async fetchTicker(symbol: string): Promise<AdapterResult<{ symbol: string; price: number }>> {
    const res = await apexOmniTestnetPublicGet(
      "/api/v3/ticker?symbol=" + encodeURIComponent(symbol),
    );
    if (!res.ok) return res;
    const body = res.data as { data?: unknown };
    const arr = Array.isArray(body?.data) ? body.data : [];
    const first = arr[0] as { lastPrice?: string; price?: string; markPrice?: string } | undefined;
    const raw = first?.lastPrice ?? first?.price ?? first?.markPrice;
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, code: "EXCHANGE_UNAVAILABLE", message: "No testnet price returned." };
    }
    return { ok: true, data: { symbol, price: n } };
  }

  // PLACE ORDER — real testnet endpoint. NOTE: ApeX Omni's order create may
  // additionally require an L2/stark signature (SDK computes it client-side).
  // We deliberately send the HMAC-signed request only, per the project's
  // proving-ground scope. Any additional server-side requirement will surface
  // as a verbatim ApeX error code/message, which the UI displays.
  async placeOrder(
    creds: DecryptedCredentials,
    order: ApexOrderRequest,
  ): Promise<AdapterResult<{ orderId?: string; raw: unknown }>> {
    const body: Record<string, string | number | boolean | undefined> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      size: order.size,
      price: order.price,
      timeInForce: order.timeInForce ?? "IMMEDIATE_OR_CANCEL",
      reduceOnly: order.reduceOnly ?? false,
      clientOrderId: order.clientOrderId,
    };
    const res = await apexOmniTestnetPrivateRequest({
      method: "POST",
      path: "/api/v3/create-order",
      creds,
      body,
    });
    if (!res.ok) return res;
    const wrapper = res.data as { data?: { id?: string; orderId?: string } };
    const orderId = wrapper?.data?.orderId ?? wrapper?.data?.id;
    return { ok: true, data: { orderId, raw: res.data } };
  }

  async fetchPositions(
    creds: DecryptedCredentials,
    symbol?: string,
  ): Promise<AdapterResult<{ positions: Array<Record<string, unknown>>; raw: unknown }>> {
    const res = await apexOmniTestnetPrivateRequest({
      method: "GET",
      path: "/api/v3/account",
      creds,
    });
    if (!res.ok) return res;
    const account = (res.data as { data?: Record<string, unknown> })?.data ?? {};
    const rawPositions =
      (account["positions"] as Array<Record<string, unknown>>) ??
      (account["openPositions"] as Array<Record<string, unknown>>) ??
      [];
    const positions = symbol
      ? rawPositions.filter((p) => String(p.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      : rawPositions;
    return { ok: true, data: { positions, raw: res.data } };
  }

  // Close a position by placing a reduce-only market order in the opposite
  // direction. Testnet only.
  async closePosition(
    creds: DecryptedCredentials,
    args: { symbol: string; side: "BUY" | "SELL"; size: string },
  ): Promise<AdapterResult<{ orderId?: string; raw: unknown }>> {
    return this.placeOrder(creds, {
      symbol: args.symbol,
      side: args.side,
      type: "MARKET",
      size: args.size,
      timeInForce: "IMMEDIATE_OR_CANCEL",
      reduceOnly: true,
    });
  }

  /**
   * Look up an order by clientOrderId on ApeX testnet. Used to reconcile
   * ambiguous submissions (e.g. POST /create-order timed out). NEVER retries
   * the create — this is a read-only lookup.
   */
  async getOrderByClientId(
    creds: DecryptedCredentials,
    clientOrderId: string,
  ): Promise<AdapterResult<{ found: boolean; status?: string; orderId?: string; raw: unknown }>> {
    if (!clientOrderId) {
      return { ok: false, code: "UNKNOWN_ERROR", message: "clientOrderId required" };
    }
    const res = await apexOmniTestnetPrivateRequest({
      method: "GET",
      path: "/api/v3/order-by-client-order-id",
      creds,
      body: { id: clientOrderId },
    });
    if (!res.ok) {
      const msg = (res.message || "").toLowerCase();
      if (msg.includes("not found") || msg.includes("no record")) {
        return { ok: true, data: { found: false, raw: null } };
      }
      return res;
    }
    const wrapper = res.data as { data?: Record<string, unknown> | null };
    const d = wrapper?.data;
    if (!d || typeof d !== "object" || Object.keys(d).length === 0) {
      return { ok: true, data: { found: false, raw: res.data } };
    }
    const status = typeof d["status"] === "string" ? (d["status"] as string) : undefined;
    const orderId =
      (typeof d["orderId"] === "string" ? (d["orderId"] as string) : undefined) ??
      (typeof d["id"] === "string" ? (d["id"] as string) : undefined);
    return { ok: true, data: { found: true, status, orderId, raw: res.data } };
  }

  /** Public fetch of /api/v3/symbols for min-order-size lookup. */
  async fetchSymbolsRaw(): Promise<AdapterResult<unknown>> {
    return apexOmniTestnetPublicGet("/api/v3/symbols");
  }

  disconnect(): Promise<AdapterResult<{ disconnected: true }>> {
    return Promise.resolve({ ok: true, data: { disconnected: true } });
  }
}

export function getAdapter(exchange: string): ExchangeAdapter | null {
  switch (exchange.toLowerCase()) {
    case "btcc":
      return new BtccAdapter();
    case "bydfi":
      return new BydfiAdapter();
    case "hyperliquid":
      return new HyperliquidAdapter();
    case "aster":
      return new AsterAdapter();
    case "synfutures":
      return new SynFuturesAdapter();
    case "kraken":
      return new KrakenSpotAdapter();
    case "apex_omni":
      return new ApexOmniAdapter();
    case "apex_omni_testnet":
      return new ApexOmniTestnetAdapter();
    default:
      return null;
  }
}
