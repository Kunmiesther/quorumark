/**
 * Normalized BYDFi error taxonomy.
 * Never carries secrets — safe to persist / log / return to UI.
 */

export type BydfiErrorCode =
  | "invalid_credentials"
  | "signature_rejected"
  | "clock_skew"
  | "timestamp_expired"
  | "rate_limited"
  | "permission_denied"
  | "network_timeout"
  | "network_error"
  | "http_error"
  | "malformed_response"
  | "withdrawal_permission_present"
  | "unknown";

export interface BydfiNormalizedError {
  code: BydfiErrorCode;
  message: string;
  /** Provider-side status/code (safe, non-secret). */
  upstream?: { httpStatus?: number; code?: string | number };
}

export function normalizeUpstreamError(
  httpStatus: number,
  bodyText: string,
): BydfiNormalizedError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* keep raw */
  }
  const p = (parsed ?? {}) as { code?: string | number; msg?: string; message?: string };
  const upCode = p.code;
  const upMsg = (p.msg ?? p.message ?? "").toString().slice(0, 240);

  if (httpStatus === 401 || httpStatus === 403) {
    // BYDFi returns 401/403 for signature or permission failures.
    if (/sign|signature/i.test(upMsg)) {
      return { code: "signature_rejected", message: "Signature rejected by BYDFi.", upstream: { httpStatus, code: upCode } };
    }
    if (/timestamp|expired/i.test(upMsg)) {
      return { code: "timestamp_expired", message: "Request timestamp rejected — clock skew.", upstream: { httpStatus, code: upCode } };
    }
    if (/permission|forbidden/i.test(upMsg)) {
      return { code: "permission_denied", message: "API key lacks required permission.", upstream: { httpStatus, code: upCode } };
    }
    return { code: "invalid_credentials", message: "BYDFi rejected the credentials.", upstream: { httpStatus, code: upCode } };
  }
  if (httpStatus === 429) {
    return { code: "rate_limited", message: "BYDFi rate limit hit — retry with backoff.", upstream: { httpStatus, code: upCode } };
  }
  if (httpStatus >= 500) {
    return { code: "http_error", message: "BYDFi upstream error.", upstream: { httpStatus, code: upCode } };
  }
  return { code: "http_error", message: upMsg || `Unexpected HTTP ${httpStatus}.`, upstream: { httpStatus, code: upCode } };
}
