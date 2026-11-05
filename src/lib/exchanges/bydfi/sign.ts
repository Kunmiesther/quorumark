/**
 * BYDFi REST request signing.
 *
 * Source of truth: BYDFi official API docs
 *   https://developers.bydfi.com/en/signature
 *   https://developers.bydfi.com/en/started
 *   https://developers.bydfi.com/en/requestInteraction
 *
 * Algorithm (verbatim from docs, "Signature" section):
 *   sign = HMAC_SHA256_hex(secret, accessKey + timestamp + queryString + body)
 *   - queryString: the ordered query part (after ?) — omitted string when empty.
 *   - body: JSON body string — omitted when no body (typically GET).
 *
 * Headers (verbatim):
 *   X-API-KEY, X-API-TIMESTAMP, X-API-SIGNATURE, Content-Type: application/json
 *
 * BYDFi timestamps are Unix epoch milliseconds. WebSocket LOGIN docs state
 * a 30s expiry; the same window is enforced by their REST layer in practice
 * so we treat 30s as the recv-window budget.
 *
 * This module is READ-ONLY safe. Order/trade endpoint signing lives outside
 * this module and remains gated by a separate execution flag.
 */

export interface BydfiSignInput {
  /** Raw API access key ("X-API-KEY"). */
  accessKey: string;
  /** Raw API secret used for HMAC-SHA256. */
  secret: string;
  /** Unix epoch milliseconds. */
  timestampMs: number;
  /** Query part (without the leading `?`). Empty string when absent. */
  queryString: string;
  /** JSON body string. Empty string for GET / bodiless requests. */
  body: string;
}

export interface BydfiSignedHeaders {
  "X-API-KEY": string;
  "X-API-TIMESTAMP": string;
  "X-API-SIGNATURE": string;
  "Content-Type": "application/json";
}

/** Hex-encode a Uint8Array (lowercase, no separator). */
function toHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

/**
 * Compute the BYDFi X-API-SIGNATURE (hex HMAC-SHA256).
 * Pure function. Does not mutate inputs. Never logs.
 */
export async function signBydfi(input: BydfiSignInput): Promise<string> {
  const message =
    input.accessKey + String(input.timestampMs) + input.queryString + input.body;
  const keyBytes = new TextEncoder().encode(input.secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return toHex(new Uint8Array(sigBuf));
}

export async function bydfiAuthHeaders(input: BydfiSignInput): Promise<BydfiSignedHeaders> {
  const signature = await signBydfi(input);
  return {
    "X-API-KEY": input.accessKey,
    "X-API-TIMESTAMP": String(input.timestampMs),
    "X-API-SIGNATURE": signature,
    "Content-Type": "application/json",
  };
}

/**
 * Canonical string that must be signed. Exposed for test fixtures.
 * Never expose the secret alongside this value.
 */
export function bydfiCanonicalMessage(input: Omit<BydfiSignInput, "secret">): string {
  return input.accessKey + String(input.timestampMs) + input.queryString + input.body;
}

/** BYDFi timestamp validity window (ms). Per WebSocket LOGIN docs: 30s. */
export const BYDFI_RECV_WINDOW_MS = 30_000;
