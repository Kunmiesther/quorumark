// Execution Broker — legacy Supabase entrypoint.
//
// PHASE 2 REMEDIATION (2026-07-21):
//   * APEX_EXECUTION_MOVED_TO_RAILWAY is evaluated BEFORE body parsing,
//     signature verification, or credential access. When true this
//     function is structurally incapable of ApeX signing/submission.
//   * Purpose is REQUIRED. "unspecified" is rejected. Purpose is validated
//     via a typed allowlist (see _shared/broker-guard.ts).
//   * Pre-submit audit reservation is FAIL-CLOSED. A durable
//     order_audit row for phase="received" and phase="submitted" must
//     exist before the exchange call. Non-unique DB errors reject with a
//     sanitized RESERVATION_FAILED. Unique-violation returns duplicate ONLY
//     when the stored fingerprint matches; a fingerprint mismatch is
//     IDEMPOTENCY_CONFLICT.
//   * Ambiguous exchange outcomes surface as {status:"ambiguous"} for
//     reconciliation. Never retried blindly.
//   * Credentials/secrets/errors/stack traces are NEVER logged or returned.
//
// HARD SAFETY BOUNDARIES (do NOT relax):
//   1. HMAC over raw JSON body keyed by BROKER_SIGNING_SECRET.
//   2. is_live=true gated by owner-controlled APEX_MAINNET_* flags in
//      proof-gate.ts (see _shared/mainnet-flags.ts). When the owner has not
//      enabled the flags this behaves exactly like the legacy hard lock.
//   3. Every phase append-only in public.order_audit (trigger-guarded).
//   4. Ambiguous outcomes NOT retried.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  ApexOmniTestnetAdapter,
  type ApexOrderRequest,
  type DecryptedCredentials,
} from "../_shared/exchange-adapter.ts";
import {
  evaluateGate,
  extractMinOrderSize,
  isProofIntent,
  PROOF_TEST_SYMBOL,
  PROOF_VENUE,
  type BrokerConfigInput,
  type ProofIntentInput,
} from "../_shared/proof-gate.ts";
import { canSubmitMainnetOrder, readAllFlags } from "../_shared/mainnet-flags.ts";
import { forwardToSigner, SIGNER_CREATE_ORDER_PATH } from "../_shared/signer-client.ts";
import { parseRejectReason } from "../_shared/venue-reject.ts";
import {
  isQuorumarkMvpMode,
  quorumarkMvpDisabledResponse,
} from "../_shared/quorumark-mvp-guard.ts";
import {
  computeFingerprint,
  evaluatePurpose,
  EXECUTABLE_PURPOSES,
  isUniqueViolation,
  type FingerprintInput,
} from "../_shared/broker-guard.ts";

const TESTNET_VENUE_ID = PROOF_VENUE;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-broker-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SanitizedResponse = {
  status: "submitted" | "rejected" | "duplicate" | "ambiguous";
  exchange_order_id: string | null;
  exchange_status: string | null;
  reject_reason: string | null;
  // Post-build order snapshot from the signer (size / notional / protected
  // price). Present on success AND on post-build venue rejects. Null when
  // rejection happened before the builder ran.
  built?: Record<string, unknown> | null;
  // Sanitized venue-rejection facts persisted for every rejected/ambiguous
  // live request. Durable because Railway stdout is not.
  venue_reject?: Record<string, unknown> | null;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// ---- credential decryption (SAME scheme as exchange-credentials) ----
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

// ---- HMAC intent signature verification ----
function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyIntentSignature(rawBody: string, providedHex: string): Promise<boolean> {
  const secret = Deno.env.get("BROKER_SIGNING_SECRET");
  if (!secret) throw new Error("MISSING_BROKER_SIGNING_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const expected = bytesToHex(sig);
  const provided = (providedHex || "").trim().toLowerCase();
  if (!hexToBytes(provided)) return false;
  return timingSafeEqualHex(expected, provided);
}

// ---- audit helpers ----
type AuditPhase = "received" | "validated" | "rejected" | "submitted" | "exchange_response";
type AuditRow = {
  user_id: string | null;
  connection_id: string | null;
  idempotency_key: string | null;
  phase: AuditPhase;
  venue?: string | null;
  symbol?: string | null;
  side?: string | null;
  order_type?: string | null;
  size?: number | null;
  price?: number | null;
  leverage?: number | null;
  is_live?: boolean | null;
  reject_reason?: string | null;
  exchange_order_id?: string | null;
  exchange_status?: string | null;
  sanitized_response?: Record<string, unknown> | null;
};

/** Best-effort audit — reserved for phases whose failure cannot block the
 * fail-closed contract (post-submit reconciliation, rejected-phase records
 * that already have a durable pre-submit reservation). Callers of this
 * helper must never depend on it for safety decisions. */
async function auditBestEffort(admin: ReturnType<typeof createClient>, row: AuditRow) {
  try {
    await admin.from("order_audit").insert(row);
  } catch (_e) {
    // swallowed — this row is best-effort by design (see docstring).
  }
}

/** Fail-closed audit insert. Returns:
 *   { ok: true }                       — durable row created
 *   { ok: false, kind: "duplicate" }   — unique violation on (connection_id, idempotency_key, phase)
 *   { ok: false, kind: "error" }       — any other DB error; caller must reject
 * Never throws. Never surfaces DB messages. */
async function auditStrict(
  admin: ReturnType<typeof createClient>,
  row: AuditRow,
): Promise<{ ok: true } | { ok: false; kind: "duplicate" | "error" }> {
  try {
    const { error } = await admin.from("order_audit").insert(row);
    if (!error) return { ok: true };
    if (isUniqueViolation(error)) return { ok: false, kind: "duplicate" };
    return { ok: false, kind: "error" };
  } catch {
    return { ok: false, kind: "error" };
  }
}

// ---- order_intents ledger mirror ----------------------------------------
// `order_audit` is the append-only forensic trail. `order_intents` is the
// CURRENT-STATE row the UI and the reconciler read. Before this mirror the
// broker wrote only the audit trail, so `order_intents` stayed empty for
// every live dispatch and no surface could show an in-flight order.
//
// Best-effort BY DESIGN: the fail-closed safety contract is already carried
// by `auditStrict` on `order_audit`. A ledger-mirror failure must never
// block, resubmit, or unwind a real venue order.
type IntentState =
  "queued" | "submitted" | "filled" | "rejected" | "failed" | "reconciliation_required";

function intentStateFor(r: SanitizedResponse): IntentState {
  if (r.status === "submitted") return "submitted";
  if (r.status === "rejected") return "rejected";
  // "ambiguous" — a venue call may or may not have landed. This is exactly
  // what the reconciler sweeps; never collapse it to rejected.
  return "reconciliation_required";
}

async function mirrorIntent(
  admin: ReturnType<typeof createClient>,
  row: {
    user_id: string;
    connection_id: string;
    client_order_id: string;
    environment: string;
    venue: string;
    symbol: string | null;
    side: string | null;
    order_type: string | null;
    size: number | null;
    price: number | null;
    reduce_only: boolean;
    state: IntentState;
    state_reason?: string | null;
    exchange_order_id?: string | null;
    exchange_status?: string | null;
  },
): Promise<void> {
  try {
    await admin.from("order_intents").upsert(
      {
        user_id: row.user_id,
        connection_id: row.connection_id,
        client_order_id: row.client_order_id,
        environment: row.environment,
        venue: row.venue,
        symbol: row.symbol ?? "UNKNOWN",
        side: row.side ?? "BUY",
        order_type: row.order_type ?? "MARKET",
        size: Number.isFinite(row.size as number) ? row.size : 0,
        protected_price: row.price !== null && Number.isFinite(row.price) ? row.price : null,
        reduce_only: row.reduce_only,
        state: row.state,
        state_reason: row.state_reason ?? null,
        exchange_order_id: row.exchange_order_id ?? null,
        exchange_status: row.exchange_status ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,client_order_id" },
    );
  } catch (_e) {
    // swallowed — see docstring.
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json(405, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "METHOD_NOT_ALLOWED",
    } satisfies SanitizedResponse);
  }

  // PHASE 2 — SINGLE AUTHORITY.
  // Evaluated BEFORE body parsing, signature verification, credential
  // decryption, and DB access. When APEX_EXECUTION_MOVED_TO_RAILWAY=true,
  // no ApeX code in this function is reachable — the only exchange adapter
  // imported here is the testnet ApeX one, so the function is a no-op.
  if (isQuorumarkMvpMode()) {
    return quorumarkMvpDisabledResponse("execution-broker", corsHeaders);
  }
  const apexMovedToRailway = Deno.env.get("APEX_EXECUTION_MOVED_TO_RAILWAY") === "true";
  if (apexMovedToRailway) {
    return json(410, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "APEX_EXECUTION_MOVED_TO_RAILWAY_BROKER",
    } satisfies SanitizedResponse);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json(500, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "BACKEND_NOT_CONFIGURED",
    } satisfies SanitizedResponse);
  }
  if (!Deno.env.get("BROKER_SIGNING_SECRET")) {
    return json(500, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "BROKER_SIGNING_SECRET_NOT_CONFIGURED",
    } satisfies SanitizedResponse);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rawBody = await req.text();
  const providedSig = req.headers.get("x-broker-signature") ?? "";

  let sigOk = false;
  try {
    sigOk = await verifyIntentSignature(rawBody, providedSig);
  } catch {
    return json(500, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "BROKER_SIGNING_SECRET_NOT_CONFIGURED",
    } satisfies SanitizedResponse);
  }
  if (!sigOk) {
    return json(401, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "INVALID_SIGNATURE",
    } satisfies SanitizedResponse);
  }

  let intent: Record<string, unknown>;
  try {
    intent = JSON.parse(rawBody);
  } catch {
    return json(400, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: "INVALID_JSON",
    } satisfies SanitizedResponse);
  }

  const idempotency_key = String(intent.idempotency_key ?? "");
  const user_id = String(intent.user_id ?? "");
  const connection_id = String(intent.connection_id ?? "");
  // Canonical venue id. Callers historically sent both "apex-omni" and
  // "apex_omni"; exchange_connections/active_bot_config store the underscore
  // form. Without this normalization the hyphen form failed the ownership
  // check with VENUE_CONNECTION_MISMATCH even though the account matched.
  const venue = String(intent.venue ?? "")
    .toLowerCase()
    .replace(/-/g, "_");
  const symbol = String(intent.symbol ?? "");
  const side = String(intent.side ?? "").toUpperCase();
  const order_type = String(intent.order_type ?? "").toUpperCase();
  const size = Number(intent.size ?? NaN);
  const priceRaw = intent.price_or_trigger;
  const price =
    priceRaw === undefined || priceRaw === null || priceRaw === "" ? null : Number(priceRaw);
  const leverage =
    intent.leverage === undefined || intent.leverage === null ? null : Number(intent.leverage);
  const reduce_only = intent.reduce_only === true;
  const is_live = intent.is_live === true;
  const confirmation_token = intent.confirmation_token ? String(intent.confirmation_token) : "";
  const purposeRaw =
    typeof intent.purpose === "string"
      ? intent.purpose
      : typeof intent.intent_purpose === "string"
        ? intent.intent_purpose
        : undefined;
  const proof_token = typeof intent.proof_token === "string" ? intent.proof_token : "";
  // Lifecycle identity, when the deterministic strategy supplied one. Used only
  // to correlate a durable rejection record back to its candidate.
  const candidate_id = typeof intent.candidate_id === "string" ? intent.candidate_id : null;
  const evidence_hash = typeof intent.evidence_hash === "string" ? intent.evidence_hash : null;

  // Optional H2 TP ladder — forwarded verbatim to the signer, which
  // validates shape and tick-rounds each trigger. Broker does not compute.
  const tp_tiers = Array.isArray(intent.tp_tiers) ? intent.tp_tiers : null;
  const stop_pct =
    typeof intent.stop_pct === "number" && Number.isFinite(intent.stop_pct)
      ? intent.stop_pct
      : null;

  // ---- Purpose allowlist (typed, primary authorization) ----
  const purposeDecision = evaluatePurpose(purposeRaw, order_type || null);
  if (!purposeDecision.ok) {
    // Emit a rejected-phase audit row best-effort. Even if this write fails,
    // the request has done no exchange work, so it is safe to return the
    // sanitized rejection.
    await auditBestEffort(admin, {
      user_id: user_id || null,
      connection_id: connection_id || null,
      idempotency_key: idempotency_key || null,
      phase: "rejected",
      venue: venue || null,
      reject_reason: purposeDecision.reason,
    });
    const status = purposeDecision.reason === "FORBIDDEN_OPERATION" ? 403 : 400;
    return json(status, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: purposeDecision.reason,
    } satisfies SanitizedResponse);
  }
  const purpose = purposeDecision.purpose;
  const requiresOrderFields = purposeDecision.requiresOrderFields;

  // ---- Baseline field validation (always required) ----
  const rejectSanitized = (reason: string, status = 400): Response =>
    json(status, {
      status: "rejected",
      exchange_order_id: null,
      exchange_status: null,
      reject_reason: reason,
    } satisfies SanitizedResponse);

  if (!idempotency_key) return rejectSanitized("MISSING_IDEMPOTENCY_KEY");
  if (!user_id) return rejectSanitized("MISSING_USER_ID");
  if (!connection_id) return rejectSanitized("MISSING_CONNECTION_ID");
  if (!venue) return rejectSanitized("MISSING_VENUE");

  // ---- Order-shape validation (executable purposes only) ----
  if (requiresOrderFields) {
    if (!symbol) return rejectSanitized("MISSING_SYMBOL");
    if (side !== "BUY" && side !== "SELL") return rejectSanitized("INVALID_SIDE");
    if (!order_type) return rejectSanitized("MISSING_ORDER_TYPE");
    if (!Number.isFinite(size) || size <= 0) return rejectSanitized("INVALID_SIZE");
  }

  // ---- Fail-closed pre-submit audit reservation (phase = received) ----
  // Compute fingerprint over order-defining fields; stored inside
  // sanitized_response so duplicate detection can verify parameter
  // equivalence against the prior record. `is_live` deliberately excluded
  // (parity with signer/app/idempotency.py).
  const fingerprintInput: FingerprintInput = {
    user_id,
    connection_id,
    venue,
    symbol,
    side,
    order_type,
    size: Number.isFinite(size) ? size : null,
    price: price !== null && Number.isFinite(price) ? price : null,
    leverage: leverage !== null && Number.isFinite(leverage) ? leverage : null,
    reduce_only,
    purpose,
  };
  let fingerprint = "";
  try {
    fingerprint = await computeFingerprint(fingerprintInput);
  } catch {
    return rejectSanitized("RESERVATION_FAILED", 503);
  }

  const receivedRow: AuditRow = {
    user_id,
    connection_id,
    idempotency_key,
    phase: "received",
    venue,
    symbol: symbol || null,
    side: side || null,
    order_type: order_type || null,
    size: Number.isFinite(size) ? size : null,
    price: price !== null && Number.isFinite(price) ? price : null,
    leverage: leverage !== null && Number.isFinite(leverage) ? leverage : null,
    is_live,
    sanitized_response: { fingerprint, purpose },
  };
  const receivedRes = await auditStrict(admin, receivedRow);
  if (!receivedRes.ok && receivedRes.kind === "error") {
    // DB write failed for a non-unique reason: outage, RLS, schema, unknown.
    // Fail closed — never proceed to signing / exchange.
    return rejectSanitized("RESERVATION_FAILED", 503);
  }
  if (!receivedRes.ok && receivedRes.kind === "duplicate") {
    // Prior `received` row exists for this (connection_id, idempotency_key, phase).
    // Only a matching fingerprint may return duplicate; any mismatch is CONFLICT.
    const { data: prior, error: priorErr } = await admin
      .from("order_audit")
      .select("sanitized_response, exchange_order_id, exchange_status")
      .eq("connection_id", connection_id)
      .eq("idempotency_key", idempotency_key)
      .eq("phase", "received")
      .maybeSingle();
    if (priorErr) return rejectSanitized("RESERVATION_FAILED", 503);
    const priorFp =
      prior && typeof prior.sanitized_response === "object" && prior.sanitized_response !== null
        ? (prior.sanitized_response as Record<string, unknown>)["fingerprint"]
        : null;
    if (typeof priorFp !== "string" || priorFp !== fingerprint) {
      return rejectSanitized("IDEMPOTENCY_CONFLICT", 409);
    }
    // Fingerprint matches — resolve to prior submitted response if available.
    const { data: priorSubmitted } = await admin
      .from("order_audit")
      .select("sanitized_response, exchange_order_id, exchange_status")
      .eq("connection_id", connection_id)
      .eq("idempotency_key", idempotency_key)
      .eq("phase", "submitted")
      .maybeSingle();
    if (priorSubmitted) {
      const prev = (priorSubmitted.sanitized_response as SanitizedResponse | null) ?? {
        status: "submitted",
        exchange_order_id: priorSubmitted.exchange_order_id ?? null,
        exchange_status: priorSubmitted.exchange_status ?? null,
        reject_reason: null,
      };
      return json(200, { ...prev, status: "duplicate" });
    }
    // No prior submitted row — a prior `received` reservation exists but the
    // submit path did not durably record. Report ambiguous for reconciliation
    // rather than resubmit blindly.
    return json(200, {
      status: "ambiguous",
      exchange_order_id: null,
      exchange_status: "reservation_pending",
      reject_reason: "RECONCILIATION_REQUIRED",
    } satisfies SanitizedResponse);
  }

  // Ledger: the intent is now durably reserved and eligible to progress.
  const intentBase = {
    user_id,
    connection_id,
    client_order_id: idempotency_key.slice(0, 64),
    environment: is_live ? "mainnet" : "testnet",
    venue,
    symbol: symbol || null,
    side: side || null,
    order_type: order_type || null,
    size: Number.isFinite(size) ? size : null,
    price: price !== null && Number.isFinite(price) ? price : null,
    reduce_only,
  };
  await mirrorIntent(admin, { ...intentBase, state: "queued" });

  const rejectAfterReservation = async (reason: string, status = 400): Promise<Response> => {
    await auditBestEffort(admin, {
      user_id,
      connection_id,
      idempotency_key,
      phase: "rejected",
      venue,
      symbol: symbol || null,
      side: side || null,
      order_type: order_type || null,
      size: Number.isFinite(size) ? size : null,
      price: price !== null && Number.isFinite(price) ? price : null,
      leverage: leverage !== null && Number.isFinite(leverage) ? leverage : null,
      is_live,
      reject_reason: reason,
    });
    await mirrorIntent(admin, {
      ...intentBase,
      state: "rejected",
      state_reason: reason,
      exchange_status: "rejected",
    });
    return rejectSanitized(reason, status);
  };

  // ---- Kill switch, fail closed ----
  {
    let halted = true;
    try {
      const { data, error } = await admin.rpc("is_execution_halted", {
        p_user_id: user_id,
        p_connection_id: connection_id,
      });
      if (error) halted = true;
      else if (data === true) halted = true;
      else if (data === false) halted = false;
      else halted = true;
    } catch {
      halted = true;
    }
    if (halted) return rejectAfterReservation("EXECUTION_HALTED");
  }

  // ---- Config / connection ownership ----
  // active_bot_config is a view with one row per (user, connection, symbol,
  // market_type). We only need the connection-level fields, so take the first
  // matching row. Using .maybeSingle() here silently returns null when the
  // view has >1 row for the pair and mis-reports CONFIG_NOT_FOUND.
  const { data: cfgRows } = await admin
    .from("active_bot_config")
    .select(
      "user_id, connection_id, exchange_type, enabled, mode, permission_trade, permissions_verified, environment, status",
    )
    .eq("user_id", user_id)
    .eq("connection_id", connection_id)
    .limit(1);
  const cfgRow = Array.isArray(cfgRows) && cfgRows.length > 0 ? cfgRows[0] : null;
  if (!cfgRow) return rejectAfterReservation("CONFIG_NOT_FOUND");
  if (!cfgRow.exchange_type) return rejectAfterReservation("CONNECTION_NOT_FOUND");
  if (cfgRow.permissions_verified !== true)
    return rejectAfterReservation("CONNECTION_NOT_VERIFIED");
  if (cfgRow.permission_trade !== true) return rejectAfterReservation("PERMISSION_TRADE_DENIED");
  if (cfgRow.exchange_type !== venue) return rejectAfterReservation("VENUE_CONNECTION_MISMATCH");

  const cfg: BrokerConfigInput = {
    enabled: cfgRow.enabled === true,
    exchange_type: cfgRow.exchange_type ?? null,
    environment: (cfgRow as { environment?: string | null }).environment ?? null,
    permission_trade: cfgRow.permission_trade === true,
    permissions_verified: cfgRow.permissions_verified === true,
  };

  const gateIntent: ProofIntentInput = {
    purpose,
    venue,
    symbol,
    reduce_only,
    is_live,
    size,
    proof_token,
  };

  let minOrderSize: number | null = null;
  if (isProofIntent(purpose) && !is_live) {
    if (venue === TESTNET_VENUE_ID && symbol === PROOF_TEST_SYMBOL) {
      try {
        const a = new ApexOmniTestnetAdapter();
        const sy = await a.fetchSymbolsRaw();
        if (sy.ok) minOrderSize = extractMinOrderSize(sy.data, PROOF_TEST_SYMBOL);
      } catch {
        minOrderSize = null;
      }
    }
  }

  const flags = readAllFlags();
  const mainnetEnabled = canSubmitMainnetOrder(flags);
  const decision = evaluateGate({
    intent: { ...gateIntent, confirmation_token },
    cfg,
    signatureValid: true,
    minOrderSize,
    mainnetEnabled,
  });
  if (!decision.ok) {
    return rejectAfterReservation(
      decision.reason,
      decision.reason === "INVALID_SIGNATURE" ? 401 : 400,
    );
  }
  if (decision.path === "enabled") {
    return rejectAfterReservation("VENUE_INTEGRATION_PENDING");
  }
  // decision.path is "proof" (testnet proof) or "live" (owner-enabled mainnet).
  // Both proceed into the exchange call below; the adapter enforces its own
  // downstream authorization (signer flags, credentials, connectivity).
  if (!EXECUTABLE_PURPOSES.has(purpose)) {
    // Sanity: reached exchange path but purpose is not order-executable.
    return rejectAfterReservation("OPERATION_NOT_ALLOWED", 403);
  }

  // ---- Atomic proof-token consume (proof path only) ----
  if (decision.path === "proof") {
    const { data: consumed, error: consumeErr } = await admin
      .from("proof_authorizations")
      .update({
        consumed_at: new Date().toISOString(),
        consumed_by_idempotency_key: idempotency_key,
      })
      .eq("token", proof_token)
      .eq("user_id", user_id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();
    if (consumeErr || !consumed) {
      return rejectAfterReservation("REJECT_TOKEN_ALREADY_USED");
    }
  }

  // ---- Live path: forward to Railway signer (HMAC) ----
  // The testnet adapter below CANNOT submit mainnet orders. On the live
  // path we hand off to the private signer service which owns credential
  // decrypt, STARK signing, pilot-size clamping (signer/app/builder.py via
  // shared/parity_constants.py) and REST submission to ApeX Omni.
  if (decision.path === "live") {
    const submittedPending: SanitizedResponse = {
      status: "submitted",
      exchange_order_id: null,
      exchange_status: "pending",
      reject_reason: null,
    };
    const submitReservation = await auditStrict(admin, {
      user_id,
      connection_id,
      idempotency_key,
      phase: "submitted",
      venue,
      symbol,
      side,
      order_type,
      size,
      price,
      leverage,
      is_live,
      sanitized_response: { ...submittedPending, fingerprint },
    });
    if (!submitReservation.ok && submitReservation.kind === "error") {
      return rejectSanitized("RESERVATION_FAILED", 503);
    }
    if (!submitReservation.ok && submitReservation.kind === "duplicate") {
      const { data: prior } = await admin
        .from("order_audit")
        .select("sanitized_response, exchange_order_id, exchange_status")
        .eq("connection_id", connection_id)
        .eq("idempotency_key", idempotency_key)
        .eq("phase", "submitted")
        .maybeSingle();
      const priorFp =
        prior && typeof prior.sanitized_response === "object" && prior.sanitized_response !== null
          ? (prior.sanitized_response as Record<string, unknown>)["fingerprint"]
          : null;
      if (typeof priorFp !== "string" || priorFp !== fingerprint) {
        return rejectSanitized("IDEMPOTENCY_CONFLICT", 409);
      }
      const prev = (prior?.sanitized_response as SanitizedResponse | null) ?? submittedPending;
      return json(200, { ...prev, status: "duplicate" });
    }

    // Body shape uses the caller-visible order fields. The signer performs
    // its own strict validation, credential lookup, and pilot clamps.
    const forwardBody: Record<string, unknown> = {
      user_id,
      exchange_connection_id: connection_id,
      client_order_id: idempotency_key.slice(0, 64),
      symbol,
      side,
      order_type,
      size: Number.isFinite(size) ? size : null,
      price: price !== null && Number.isFinite(price) ? price : null,
      leverage: leverage !== null && Number.isFinite(leverage) ? leverage : null,
      reduce_only,
      environment: "mainnet",
      purpose,
      venue,
    };
    if (tp_tiers) forwardBody.tp_tiers = tp_tiers;
    if (stop_pct !== null) forwardBody.stop_pct = stop_pct;
    const forwarded = await forwardToSigner(forwardBody, { path: SIGNER_CREATE_ORDER_PATH });

    // Durable sanitized rejection record. Only allowlisted fields — never
    // credentials, signatures, headers, or raw venue bodies.
    const venueRejectRecord = (reason: string | null): Record<string, unknown> => {
      const signerFacts = (forwarded.venueReject ?? {}) as Record<string, unknown>;
      const parsed = parseRejectReason(reason, signerFacts["venue_message"]);
      return {
        observed_at: new Date().toISOString(),
        idempotency_key,
        correlation_id: idempotency_key,
        candidate_id: typeof candidate_id === "string" ? candidate_id.slice(0, 64) : null,
        evidence_hash: typeof evidence_hash === "string" ? evidence_hash.slice(0, 128) : null,
        connection_id,
        venue,
        symbol,
        side,
        order_type,
        requested_size: Number.isFinite(size) ? size : null,
        requested_price: price !== null && Number.isFinite(price) ? price : null,
        http_status: forwarded.httpStatus ?? null,
        venue_code: (signerFacts["venue_code"] as string | undefined) ?? parsed.venue_code,
        venue_category:
          (signerFacts["venue_category"] as string | undefined) ?? parsed.venue_category,
        venue_message: parsed.venue_message,
        signer_mapping:
          (signerFacts["signer_mapping"] as string | undefined) ?? parsed.signer_mapping,
        signer_outcome: forwarded.kind,
        signer_revision: forwarded.signerRevision ?? null,
      };
    };

    let sanitized: SanitizedResponse;
    if (forwarded.kind === "submitted") {
      sanitized = {
        status: "submitted",
        exchange_order_id: forwarded.orderId ?? null,
        exchange_status: forwarded.status ?? "accepted",
        reject_reason: null,
        built: forwarded.built ?? null,
      };
    } else if (forwarded.kind === "rejected") {
      const reason = forwarded.code || "SIGNER_REJECTED";
      sanitized = {
        status: "rejected",
        exchange_order_id: null,
        exchange_status: "rejected",
        reject_reason: reason,
        built: forwarded.built ?? null,
        venue_reject: venueRejectRecord(reason),
      };
    } else if (forwarded.kind === "ambiguous") {
      // Never retry. Owner reconciles via /v1/reconcile on the signer.
      const reason = forwarded.reason || "SIGNER_AMBIGUOUS";
      sanitized = {
        status: "ambiguous",
        exchange_order_id: null,
        exchange_status: "ambiguous",
        reject_reason: reason,
        venue_reject: venueRejectRecord(reason),
      };
    } else {
      const reason = forwarded.reason || "SIGNER_UNREACHABLE";
      sanitized = {
        status: "rejected",
        exchange_order_id: null,
        exchange_status: "rejected",
        reject_reason: reason,
        venue_reject: venueRejectRecord(reason),
      };
    }

    await auditBestEffort(admin, {
      user_id,
      connection_id,
      idempotency_key,
      phase: "exchange_response",
      venue,
      symbol,
      side,
      order_type,
      size,
      price,
      leverage,
      is_live,
      exchange_order_id: sanitized.exchange_order_id,
      exchange_status: sanitized.exchange_status,
      reject_reason: sanitized.reject_reason,
      sanitized_response: sanitized,
    });
    await mirrorIntent(admin, {
      ...intentBase,
      state: intentStateFor(sanitized),
      state_reason: sanitized.reject_reason,
      exchange_order_id: sanitized.exchange_order_id,
      exchange_status: sanitized.exchange_status,
    });
    return json(200, sanitized);
  }

  // ---- Credential load + decrypt (testnet-proof path only) ----
  const { data: credRow } = await admin
    .from("exchange_credentials")
    .select("encrypted_api_key, encrypted_api_secret, encrypted_passphrase")
    .eq("connection_id", connection_id)
    .maybeSingle();
  if (!credRow) return rejectAfterReservation("MISSING_CREDENTIALS");

  let aesKey: CryptoKey;
  try {
    aesKey = await deriveAesKey();
  } catch {
    return rejectAfterReservation("ENCRYPTION_KEY_ERROR", 500);
  }

  let apiKey = "";
  let apiSecret = "";
  let passphrase: string | null = null;
  let omniSeed: string | null = null;
  try {
    apiKey = await decryptField(aesKey, credRow.encrypted_api_key);
    apiSecret = await decryptField(aesKey, credRow.encrypted_api_secret);
    if (credRow.encrypted_passphrase) {
      passphrase = await decryptField(aesKey, credRow.encrypted_passphrase);
    }
  } catch {
    return rejectAfterReservation("DECRYPT_FAILED", 500);
  }

  const adapter = new ApexOmniTestnetAdapter();
  const creds: DecryptedCredentials = { apiKey, apiSecret, passphrase, omniSeed };

  // Phase: validated (best-effort — the durable reservation is `received`).
  await auditBestEffort(admin, {
    user_id,
    connection_id,
    idempotency_key,
    phase: "validated",
    venue,
    symbol,
    side,
    order_type,
    size,
    price,
    leverage,
    is_live,
  });

  try {
    const orderReq: ApexOrderRequest = {
      symbol,
      side: side as "BUY" | "SELL",
      type: order_type === "LIMIT" ? "LIMIT" : "MARKET",
      size: String(size),
      price: price !== null && Number.isFinite(price) ? String(price) : undefined,
      timeInForce: order_type === "LIMIT" ? "GOOD_TIL_CANCEL" : "IMMEDIATE_OR_CANCEL",
      reduceOnly: reduce_only,
      clientOrderId: idempotency_key.slice(0, 32),
    };

    // Fail-closed pre-submit reservation (phase = submitted).
    // Store the fingerprint alongside the pending status so a subsequent
    // duplicate request can verify parameter equivalence.
    const sanitizedPending: SanitizedResponse = {
      status: "submitted",
      exchange_order_id: null,
      exchange_status: "pending",
      reject_reason: null,
    };
    const submitReservation = await auditStrict(admin, {
      user_id,
      connection_id,
      idempotency_key,
      phase: "submitted",
      venue,
      symbol,
      side,
      order_type,
      size,
      price,
      leverage,
      is_live,
      sanitized_response: { ...sanitizedPending, fingerprint },
    });
    if (!submitReservation.ok && submitReservation.kind === "error") {
      return rejectSanitized("RESERVATION_FAILED", 503);
    }
    if (!submitReservation.ok && submitReservation.kind === "duplicate") {
      // Verify fingerprint of the prior submitted row before returning duplicate.
      const { data: priorSubmit, error: priorSubmitErr } = await admin
        .from("order_audit")
        .select("sanitized_response, exchange_order_id, exchange_status")
        .eq("connection_id", connection_id)
        .eq("idempotency_key", idempotency_key)
        .eq("phase", "submitted")
        .maybeSingle();
      if (priorSubmitErr) return rejectSanitized("RESERVATION_FAILED", 503);
      const priorFp =
        priorSubmit &&
        typeof priorSubmit.sanitized_response === "object" &&
        priorSubmit.sanitized_response !== null
          ? (priorSubmit.sanitized_response as Record<string, unknown>)["fingerprint"]
          : null;
      if (typeof priorFp !== "string" || priorFp !== fingerprint) {
        return rejectSanitized("IDEMPOTENCY_CONFLICT", 409);
      }
      const prev =
        (priorSubmit?.sanitized_response as SanitizedResponse | null) ?? sanitizedPending;
      return json(200, { ...prev, status: "duplicate" });
    }

    let res: Awaited<ReturnType<typeof adapter.placeOrder>> | null = null;
    let submitThrew = false;
    try {
      res = await adapter.placeOrder(creds, orderReq);
    } catch {
      submitThrew = true;
    }

    // Ambiguous outcome: reconcile by clientOrderId. NO retry.
    if (submitThrew || res === null) {
      let sanitized: SanitizedResponse;
      try {
        const look = await adapter.getOrderByClientId(creds, orderReq.clientOrderId!);
        if (look.ok && look.data.found) {
          sanitized = {
            status: "submitted",
            exchange_order_id: look.data.orderId ?? null,
            exchange_status: look.data.status ?? "unknown",
            reject_reason: null,
          };
        } else {
          sanitized = {
            status: "ambiguous",
            exchange_order_id: null,
            exchange_status: "ambiguous",
            reject_reason: "SUBMIT_TIMEOUT_UNRECONCILED",
          };
        }
      } catch {
        sanitized = {
          status: "ambiguous",
          exchange_order_id: null,
          exchange_status: "ambiguous",
          reject_reason: "SUBMIT_TIMEOUT_UNRECONCILED",
        };
      }
      await auditBestEffort(admin, {
        user_id,
        connection_id,
        idempotency_key,
        phase: "exchange_response",
        venue,
        symbol,
        side,
        order_type,
        size,
        price,
        leverage,
        is_live,
        exchange_order_id: sanitized.exchange_order_id,
        exchange_status: sanitized.exchange_status,
        reject_reason: sanitized.reject_reason,
        sanitized_response: sanitized,
      });
      await mirrorIntent(admin, {
        ...intentBase,
        state: intentStateFor(sanitized),
        state_reason: sanitized.reject_reason,
        exchange_order_id: sanitized.exchange_order_id,
        exchange_status: sanitized.exchange_status,
      });
      return json(200, sanitized);
    }

    const sanitized: SanitizedResponse = res.ok
      ? {
          status: "submitted",
          exchange_order_id: res.data.orderId ?? null,
          exchange_status: "accepted",
          reject_reason: null,
        }
      : {
          status: "rejected",
          exchange_order_id: null,
          exchange_status: "rejected",
          reject_reason: res.code || "EXCHANGE_REJECTED",
        };

    await auditBestEffort(admin, {
      user_id,
      connection_id,
      idempotency_key,
      phase: "exchange_response",
      venue,
      symbol,
      side,
      order_type,
      size,
      price,
      leverage,
      is_live,
      exchange_order_id: sanitized.exchange_order_id,
      exchange_status: sanitized.exchange_status,
      reject_reason: sanitized.reject_reason,
      sanitized_response: sanitized,
    });

    await mirrorIntent(admin, {
      ...intentBase,
      state: intentStateFor(sanitized),
      state_reason: sanitized.reject_reason,
      exchange_order_id: sanitized.exchange_order_id,
      exchange_status: sanitized.exchange_status,
    });
    return json(200, sanitized);
  } finally {
    apiKey = "";
    apiSecret = "";
    passphrase = null;
    omniSeed = null;
    (creds as { apiKey: string }).apiKey = "";
    (creds as { apiSecret: string }).apiSecret = "";
    (creds as { passphrase: string | null }).passphrase = null;
    (creds as { omniSeed: string | null }).omniSeed = null;
  }
});
