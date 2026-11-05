// HMAC-signed forward from the edge execution-broker to the private
// Railway signer (`apex-omni-signer`, `signer/app/main.py`).
//
// Contract (see signer/app/security.py::enforce_signed_request):
//   headers:
//     x-signer-timestamp: unix seconds
//     x-signer-nonce:     random hex
//     x-signer-signature: HMAC-SHA256(secret, `${ts}\n${nonce}\n${path}\n${body}`) hex
//
// The signer's create-order route is `/v1/create-order`. This module
// posts to `${SIGNER_BASE_URL}/v1/create-order` with the JSON body the
// caller supplies verbatim (no reshaping here — the caller owns field
// mapping). The signer's response is opaque JSON.
//
// Outcomes returned to callers:
//   { kind: "submitted",   orderId, status }
//   { kind: "rejected",    code, httpStatus }
//   { kind: "ambiguous",   reason }   // network timeout / abort — MUST NOT be retried by caller
//   { kind: "unreachable", reason }   // pre-request config error / DNS / TLS

// Owner-ratified 2026-07-27: the edge broker forwards its minimal body
// shape to /v1/orders, which stages STARK material, pilot clamps, and
// protection defaults internally. /v1/create-order remains available for
// the Railway broker's pre-staged path and is not touched by this module.
export const SIGNER_CREATE_ORDER_PATH = "/v1/orders";

export interface SignerForwardResult {
  kind: "submitted" | "rejected" | "ambiguous" | "unreachable";
  httpStatus?: number;
  orderId?: string | null;
  status?: string | null;
  code?: string | null;
  reason?: string | null;
  // Post-build order snapshot the signer echoes back so the panel can show
  // the exact size/notional/protected price submitted (or attempted) — even
  // on venue rejects that arrive as a 200 body with status:"rejected".
  built?: Record<string, unknown> | null;
  // Sanitized venue-reject facts + deployed signer revision. Durable
  // observability: Railway stdout does not survive container rotation.
  venueReject?: Record<string, unknown> | null;
  signerRevision?: string | null;
  raw?: unknown;
}


export interface SignerForwardOptions {
  baseUrl?: string;
  sharedSecret?: string;
  timeoutMs?: number;
  path?: string;
  // Injectable for tests.
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomNonce?: () => string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function computeHmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return hex(sig);
}

/** Post a JSON body to the signer using its HMAC contract.
 *  Never throws — every failure is mapped to a SignerForwardResult. */
export async function forwardToSigner(
  body: Record<string, unknown>,
  opts: SignerForwardOptions = {},
): Promise<SignerForwardResult> {
  const denoEnv = (globalThis as unknown as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno?.env;
  const baseUrl = (opts.baseUrl ?? denoEnv?.get("SIGNER_BASE_URL") ?? "").replace(/\/$/, "");
  const secret = opts.sharedSecret ?? denoEnv?.get("SIGNER_SHARED_SECRET") ?? "";
  const timeoutMs = opts.timeoutMs ?? Number(denoEnv?.get("SIGNER_TIMEOUT_MS") || 10000);
  const path = opts.path ?? SIGNER_CREATE_ORDER_PATH;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowSec = () => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);

  if (!baseUrl || !secret) {
    return { kind: "unreachable", reason: "SIGNER_NOT_CONFIGURED" };
  }

  const bodyStr = JSON.stringify(body);
  const ts = String(nowSec());
  const nonce = opts.randomNonce
    ? opts.randomNonce()
    : hex(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await computeHmac(secret, `${ts}\n${nonce}\n${path}\n${bodyStr}`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
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
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { kind: "ambiguous", reason: aborted ? "SIGNER_TIMEOUT" : "SIGNER_NETWORK_ERROR" };
  } finally {
    clearTimeout(t);
  }

  let raw: unknown = null;
  const text = await res.text().catch(() => "");
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }

  if (!res.ok) {
    // Prefer signer's `detail` (FastAPI HTTPException code).
    const detail =
      (raw && typeof raw === "object" && (raw as Record<string, unknown>)["detail"]) ??
      (raw && typeof raw === "object" && (raw as Record<string, unknown>)["reject_reason"]) ??
      null;
    return {
      kind: "rejected",
      httpStatus: res.status,
      code: typeof detail === "string" ? detail : `SIGNER_HTTP_${res.status}`,
      raw,
    };
  }

  const obj = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const status = typeof obj["status"] === "string" ? (obj["status"] as string) : null;
  const orderId =
    (typeof obj["venue_order_id"] === "string" && (obj["venue_order_id"] as string)) ||
    (typeof obj["exchange_order_id"] === "string" && (obj["exchange_order_id"] as string)) ||
    null;
  const built =
    (obj["built"] && typeof obj["built"] === "object")
      ? (obj["built"] as Record<string, unknown>)
      : null;
  const venueReject =
    (obj["venue_reject"] && typeof obj["venue_reject"] === "object")
      ? (obj["venue_reject"] as Record<string, unknown>)
      : null;
  const signerRevision =
    typeof obj["signer_revision"] === "string" ? (obj["signer_revision"] as string) : null;

  if (status === "submitted" || orderId) {
    return { kind: "submitted", httpStatus: res.status, orderId, status: status ?? "accepted", built, venueReject, signerRevision, raw };
  }
  if (status === "rejected") {
    const code = typeof obj["reject_reason"] === "string" ? (obj["reject_reason"] as string) : "SIGNER_REJECTED";
    return { kind: "rejected", httpStatus: res.status, code, built, venueReject, signerRevision, raw };
  }
  // 2xx with unexpected shape — treat as ambiguous so caller reconciles, never retries.
  return { kind: "ambiguous", reason: "SIGNER_RESPONSE_SHAPE_UNKNOWN" };
}
