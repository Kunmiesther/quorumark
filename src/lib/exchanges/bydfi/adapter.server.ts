/**
 * BYDFi server-only runtime adapter.
 *
 * Responsibilities:
 *   - Authenticated read-only handshake against /v1/account/assets
 *     (official private endpoint — see developers.bydfi.com/en/private)
 *   - Public product metadata read: /v1/fapi/market/exchange_info
 *   - Clock-skew tolerant timestamp handling (BYDFI_RECV_WINDOW_MS = 30s)
 *   - Timeout + single retry with exponential backoff on transient errors
 *   - Rate-limit awareness (HTTP 429 → normalized "rate_limited" error)
 *   - Never places / signs / cancels an order. There is no order code path
 *     reachable from this module — trading is disabled at build time.
 */

import { bydfiAuthHeaders, BYDFI_RECV_WINDOW_MS } from "./sign";
import { normalizeUpstreamError, type BydfiNormalizedError } from "./errors";
import {
  normalizeAccountAssets,
  normalizeExchangeInfo,
  type BydfiAccountIdentity,
} from "./normalize";
import type { VerifiedInstrument } from "@/lib/universe/types";

const DEFAULT_BASE = "https://api.bydfi.com";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 1;

// Explicit disabled surface. Import protection: no order path exists.
export const BYDFI_ORDER_EXECUTION_ENABLED = false as const;

interface FetchOpts {
  method: "GET";
  path: string;
  query?: Record<string, string>;
  signed: boolean;
  credentials?: { accessKey: string; secret: string };
}

interface FetchResult {
  ok: boolean;
  status: number;
  bodyText: string;
  parsed: unknown;
  error?: BydfiNormalizedError;
}

function baseUrl(): string {
  return (process.env.BYDFI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

function toQueryString(q: Record<string, string> | undefined): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const k of Object.keys(q).sort()) p.append(k, q[k]!);
  return p.toString();
}

async function doFetch(opts: FetchOpts): Promise<FetchResult> {
  const qs = toQueryString(opts.query);
  const url = `${baseUrl()}${opts.path}${qs ? `?${qs}` : ""}`;
  const timestampMs = Date.now();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.signed) {
    if (!opts.credentials) throw new Error("Signed request requires credentials.");
    const signed = await bydfiAuthHeaders({
      accessKey: opts.credentials.accessKey,
      secret: opts.credentials.secret,
      timestampMs,
      queryString: qs,
      body: "",
    });
    Object.assign(headers, signed);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: opts.method, headers, signal: ctrl.signal });
    const bodyText = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(bodyText); } catch { /* keep null */ }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        bodyText,
        parsed,
        error: normalizeUpstreamError(res.status, bodyText),
      };
    }
    return { ok: true, status: res.status, bodyText, parsed };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      bodyText: "",
      parsed: null,
      error: {
        code: isAbort ? "network_timeout" : "network_error",
        message: isAbort ? "BYDFi request timed out." : "BYDFi network error.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(opts: FetchOpts): Promise<FetchResult> {
  let last: FetchResult | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await doFetch(opts);
    if (r.ok) return r;
    const transient =
      r.error?.code === "network_timeout" ||
      r.error?.code === "network_error" ||
      r.error?.code === "rate_limited" ||
      (r.status >= 500 && r.status < 600);
    if (!transient || attempt === MAX_RETRIES) return r;
    // 300ms → 900ms backoff
    await new Promise((res) => setTimeout(res, 300 * Math.pow(3, attempt)));
    last = r;
  }
  return last ?? { ok: false, status: 0, bodyText: "", parsed: null, error: { code: "unknown", message: "unreachable" } };
}

export interface BydfiHandshakeResult {
  ok: boolean;
  error?: BydfiNormalizedError;
  identity?: BydfiAccountIdentity;
  instruments?: VerifiedInstrument[];
  verifiedAt: number;
  /** ms. Verified capability freshness window; caller may cache. */
  ttlMs: number;
  recvWindowMs: number;
}

/**
 * Full read-only handshake: authenticated /account/assets + public
 * /fapi/market/exchange_info. Does not touch any order endpoint.
 */
export async function bydfiReadOnlyHandshake(creds: {
  accessKey: string;
  secret: string;
}): Promise<BydfiHandshakeResult> {
  const startedAt = Date.now();

  const assets = await withRetry({
    method: "GET",
    path: "/v1/account/assets",
    query: { account: "UMFUTURE" },
    signed: true,
    credentials: creds,
  });
  if (!assets.ok) {
    return { ok: false, error: assets.error, verifiedAt: startedAt, ttlMs: 0, recvWindowMs: BYDFI_RECV_WINDOW_MS };
  }

  const info = await withRetry({
    method: "GET",
    path: "/v1/fapi/market/exchange_info",
    signed: false,
  });
  if (!info.ok) {
    return {
      ok: false,
      error: info.error,
      identity: normalizeAccountAssets(assets.parsed),
      verifiedAt: startedAt,
      ttlMs: 0,
      recvWindowMs: BYDFI_RECV_WINDOW_MS,
    };
  }

  return {
    ok: true,
    identity: normalizeAccountAssets(assets.parsed),
    instruments: normalizeExchangeInfo(info.parsed, Date.now()),
    verifiedAt: Date.now(),
    // 6h capability freshness — must be re-handshaken past this
    ttlMs: 6 * 60 * 60 * 1000,
    recvWindowMs: BYDFI_RECV_WINDOW_MS,
  };
}
