// Pure guard helpers for the execution-broker. Extracted so they can be
// unit-tested from Vitest without booting Deno. NEVER import Deno globals here.

export const ALLOWED_PURPOSES = new Set([
  "READ_ACCOUNT",
  "READ_MARKETS",
  "READ_ORDERS",
  "READ_POSITIONS",
  "CREATE_ORDER",
  "CANCEL_ORDER",
  "CANCEL_ALL_ORDERS",
  "CLOSE_POSITION",
  "CLOSE_ALL_POSITIONS",
  "testnet_proof",
  "proof_of_life",
]);

// Purposes that submit or modify an order and therefore require the full
// side/size/order_type/symbol payload.
export const EXECUTABLE_PURPOSES = new Set([
  "CREATE_ORDER",
  "CLOSE_POSITION",
  "CLOSE_ALL_POSITIONS",
  "testnet_proof",
  "proof_of_life",
]);


export type PurposeDecision =
  | { ok: true; purpose: string; requiresOrderFields: boolean }
  | { ok: false; reason: "MISSING_PURPOSE" | "UNSPECIFIED_PURPOSE_REJECTED" | "OPERATION_NOT_ALLOWED" | "FORBIDDEN_OPERATION" };

export function evaluatePurpose(rawPurpose: unknown, orderType: string | null): PurposeDecision {
  if (rawPurpose === undefined || rawPurpose === null || rawPurpose === "") {
    return { ok: false, reason: "MISSING_PURPOSE" };
  }
  if (typeof rawPurpose !== "string") {
    return { ok: false, reason: "OPERATION_NOT_ALLOWED" };
  }
  const p = rawPurpose;
  if (p === "unspecified") return { ok: false, reason: "UNSPECIFIED_PURPOSE_REJECTED" };
  if (!ALLOWED_PURPOSES.has(p)) return { ok: false, reason: "OPERATION_NOT_ALLOWED" };
  const forbidden = /(withdraw|deposit|transfer|payout|cashout)/i;
  if (forbidden.test(p) || (orderType && forbidden.test(orderType))) {
    return { ok: false, reason: "FORBIDDEN_OPERATION" };
  }
  return { ok: true, purpose: p, requiresOrderFields: EXECUTABLE_PURPOSES.has(p) };
}

// Canonical fingerprint over ORDER-DEFINING fields. Deliberately excludes
// is_live (parity with signer/app/idempotency.py) — replay must not become
// "new order" by flipping the live flag.
export interface FingerprintInput {
  user_id: string;
  connection_id: string;
  venue: string;
  symbol: string;
  side: string;
  order_type: string;
  size: number | null;
  price: number | null;
  leverage: number | null;
  reduce_only: boolean;
  purpose: string;
}

function canonicalize(input: FingerprintInput): string {
  const ordered = {
    connection_id: input.connection_id,
    leverage: input.leverage,
    order_type: input.order_type,
    price: input.price,
    purpose: input.purpose,
    reduce_only: input.reduce_only,
    side: input.side,
    size: input.size,
    symbol: input.symbol,
    user_id: input.user_id,
    venue: input.venue,
  };
  return JSON.stringify(ordered);
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function computeFingerprint(input: FingerprintInput): Promise<string> {
  const enc = new TextEncoder();
  const material = enc.encode(canonicalize(input));
  const digest = await crypto.subtle.digest("SHA-256", material);
  return bytesToHex(new Uint8Array(digest));
}

// Postgres unique_violation. Any other error must fail-closed at the caller.
export const PG_UNIQUE_VIOLATION = "23505";

export type SupabaseError = { code?: string | null; message?: string | null } | null | undefined;

export function isUniqueViolation(err: SupabaseError): boolean {
  return !!err && typeof err === "object" && err.code === PG_UNIQUE_VIOLATION;
}
