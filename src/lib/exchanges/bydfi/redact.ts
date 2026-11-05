/**
 * BYDFi credential/secret redaction helpers.
 *
 * Redaction rules:
 *   - Never render a secret in full anywhere (logs, DB, analytics, chat, UI).
 *   - Only masked previews are permitted, with a fixed shape:
 *       `XXXX…YYYY` where X is the first 4 chars and Y the last 4.
 *   - Strings shorter than 12 chars are fully masked as `••••••`.
 *   - Common credential-shaped fields (api_key, api_secret, passphrase,
 *     signature, authorization, x-api-*, omni_seed, private_key, token,
 *     access_token, refresh_token) in objects are redacted recursively.
 *
 * These helpers are pure and side-effect free.
 */

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^api[_-]?key$/i,
  /^api[_-]?secret$/i,
  /^secret$/i,
  /^passphrase$/i,
  /^signature$/i,
  /^authorization$/i,
  /^x[_-]api[_-]/i,
  /^omni[_-]?seed$/i,
  /^private[_-]?key$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
}

/** Mask a single secret string to a short, non-invertible preview. */
export function maskSecret(value: string): string {
  if (typeof value !== "string") return "••••";
  const trimmed = value.trim();
  if (trimmed.length < 12) return "••••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** Deep-redact an arbitrary object for logs / audit / error responses. */
export function redactObject<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return value as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === "string") {
        out[k] = maskSecret(v);
      } else if (typeof v === "object" && v !== null) {
        out[k] = redactObject(v);
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }
  return value;
}
