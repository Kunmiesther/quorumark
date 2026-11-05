// apex-omni-read — in-process, READ-ONLY ApeX Omni REST client for Deno.
//
// Owner ruling #12: position/fills/open-order/balance reads MUST NOT be
// routed through the Railway signer container. This module lets edge
// functions decrypt the ApeX credentials stored in `exchange_credentials`
// and issue authenticated GETs directly against ApeX Omni. The signer
// stays exclusively for order placement / modification / cancellation.
//
// Signing scheme is the canonical ApeX Omni SDK form (matches
// `signer/app/orders_v3.py :: sign_canonical` and
// `src/lib/exchanges/apex-omni-sign.ts`):
//
//   dataString    = "&".join(f"{k}={v}" for k,v in sorted(data.items()) if v is not None)
//   sign_path     = path            + "?" + dataString   (GET/DELETE, dataString non-empty)
//   sign_path     = path                                 (GET/DELETE with no params, or POST/PUT)
//   messageString = str(ts_ms) + METHOD + sign_path + body
//   keyString     = base64(secret_utf8)
//   signature     = base64( HMAC_SHA256(keyString, messageString) )
//
// Credential envelope matches supabase/functions/exchange-credentials
// (AES-256-GCM, key = SHA-256(TURTLE_CREDENTIAL_ENCRYPTION_KEY_utf8)).
//
// NEVER logs secrets, ciphertext, or full venue payloads.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { readApexPages } from "./apex-history-pages.ts";
import { apexOrderEvidence, findExactApexOrder } from "./apex-order-recovery.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SB = SupabaseClient;

const HOST_MAINNET = "https://omni.apex.exchange";
const HOST_TESTNET = "https://qa.omni.apex.exchange";

export function apexHost(environment: string | null | undefined): string {
  const e = String(environment || "").trim().toLowerCase();
  if (e === "testnet" || e === "sandbox" || e === "qa" || e === "dev" || e === "development") {
    return HOST_TESTNET;
  }
  return HOST_MAINNET;
}

// ---- credential decryption (matches exchange-credentials / execution-broker) ----
async function deriveAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("TURTLE_CREDENTIAL_ENCRYPTION_KEY");
  if (!secret) throw new Error("MISSING_ENCRYPTION_KEY");
  const raw = new TextEncoder().encode(secret);
  if (raw.byteLength < 32) throw new Error("SHORT_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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

export interface ApexReadCreds {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  environment: string;
}

/** Decrypt REST credentials for a given exchange_connections.id. */
export async function loadApexReadCreds(
  supabase: SB,
  connectionId: string,
  environmentFallback: string,
): Promise<{ ok: true; creds: ApexReadCreds } | { ok: false; reason: string }> {
  const { data: credRow, error } = await supabase
    .from("exchange_credentials")
    .select("encrypted_api_key, encrypted_api_secret, encrypted_passphrase")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) return { ok: false, reason: `CRED_QUERY:${error.code}` };
  if (!credRow) return { ok: false, reason: "MISSING_CREDENTIALS" };
  let aesKey: CryptoKey;
  try {
    aesKey = await deriveAesKey();
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "KEY_ERROR" };
  }
  try {
    const apiKey = await decryptField(aesKey, credRow.encrypted_api_key as string);
    const apiSecret = await decryptField(aesKey, credRow.encrypted_api_secret as string);
    const passphrase = credRow.encrypted_passphrase
      ? await decryptField(aesKey, credRow.encrypted_passphrase as string)
      : "";
    return {
      ok: true,
      creds: {
        apiKey,
        apiSecret,
        passphrase,
        environment: environmentFallback,
      },
    };
  } catch {
    return { ok: false, reason: "DECRYPT_FAILED" };
  }
}

// ---- signing --------------------------------------------------------------
function sortedQuery(data: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== "");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function signCanonical(
  method: string,
  signPath: string,
  tsMs: number,
  body: string,
  apiSecret: string,
): Promise<string> {
  const message = `${tsMs}${method.toUpperCase()}${signPath}${body}`;
  const keyString = btoa(apiSecret); // base64 of UTF-8 secret bytes (ApeX SDK convention)
  const keyBytes = new TextEncoder().encode(keyString);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
  return b64(sig);
}

// ---- transport ------------------------------------------------------------
export interface ApexGetResult {
  ok: boolean;
  status: number;
  reason?: string;
  data?: unknown;
}

async function apexGet(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
  creds: ApexReadCreds,
  timeoutMs = 15000,
): Promise<ApexGetResult> {
  const query = sortedQuery(params);
  const signPath = query ? `${path}?${query}` : path;
  const url = apexHost(creds.environment) + signPath;
  const tsMs = Date.now();
  const signature = await signCanonical("GET", signPath, tsMs, "", creds.apiSecret);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "APEX-API-KEY": creds.apiKey,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": String(tsMs),
        "APEX-PASSPHRASE": creds.passphrase || "",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `APEX_HTTP_${res.status}` };
    }
    const json = (await res.json().catch(() => null)) as { code?: unknown; data?: unknown } | null;
    if (!json || typeof json !== "object") return { ok: false, status: res.status, reason: "APEX_BAD_JSON" };
    const code = (json as { code?: unknown }).code;
    if (code !== undefined && code !== null && code !== 0 && code !== "0") {
      const safe = String(code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "UNKNOWN";
      const msgRaw = (json as { msg?: unknown }).msg;
      const msg = typeof msgRaw === "string" ? msgRaw.replace(/[^A-Za-z0-9 _.:/-]/g, "").slice(0, 120) : "";
      return { ok: false, status: res.status, reason: msg ? `APEX_REJECT_${safe}:${msg}` : `APEX_REJECT_${safe}` };
    }
    return { ok: true, status: res.status, data: (json as { data?: unknown }).data ?? json };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? "APEX_TIMEOUT" : "APEX_NETWORK_ERROR" };
  } finally {
    clearTimeout(t);
  }
}

// ---- narrow write: CANCEL ONLY ---------------------------------------------
// This module is otherwise read-only, and stays that way. Cancellation is the
// single exception, added deliberately: the signer's /v1/cancel-order path
// fails on ApeX's current reply shape (BAD_RESPONSE_JSON), and a stale resting
// order blocks every new entry on its symbol. Cancel is the least-privileged
// write there is — it can only remove an order, never create, size, or close
// anything — so recovering from an orphan must not depend on a signer deploy.
export async function apexCancelOrder(
  creds: ApexReadCreds,
  opts: { orderId?: string | null; clientOrderId?: string | null },
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; reason?: string; data?: unknown }> {
  const path = opts.orderId ? "/api/v3/delete-order" : "/api/v3/delete-client-order-id";
  const params: Record<string, string> = opts.orderId
    ? { id: String(opts.orderId) }
    : { id: String(opts.clientOrderId ?? "") };
  if (!params["id"]) return { ok: false, status: 0, reason: "MISSING_ORDER_ID" };

  const body = sortedQuery(params);
  const tsMs = Date.now();
  const signature = await signCanonical("POST", path, tsMs, body, creds.apiSecret);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(apexHost(creds.environment) + path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "APEX-API-KEY": creds.apiKey,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": String(tsMs),
        "APEX-PASSPHRASE": creds.passphrase || "",
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: res.status, reason: `APEX_HTTP_${res.status}` };
    // ApeX answers a cancel with either an envelope or a bare id string —
    // both are success. Only an explicit non-zero `code` is a rejection.
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (parsed && typeof parsed === "object") {
      const code = (parsed as { code?: unknown }).code;
      if (code !== undefined && code !== null && code !== 0 && code !== "0") {
        const safe = String(code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "UNKNOWN";
        return { ok: false, status: res.status, reason: `APEX_REJECT_${safe}`, data: parsed };
      }
    }
    return { ok: true, status: res.status, data: parsed ?? text.slice(0, 200) };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    // Ambiguous by nature: never auto-retry, reconcile instead.
    return { ok: false, status: 0, reason: aborted ? "APEX_TIMEOUT" : "APEX_NETWORK_ERROR" };
  } finally {
    clearTimeout(t);
  }
}



// ---- typed readers --------------------------------------------------------
// Field names on ApeX Omni v3 position rows (contractAccount.openPositions):
//   symbol, side, size (or openSize), entryPrice/avgEntryPrice,
//   liquidatePrice, customInitialMarginRate, unrealizePnl (NOTE: no 'd'),
//   fee, funding. Mark price is NOT on the position — it must be pulled
//   from /api/v3/ticker. Leverage on cross-margin accounts is not per-position;
//   it derives from customInitialMarginRate (1 / rate).
export interface RawPosition {
  symbol?: string;
  side?: string;
  size?: string | number;
  openSize?: string | number;
  entryPrice?: string | number;
  avgEntryPrice?: string | number;
  markPrice?: string | number;
  liquidatePrice?: string | number;
  liquidationPrice?: string | number;
  leverage?: string | number;
  effectiveLeverage?: string | number;
  customInitialMarginRate?: string | number;
  initialMarginRate?: string | number;
  unrealizePnl?: string | number;   // ApeX spelling (no 'd')
  unrealizedPnl?: string | number;
  unrealisedPnl?: string | number;
  status?: string;
}

export interface NormalizedPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  leverage: number | null;
  unrealizedPnl: number | null;
}

function num(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickPositions(payload: unknown): RawPosition[] {
  if (!payload || typeof payload !== "object") return [];
  const d = payload as Record<string, unknown>;
  for (const k of ["openPositions", "positions", "accountPositions"]) {
    const v = d[k];
    if (Array.isArray(v)) return v as RawPosition[];
  }
  const ca = d["contractAccount"];
  if (ca && typeof ca === "object") {
    const inner = (ca as Record<string, unknown>)["openPositions"];
    if (Array.isArray(inner)) return inner as RawPosition[];
  }
  return [];
}

// One-time diagnostic: log KEY NAMES ONLY (never values) so owner ruling #15
// can confirm the actual field names ApeX Omni returns. Self-disables after
// first emission per process.
let _keysLoggedOnce = false;
function logPositionKeysOnce(rows: RawPosition[], envelope: unknown): void {
  if (_keysLoggedOnce) return;
  if (Deno.env.get("APEX_READ_DEBUG_KEYS") === "0") return;
  const first = rows.find((r) => r && typeof r === "object");
  if (!first) return;
  _keysLoggedOnce = true;
  try {
    const posKeys = Object.keys(first as Record<string, unknown>).sort();
    let envKeys: string[] = [];
    let contractKeys: string[] = [];
    if (envelope && typeof envelope === "object") {
      envKeys = Object.keys(envelope as Record<string, unknown>).sort();
      const ca = (envelope as Record<string, unknown>).contractAccount;
      if (ca && typeof ca === "object") {
        contractKeys = Object.keys(ca as Record<string, unknown>).sort();
      }
    }
    console.log(
      "APEX_POSITION_KEYS",
      JSON.stringify({ position: posKeys, envelope: envKeys, contractAccount: contractKeys }),
    );
  } catch { /* swallow */ }
}

/** Public ticker mark price. No auth; used when the position row lacks mark. */
async function fetchMarkPriceFor(
  environment: string,
  symbol: string,
  timeoutMs: number,
): Promise<number | null> {
  const raw = symbol.replace(/-/g, "");
  const url = `${apexHost(environment)}/api/v3/ticker?symbol=${encodeURIComponent(raw)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const rows = (json?.data ?? null) as unknown;
    const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
    const want = raw.toUpperCase();
    const row = (list.find(
      (r) => r && typeof r === "object" &&
        String((r as Record<string, unknown>).symbol ?? "").toUpperCase() === want,
    ) ?? (list.length === 1 ? list[0] : null)) as Record<string, unknown> | null;
    if (!row) return null;
    for (const k of ["markPrice", "oraclePrice", "indexPrice", "lastPrice"]) {
      const v = num(row[k]);
      if (v && v > 0) return v;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function leverageFrom(r: RawPosition): number | null {
  const direct = num(r.leverage) ?? num(r.effectiveLeverage);
  if (direct && direct > 0) return direct;
  // ApeX cross-margin: leverage = 1 / initialMarginRate.
  const rate = num(r.customInitialMarginRate) ?? num(r.initialMarginRate);
  if (rate && rate > 0) return 1 / rate;
  return null;
}

export async function fetchOpenPositions(
  creds: ApexReadCreds,
  timeoutMs = 15000,
): Promise<{ ok: true; positions: NormalizedPosition[] } | { ok: false; reason: string }> {
  const res = await apexGet("/api/v3/account", {}, creds, timeoutMs);
  if (!res.ok) return { ok: false, reason: res.reason || "APEX_ERROR" };
  const raw = pickPositions(res.data);
  logPositionKeysOnce(raw, res.data);
  const out: NormalizedPosition[] = [];
  for (const r of raw) {
    const sizeAbs = Math.abs(num(r.size) ?? num(r.openSize) ?? 0);
    if (sizeAbs <= 0) continue;
    const status = String(r.status || "").toUpperCase();
    if (status === "CLOSED" || status === "CLOSE") continue;
    const sideRaw = String(r.side || ((num(r.size) ?? 0) >= 0 ? "LONG" : "SHORT")).toUpperCase();
    const side: "LONG" | "SHORT" =
      sideRaw === "LONG" || sideRaw === "BUY" ? "LONG" : "SHORT";
    const symbol = String(r.symbol || "").toUpperCase();
    const entry = num(r.entryPrice) ?? num(r.avgEntryPrice);
    // ApeX Omni does NOT ship mark on the position row. Pull from ticker.
    let mark = num(r.markPrice);
    if (mark === null && symbol) {
      mark = await fetchMarkPriceFor(creds.environment, symbol, timeoutMs);
    }
    let uPnl = num(r.unrealizePnl) ?? num(r.unrealizedPnl) ?? num(r.unrealisedPnl);
    if (uPnl === null && entry !== null && mark !== null && sizeAbs > 0) {
      const dir = side === "LONG" ? 1 : -1;
      uPnl = (mark - entry) * sizeAbs * dir;
    }
    out.push({
      symbol,
      side,
      size: sizeAbs,
      entryPrice: entry,
      markPrice: mark,
      liquidationPrice: num(r.liquidatePrice) ?? num(r.liquidationPrice),
      leverage: leverageFrom(r),
      unrealizedPnl: uPnl,
    });
  }
  return { ok: true, positions: out };
}

export interface RawOpenOrder {
  id?: string;
  orderId?: string;
  clientOrderId?: string;
  clientId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  price?: string | number;
  triggerPrice?: string | number;
  size?: string | number;
  reduceOnly?: boolean;
  status?: string;
  state?: string;
}

const OPEN_STATES = new Set([
  "PENDING", "NEW", "OPEN", "UNTRIGGERED",
  "PARTIALLY_FILLED", "PARTIAL_FILLED", "ACCEPTED", "WORKING",
]);

function pickOpenOrders(payload: unknown): RawOpenOrder[] {
  if (Array.isArray(payload)) return payload as RawOpenOrder[];
  if (!payload || typeof payload !== "object") return [];
  const d = payload as Record<string, unknown>;
  for (const k of ["orders", "openOrders", "list"]) {
    const v = d[k];
    if (Array.isArray(v)) return v as RawOpenOrder[];
  }
  return [];
}

export async function fetchOpenOrders(
  creds: ApexReadCreds,
  timeoutMs = 15000,
): Promise<{ ok: true; orders: RawOpenOrder[] } | { ok: false; reason: string }> {
  const res = await apexGet("/api/v3/open-orders", {}, creds, timeoutMs);
  if (!res.ok) return { ok: false, reason: res.reason || "APEX_ERROR" };
  const rows = pickOpenOrders(res.data).filter((r) => {
    const s = String(r.status || r.state || "").toUpperCase();
    if (!s) return true;
    return OPEN_STATES.has(s);
  });
  return { ok: true, orders: rows };
}

export interface NormalizedFill {
  venue_fill_id: string;
  venue_order_id: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  fee: string;
  fee_currency: string | null;
  liquidity: string | null;
  fill_ts_ms: number;
}

interface RawFill {
  id?: string;
  matchId?: string;
  fillId?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  price?: string | number;
  size?: string | number;
  fee?: string | number;
  feeAsset?: string;
  feeCurrency?: string;
  liquidity?: string;
  liquidityType?: string;
  createdAt?: string | number;
  createdTime?: string | number;
  matchFillTime?: string | number;
  timestamp?: string | number;
}

function tsMs(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

export async function fetchFills(
  creds: ApexReadCreds,
  sinceMs: number | null,
  limit = 100,
  timeoutMs = 15000,
): Promise<{ ok: true; fills: NormalizedFill[] } | { ok: false; reason: string }> {
  const params: Record<string, string | number> = {
    // ApeX Omni /api/v3/fills caps page size at 100.
    limit: Math.max(1, Math.min(limit, 100)),
    // Freeze the upper bound so new fills cannot shift page offsets.
    endTimeExclusive: Date.now(),
  };
  if (sinceMs && sinceMs > 0) params.beginTimeInclusive = sinceMs;
  const deadline = Date.now() + timeoutMs;
  const res = await readApexPages<RawFill>({
    keys: ["fills", "orders", "list", "trades"], pageSize: Number(params.limit),
    read: page => Date.now() >= deadline
      ? Promise.resolve({ ok: false, reason: "APEX_HISTORY_TIMEOUT" })
      : apexGet("/api/v3/fills", { ...params, page }, creds, deadline - Date.now()),
  });
  if (!res.ok) return { ok: false, reason: res.reason || "APEX_ERROR" };
  const rows = res.rows;
  const out: NormalizedFill[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const vid = String(r.id || r.matchId || r.fillId || "");
    if (!vid || seen.has(vid)) return { ok: false, reason: "APEX_FILL_ID_INVALID" };
    seen.add(vid);
    const sideRaw = String(r.side || "").toUpperCase();
    if (!["SELL", "SHORT", "BUY", "LONG"].includes(sideRaw)) return { ok: false, reason: "APEX_FILL_SIDE_INVALID" };
    const side: "BUY" | "SELL" = sideRaw === "SELL" || sideRaw === "SHORT" ? "SELL" : "BUY";
    const ts = tsMs(r.createdAt ?? r.createdTime ?? r.matchFillTime ?? r.timestamp);
    if (!ts || ts >= Number(params.endTimeExclusive) || (sinceMs && ts < sinceMs) ||
      !(Number(r.price) > 0) || !(Number(r.size) > 0) ||
      !Number.isFinite(Number(r.price)) || !Number.isFinite(Number(r.size)) ||
      r.fee === undefined || r.fee === null || r.fee === "" || !Number.isFinite(Number(r.fee)) || !r.symbol) {
      return { ok: false, reason: "APEX_FILL_EVIDENCE_INVALID" };
    }
    out.push({
      venue_fill_id: vid,
      venue_order_id: r.orderId ? String(r.orderId) : null,
      symbol: String(r.symbol || "").toUpperCase(),
      side,
      price: String(r.price ?? "0"),
      size: String(r.size ?? "0"),
      fee: String(r.fee ?? "0"),
      fee_currency: (r.feeAsset ?? r.feeCurrency ?? null) as string | null,
      liquidity: (r.liquidity ?? r.liquidityType ?? null) as string | null,
      fill_ts_ms: ts,
    });
  }
  return { ok: true, fills: out };
}

/** Positive order evidence only. A not-found response is NOT a cancellation. */
export async function fetchApexOrder(creds: ApexReadCreds, clientOrderId: string, timeoutMs = 15000,
  context?: {symbol:string;createdAt:string}) {
  const deadline=Date.now()+timeoutMs;
  const exact=await apexGet("/api/v3/order-by-client-order-id", { id: clientOrderId }, creds, Math.max(1,Math.floor(timeoutMs/2)));
  if(exact.ok && apexOrderEvidence(exact.data)) return {...exact,source:'exact_client_id'};
  const created=Date.parse(context?.createdAt??'');
  if(!context?.symbol || !Number.isFinite(created) || created>Date.now() || Date.now()>=deadline) return exact;
  const end=Math.min(created+3600_000,Date.now());
  const history=await readApexPages<Record<string,unknown>>({keys:['orders'],pageSize:100,maxPages:5,
    read:page=>Date.now()>=deadline?Promise.resolve({ok:false,reason:'APEX_HISTORY_TIMEOUT'}):
      apexGet('/api/v3/history-orders',{symbol:context.symbol,beginTimeInclusive:created-60_000,
        endTimeExclusive:end,limit:100,page},creds,deadline-Date.now())});
  if(!history.ok) return {ok:false,reason:history.reason,source:'historical_orders'};
  // Exact identity only; a missing history row is never a terminal order.
  return {ok:true,data:findExactApexOrder(history.rows,clientOrderId),source:'historical_orders'};
}

export async function fetchApexHistoricalPnl(creds: ApexReadCreds,
  opts: { symbol: string; begin: number; end: number }, timeoutMs = 10000) {
  const deadline=Date.now()+timeoutMs;
  return readApexPages<Record<string,unknown>>({keys:['historicalPnl'],pageSize:100,maxPages:5,
    read:page=>Date.now()>=deadline?Promise.resolve({ok:false,reason:'APEX_HISTORY_TIMEOUT'}):
      apexGet('/api/v3/historical-pnl',{symbol:opts.symbol,beginTimeInclusive:opts.begin,
        endTimeExclusive:opts.end,limit:100,page},creds,deadline-Date.now())});
}

// ---- account equity -------------------------------------------------------
// `/api/v3/account-balance` is the funded Perps margin account. `/api/v3/account`
// can report sparse or zero balances, so it is NOT used for equity. Mirrors
// signer/app/apex_omni_rest.py::read_account_balance field tolerance.
export interface AccountEquity {
  total_equity: number | null;
  available_balance: number | null;
  currency: string;
}

function pickNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function fetchAccountEquity(
  creds: ApexReadCreds,
  timeoutMs = 15000,
): Promise<{ ok: true; equity: AccountEquity } | { ok: false; reason: string }> {
  const res = await apexGet("/api/v3/account-balance", {}, creds, timeoutMs);
  if (!res.ok) return { ok: false, reason: res.reason || "APEX_ERROR" };
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  const contract = (data.contractAccount && typeof data.contractAccount === "object"
    ? data.contractAccount
    : {}) as Record<string, unknown>;
  const total = pickNum(
    data.totalEquityValue, data.totalEquity, data.equity,
    contract.totalEquityValue, contract.totalEquity, contract.equity,
  );
  const avail = pickNum(
    data.availableBalance, data.available,
    contract.availableBalance, contract.available,
  );
  const cur = data.currency ?? data.quoteCurrency ?? "USDT";
  return {
    ok: true,
    equity: {
      total_equity: total,
      available_balance: avail,
      currency: typeof cur === "string" && cur ? cur : "USDT",
    },
  };
}
