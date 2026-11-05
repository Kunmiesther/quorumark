// Structured parsing of the signer's sanitized reject tokens.
//
// The signer emits `UPSTREAM_REJECT:<code>:<CATEGORY>` (see
// signer/app/venue_reject.py). Wrappers may prefix it, e.g.
// `ENTRY_SUBMIT_FAILED:UPSTREAM_REJECT:3:VENUE_REJECT_INSUFFICIENT_MARGIN`.
//
// This module NEVER accepts free venue text: anything not on the category
// allowlist collapses to VENUE_REJECT_UNCLASSIFIED. The broker persists only
// the fields produced here — never headers, credentials, signatures, or raw
// bodies.

export const UNCLASSIFIED = "VENUE_REJECT_UNCLASSIFIED";

export const ALLOWED_CATEGORIES: ReadonlySet<string> = new Set([
  "VENUE_REJECT_INSUFFICIENT_MARGIN",
  "VENUE_REJECT_POSITION_LIMIT",
  "VENUE_REJECT_LEVERAGE",
  "VENUE_REJECT_PRICE_BOUNDS",
  "VENUE_REJECT_SIZE_PRECISION",
  "VENUE_REJECT_REDUCE_ONLY",
  "VENUE_REJECT_DUPLICATE",
  "VENUE_REJECT_SIGNATURE",
  "VENUE_REJECT_AUTH",
  "VENUE_REJECT_RATE_LIMITED",
  "VENUE_REJECT_MARKET_STATE",
  UNCLASSIFIED,
]);

const MAX_CODE_LEN = 32;
const MAX_MAPPING_LEN = 64;
const MAX_MESSAGE_LEN = 120;

export interface VenueRejectFacts {
  /** Full signer mapping code, e.g. "ENTRY_SUBMIT_FAILED" or "SIGNER_TIMEOUT". */
  signer_mapping: string;
  /** Venue numeric/alphanumeric code when present, else null. */
  venue_code: string | null;
  /** Allowlisted category — never venue text. */
  venue_category: string | null;
  /** Allowlisted safe phrase when the signer supplied one, else null. */
  venue_message: string | null;
}

function clean(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.replace(/[^A-Za-z0-9_\-. ]/g, "").trim().slice(0, max);
}

/** Parse a signer reject_reason token into durable, sanitized facts. */
export function parseRejectReason(
  reason: string | null | undefined,
  safeMessage?: unknown,
): VenueRejectFacts {
  const raw = typeof reason === "string" ? reason : "";
  const parts = raw.split(":");
  const idx = parts.findIndex((p) => p === "UPSTREAM_REJECT");

  const mapping = clean(parts[0] || "UNKNOWN", MAX_MAPPING_LEN) || "UNKNOWN";

  if (idx === -1) {
    return {
      signer_mapping: mapping,
      venue_code: null,
      venue_category: null,
      venue_message: null,
    };
  }

  const venue_code = clean(parts[idx + 1], MAX_CODE_LEN) || null;
  const rawCategory = clean(parts[idx + 2], MAX_MAPPING_LEN);
  const venue_category = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : UNCLASSIFIED;

  const msg = clean(safeMessage, MAX_MESSAGE_LEN);
  return {
    signer_mapping: mapping,
    venue_code,
    venue_category,
    venue_message: venue_category === UNCLASSIFIED ? null : (msg || null),
  };
}
