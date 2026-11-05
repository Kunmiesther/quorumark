// worker-ingest: narrow privileged path for the Railway TurtleBot worker.
//
// AUTH: HMAC-SHA256 over `ts\nnonce\nMETHOD\npath\nsha256hex(body)\nworker_id\nkey_version`
// keyed by WORKER_INGEST_SHARED_SECRET. Constant-time compare, 60s skew,
// nonce replay via unique PK on public.worker_ingest_nonces (fail-closed).
//
// OPS: see ALLOWED_OPS below — a fixed allowlist, nothing else.
// No client may inject a table name, SQL fragment, RPC name, filter, or
// column list. All server-side access uses the service role.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchAccountEquity, loadApexReadCreds } from "../_shared/apex-omni-read.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHARED_SECRET = Deno.env.get("WORKER_INGEST_SHARED_SECRET") ?? "";
const KEY_VERSION = Deno.env.get("WORKER_INGEST_KEY_VERSION") ?? "v1";

const MAX_BODY_BYTES = 32 * 1024;
const CLOCK_SKEW_SEC = 60;
const NONCE_TTL_SEC = 180; // 3x skew, kept small for the cleanup query

const ALLOWED_OPS = new Set([
  "HEARTBEAT_UPSERT",
  "ACTIVE_CONFIG_READ",
  "BOT_EVENT_INSERT",
  "EXECUTION_GUARD_READ",
  // Signer-only read op. Returns encrypted credential columns + exchange /
  // environment metadata for an owned, active connection. Never returns
  // plaintext, never authorizes an order, never enables signing.
  "EXCHANGE_CREDENTIALS_READ_OWNED",
  // Scout Guardian (Position Monitoring Layer). Paper-position reads + the
  // Guardian's deterministic decision/directive writes. None of these touch an
  // exchange, the signer, credentials, or the ApeX write allowlist — they read
  // and write only paper simulation state (paper_positions, onyx_decisions,
  // ops_events, scout_guardian_directives) with the service role.
  "OPEN_POSITIONS_READ",
  // Authenticated account-equity read for LIVE sizing. Reads ApeX
  // /api/v3/account-balance in-process (owner ruling #12: no signer
  // dependency for reads) for an OWNED, active connection and returns only
  // {total_equity, available_balance, currency}. Never returns credentials,
  // never places, signs, or authorizes an order.
  "ACCOUNT_EQUITY_READ",
  "GUARDIAN_DECISION_INSERT",
  "GUARDIAN_DIRECTIVE_UPSERT",
  // Live-Readiness closures. Recent guardian-class closes feed the worker's
  // re-entry lockout set; shadow ledger writes populate the /shadow surface
  // that compares paper decisions to (future) live decisions.
  "GUARDIAN_RECENT_CLOSES_READ",
  "SHADOW_LEDGER_INSERT",
  // Canonical deterministic decision ledger. UPSERT records one immutable
  // decision per completed candle (including WAIT) and always returns the
  // STORED execution state, which is what makes duplicate submission
  // impossible across worker restarts and redeploys. EXECUTION_UPDATE moves
  // that state FORWARD ONLY. Neither op signs, decrypts, reaches an
  // exchange, or touches a credential.
  "DECISION_UPSERT",
  "DECISION_EXECUTION_UPDATE",
  // Proof-of-life trigger channel. CLAIM atomically consumes ONE pending
  // owner-issued command (worker_commands, admin-only inserts via RLS).
  // COMPLETE reports the outcome back to that row. Neither op signs, decrypts,
  // or reaches an exchange — they only shuttle a directive that the worker's
  // own `submit_order_intent` then routes through the existing broker path.
  "WORKER_COMMAND_CLAIM",
  "WORKER_COMMAND_COMPLETE",
  // Signer-only DB proxy ops. The Railway signer runs outside Supabase's
  // edge runtime and cannot read SUPABASE_SERVICE_ROLE_KEY on Lovable Cloud.
  // These ops let it look up its own credential row, check the kill switch,
  // and append audit/intent rows without ever holding the service role.
  // Every input is validated as a UUID / enum here — no table name, filter,
  // or column list is accepted from the caller.
  "APEX_CREDENTIAL_FIND_ACTIVE",
  "EXECUTION_HALTED_CHECK",
  "ORDER_INTENT_INSERT",
  "ORDER_AUDIT_INSERT",
  "APEX_CREDENTIAL_AUDIT_INSERT",
]);

// Scout Guardian bounds.
const GUARDIAN_ENVELOPE_VERSION = 1;
const GUARDIAN_RULES_VERSION = 1;
const GUARDIAN_MAX_POSITIONS = 500;
const GUARDIAN_MAX_DECISIONS = 100;
const GUARDIAN_MAX_DIRECTIVES = 100;
const GUARDIAN_MAX_RECENT_CLOSES = 500;
const GUARDIAN_MAX_SHADOW_ROWS = 100;
const GUARDIAN_SIDES = new Set(["long", "short", "flat"]);
const GUARDIAN_DECISIONS = new Set(["open", "add", "close", "hold", "reject"]);
const GUARDIAN_DIRECTIVE_TYPES = new Set([
  "cancel_unfilled_rungs",
  "close_position",
  "reduce_position",
  // Live-Readiness directive types. The paper engine already promotes
  // internally, so it acknowledges these without double-applying; the live
  // broker consumes them for real once activation opens.
  "promote_runner",
  "cancel_fixed_tp",
  "set_breakeven_stop",
  "repair_stop",
]);
// Guardian-class exit reasons drive the re-entry lockout. Kept in lockstep
// with paper_trades_exit_reason_check + reentry_lockout.LOCKOUT_TRIGGER_REASONS.
const GUARDIAN_LOCKOUT_EXIT_REASONS = new Set([
  "scout_bos",
  "scout_guardian_bos",
  "scout_guardian_cluster",
]);
const SHADOW_LEDGER_SOURCES = new Set(["paper", "live"]);
// Non-credential columns the Guardian needs to reason about a position.
const GUARDIAN_POSITION_COLUMNS =
  "id, user_id, wallet_key, symbol, direction, strategy, status, entry_price, " +
  "entry_ts, entry_candle_ts_ms, leverage, margin, size_qty, size_notional, " +
  "tp_level, stop_level, zone_level, zone_lower, zone_upper, rung_count, " +
  "first_fill_vwap, fills, pending_rungs, resize_levels, ladder_total_rungs, " +
  "ladder_total_margin, configured_rung_count, filled_rung_count, " +
  "hard_stop_armed_at, structure_broken, structure_broken_level, " +
  "structure_broken_ts_ms, protective_swing_level, protective_swing_kind, " +
  "promoted, promoted_at, runner_breakeven_stop, " +
  "last_seen_candle_ts_ms, created_at";

// Bump when the guard response shape or evaluation semantics change so the
// worker can refuse a mismatched guard version fail-closed.
const GUARD_VERSION = "v1";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ALLOWED_MODES = new Set(["demo", "paper", "live"]);
const ALLOWED_STATUSES = new Set(["starting", "healthy", "degraded", "halted", "unknown"]);
const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error"]);
const ALLOWED_EVENT_CODES = new Set([
  "STARTUP",
  "SHUTDOWN",
  "MODE_TRANSITION",
  "EXECUTION_HALTED",
  "KILL_SWITCH_FAIL_CLOSED",
  "ORDER_INTENT_RESULT",
  "ORDER_INTENT_NETWORK_ERROR",
  "CONNECTIVITY_DEGRADED",
  "CONNECTIVITY_RECOVERED",
  "CONFIG_READ",
  "HEARTBEAT",
  // Observational only. Emitted by the worker's public market-data / signal
  // path, which executes nothing: no order, no signing, no position, balance
  // or margin mutation. `detail.status` is one of evaluated | skipped | error
  // and every payload asserts `execution_performed: false`.
  //
  // This is an additional PARAMETER VALUE for the existing BOT_EVENT_INSERT
  // operation. It adds no operation, table, column, RPC, or migration.
  // Must stay in lockstep with ALLOWED_EVENT_CODES in worker_ingest_client.py.
  "SIGNAL_EVALUATION",
  // Proof-of-life trade trigger outcome (see worker_commands / bot_worker
  // proof-of-life path). Must stay in lockstep with worker_ingest_client.py.
  "PROOF_OF_LIFE_ORDER",
  // Accumulator live-intent bridge outcome (dispatched OR refused before
  // dispatch — `detail.blocked` + `detail.block_code` distinguish them).
  // Must stay in lockstep with worker_ingest_client.py.
  "ACCUMULATOR_INTENT_SUBMITTED",
  // Canonical candidate identity for a naturally detected setup. Observational:
  // it records WHAT was detected, never authorizes anything. Mirrored into
  // public.strategy_candidates (service-role only write).
  // HISTORICAL: the live worker no longer emits this — it records one
  // decision per completed candle instead. The code stays allowlisted so the
  // existing rows keep a valid event vocabulary.
  // Must stay in lockstep with worker_ingest_client.py.
  "STRATEGY_CANDIDATE_CREATED",
  // Human-readable trail for one canonical decision, including WAIT. The
  // durable row is written by DECISION_UPSERT; this event is the narrative.
  // Must stay in lockstep with worker_ingest_client.py.
  "STRATEGY_DECISION",
]);


const MAX_MESSAGE_LEN = 500;
const MAX_METADATA_BYTES = 4 * 1024;

// Per-instance rate limiter — defence-in-depth. Persistent limits live in
// worker_registry.active and manual review; this catches burst floods before
// they reach Postgres.
const RATE_BUCKETS = new Map<string, { windowStart: number; count: number }>();
const RATE_LIMITS: Record<string, { perMinute: number }> = {
  HEARTBEAT_UPSERT: { perMinute: 30 },
  ACTIVE_CONFIG_READ: { perMinute: 30 },
  BOT_EVENT_INSERT: { perMinute: 240 },
  // Kill-switch checkpoints fire per-cycle AND at intent build + broker send;
  // generous but bounded. Real limit is worker cycle rate.
  EXECUTION_GUARD_READ: { perMinute: 300 },
  // Signer credential read: bounded far tighter — the signer only reads on
  // verify / read-account, not per cycle.
  EXCHANGE_CREDENTIALS_READ_OWNED: { perMinute: 120 },
  // Guardian ops fire from the 15s worker cycle: one positions read + a
  // decision batch + a directive batch per cycle. Generous but bounded.
  OPEN_POSITIONS_READ: { perMinute: 30 },
  // One equity read per live-sizing attempt; bounded well under the venue's
  // private read budget.
  ACCOUNT_EQUITY_READ: { perMinute: 60 },
  GUARDIAN_DECISION_INSERT: { perMinute: 120 },
  GUARDIAN_DIRECTIVE_UPSERT: { perMinute: 120 },
  // Recent-closes read is one read per cycle (~4/min). Shadow ledger inserts
  // one batch per cycle. Both are bounded even under aggressive cycle rates.
  GUARDIAN_RECENT_CLOSES_READ: { perMinute: 30 },
  SHADOW_LEDGER_INSERT: { perMinute: 60 },
  // One decision per completed candle per live symbol, retried by the 15s
  // cycle until it sticks: ~4 writes/min/symbol at the candle boundary plus
  // idempotent repeats. Execution updates fire at most 3x per traded
  // decision (blocked | intent_created -> terminal).
  DECISION_UPSERT: { perMinute: 120 },
  DECISION_EXECUTION_UPDATE: { perMinute: 120 },
  // Signer DB proxy ops. Credential lookup + halted check fire once per
  // /v1/orders call; audit inserts fire a few times per intent. Generous
  // but bounded — the worker cycle and canary clamps are the real limits.
  APEX_CREDENTIAL_FIND_ACTIVE: { perMinute: 60 },
  EXECUTION_HALTED_CHECK: { perMinute: 300 },
  ORDER_INTENT_INSERT: { perMinute: 60 },
  ORDER_AUDIT_INSERT: { perMinute: 180 },
  APEX_CREDENTIAL_AUDIT_INSERT: { perMinute: 60 },
};

// Redact obvious secret-looking substrings from event messages.
const SECRET_REDACT_PATTERNS: [RegExp, string][] = [
  [/sb_(publishable|secret)_[A-Za-z0-9_\-]+/gi, "[REDACTED_SB_KEY]"],
  [/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "[REDACTED_JWT]"],
  [/0x[a-fA-F0-9]{40,}/g, "[REDACTED_HEX]"],
  [/(?:api[_-]?key|secret|passphrase|private[_-]?key|seed|mnemonic)[\"':= ]+[^\s\"',]{6,}/gi, "[REDACTED_CRED]"],
];

function redact(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_REDACT_PATTERNS) out = out.replace(re, rep);
  return out;
}

function containsSecretPattern(input: string): boolean {
  return SECRET_REDACT_PATTERNS.some(([re]) => re.test(input));
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function jsonError(status: number, code: string, correlationId: string): Response {
  // Never surfaces internals. `code` is a short static string chosen by us.
  return new Response(JSON.stringify({ error: code, correlation_id: correlationId }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checkRate(workerId: string, op: string): boolean {
  const limit = RATE_LIMITS[op]?.perMinute ?? 60;
  const key = `${workerId}:${op}`;
  const now = Date.now();
  const bucket = RATE_BUCKETS.get(key);
  if (!bucket || now - bucket.windowStart > 60_000) {
    RATE_BUCKETS.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count++;
  return bucket.count <= limit;
}

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();

  if (req.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED", correlationId);
  if (!SHARED_SECRET) return jsonError(500, "SERVER_NOT_CONFIGURED", correlationId);

  const url = new URL(req.url);
  // The published path is /worker-ingest; sign the exact incoming pathname.
  const path = url.pathname;

  const workerId = req.headers.get("x-worker-id") ?? "";
  const ts = req.headers.get("x-worker-timestamp") ?? "";
  const nonce = req.headers.get("x-worker-nonce") ?? "";
  const sig = (req.headers.get("x-worker-signature") ?? "").toLowerCase();
  const keyVersion = req.headers.get("x-worker-key-version") ?? "";

  if (!workerId || !ts || !nonce || !sig || !keyVersion) {
    return jsonError(401, "MISSING_AUTH_HEADERS", correlationId);
  }
  if (keyVersion !== KEY_VERSION) return jsonError(401, "KEY_VERSION_MISMATCH", correlationId);
  if (!/^[A-Za-z0-9_.\-:]{1,64}$/.test(workerId)) return jsonError(401, "BAD_WORKER_ID", correlationId);
  if (!/^[A-Za-z0-9_\-]{16,128}$/.test(nonce)) return jsonError(401, "BAD_NONCE", correlationId);

  const tsInt = Number(ts);
  if (!Number.isFinite(tsInt)) return jsonError(401, "BAD_TIMESTAMP", correlationId);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsInt) > CLOCK_SKEW_SEC) return jsonError(401, "TIMESTAMP_SKEW", correlationId);

  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return jsonError(413, "BODY_TOO_LARGE", correlationId);

  const bodyHash = await sha256Hex(bodyBytes);
  const canonical = `${ts}\n${nonce}\n${req.method}\n${path}\n${bodyHash}\n${workerId}\n${keyVersion}`;
  const expected = await hmacHex(SHARED_SECRET, canonical);
  if (!constantTimeEq(expected, sig)) return jsonError(401, "INVALID_SIGNATURE", correlationId);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify worker is registered + active.
  const { data: reg, error: regErr } = await admin
    .from("worker_registry")
    .select("worker_id, environment, key_version, active")
    .eq("worker_id", workerId)
    .maybeSingle();
  if (regErr) return jsonError(500, "REGISTRY_LOOKUP_FAILED", correlationId);
  if (!reg || !reg.active) return jsonError(403, "WORKER_NOT_REGISTERED", correlationId);
  if (reg.key_version !== keyVersion) return jsonError(401, "KEY_VERSION_MISMATCH", correlationId);

  // Nonce replay guard. Insert-first, unique-violation-on-replay. Fail closed.
  const nonceExpires = new Date((tsInt + NONCE_TTL_SEC) * 1000).toISOString();
  const { error: nonceErr } = await admin
    .from("worker_ingest_nonces")
    .insert({ nonce, worker_id: workerId, expires_at: nonceExpires });
  if (nonceErr) {
    const code = (nonceErr as { code?: string }).code;
    if (code === "23505") return jsonError(401, "REPLAYED_NONCE", correlationId);
    return jsonError(503, "NONCE_STORE_UNAVAILABLE", correlationId);
  }
  // Best-effort purge of expired nonces (bounded work).
  admin.from("worker_ingest_nonces").delete().lt("expires_at", new Date().toISOString())
    .then(() => {}, () => {});

  // Parse body.
  let payload: Record<string, unknown>;
  try {
    payload = bodyBytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return jsonError(400, "BAD_JSON", correlationId);
  }
  const op = String(payload.operation ?? "");
  if (!ALLOWED_OPS.has(op)) return jsonError(400, "UNKNOWN_OPERATION", correlationId);
  if (!checkRate(workerId, op)) return jsonError(429, "RATE_LIMITED", correlationId);

  try {
    if (op === "HEARTBEAT_UPSERT") return await handleHeartbeat(admin, workerId, reg.environment, payload, correlationId);
    if (op === "ACTIVE_CONFIG_READ") return await handleConfigRead(admin, workerId, reg.environment, correlationId);
    if (op === "BOT_EVENT_INSERT") return await handleEventInsert(admin, workerId, payload, correlationId);
    if (op === "EXECUTION_GUARD_READ") return await handleExecutionGuardRead(admin, workerId, reg.environment, payload, correlationId);
    if (op === "EXCHANGE_CREDENTIALS_READ_OWNED") return await handleExchangeCredentialsReadOwned(admin, workerId, payload, correlationId);
    if (op === "OPEN_POSITIONS_READ") return await handleOpenPositionsRead(admin, workerId, correlationId);
    if (op === "ACCOUNT_EQUITY_READ") return await handleAccountEquityRead(admin, payload, correlationId);
    if (op === "GUARDIAN_DECISION_INSERT") return await handleGuardianDecisionInsert(admin, payload, correlationId);
    if (op === "GUARDIAN_DIRECTIVE_UPSERT") return await handleGuardianDirectiveUpsert(admin, payload, correlationId);
    if (op === "GUARDIAN_RECENT_CLOSES_READ") return await handleGuardianRecentClosesRead(admin, workerId, payload, correlationId);
    if (op === "SHADOW_LEDGER_INSERT") return await handleShadowLedgerInsert(admin, payload, correlationId);
    if (op === "DECISION_UPSERT") return await handleDecisionUpsert(admin, payload, correlationId);
    if (op === "DECISION_EXECUTION_UPDATE") return await handleDecisionExecutionUpdate(admin, payload, correlationId);
    if (op === "WORKER_COMMAND_CLAIM") return await handleWorkerCommandClaim(admin, workerId, payload, correlationId);
    if (op === "WORKER_COMMAND_COMPLETE") return await handleWorkerCommandComplete(admin, payload, correlationId);
    if (op === "APEX_CREDENTIAL_FIND_ACTIVE") return await handleApexCredentialFindActive(admin, payload, correlationId);
    if (op === "EXECUTION_HALTED_CHECK") return await handleExecutionHaltedCheck(admin, payload, correlationId);
    if (op === "ORDER_INTENT_INSERT") return await handleOrderIntentInsert(admin, payload, correlationId);
    if (op === "ORDER_AUDIT_INSERT") return await handleOrderAuditInsert(admin, payload, correlationId);
    if (op === "APEX_CREDENTIAL_AUDIT_INSERT") return await handleApexCredentialAuditInsert(admin, payload, correlationId);
  } catch (_e) {
    return jsonError(500, "INTERNAL_ERROR", correlationId);
  }
  return jsonError(400, "UNKNOWN_OPERATION", correlationId);
});

async function handleHeartbeat(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  environment: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const status = String(payload.status ?? "unknown");
  const mode = String(payload.mode ?? "demo");
  const version = payload.version ? String(payload.version).slice(0, 64) : null;
  const health = (payload.health && typeof payload.health === "object") ? payload.health : {};
  if (!ALLOWED_STATUSES.has(status)) return jsonError(400, "BAD_STATUS", correlationId);
  if (!ALLOWED_MODES.has(mode)) return jsonError(400, "BAD_MODE", correlationId);
  if (JSON.stringify(health).length > MAX_METADATA_BYTES) return jsonError(413, "HEALTH_TOO_LARGE", correlationId);
  // The worker's LIVE_TRADING_ENABLED flag (owner-controlled on Railway) is
  // the source of truth for mode. Persist exactly what the worker reports —
  // dashboards must reflect the real posture. Mainnet execution is still
  // independently gated by APEX_MAINNET_* flags at the broker/signer.
  const { error } = await admin.from("worker_heartbeats").upsert({
    worker_id: workerId,
    environment,
    status,
    mode,
    version,
    health,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "worker_id" });
  if (error) return jsonError(500, "HEARTBEAT_WRITE_FAILED", correlationId);
  return new Response(JSON.stringify({ ok: true, correlation_id: correlationId }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function handleConfigRead(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  environment: string,
  correlationId: string,
): Promise<Response> {
  // active_bot_config view already excludes credentials/keys. We further
  // restrict to the worker's environment and project only whitelisted columns.
  const { data, error } = await admin
    .from("active_bot_config")
    .select(
      "user_id, connection_id, exchange_type, symbol, market_type, cross_margin, mode, enabled, params, environment, status, permission_trade, permissions_verified",
    )
    .eq("environment", environment);
  if (error) return jsonError(500, "CONFIG_READ_FAILED", correlationId);
  // Live scoping. `active_bot_config` now pairs a strategy only with the
  // connection it was configured against, but a configured connection can
  // still be disconnected, unverified, or missing trade permission. A live
  // row in any of those states must never reach the worker: it would spend
  // a whole cycle sizing an order it can never place, and every refusal
  // would look like a strategy failure instead of a connection problem.
  // Paper rows are unaffected — they place nothing at a venue.
  const scoped = (data ?? []).filter((r) => {
    if (r.mode === "paper") return true;
    return r.status === "verified" &&
      r.permissions_verified === true &&
      r.permission_trade === true;
  });
  const rows = scoped.map((r) => ({
    user_id: r.user_id,
    connection_id: r.connection_id,
    exchange_type: r.exchange_type,
    symbol: r.symbol,
    market_type: r.market_type,
    cross_margin: r.cross_margin,
    mode: r.mode,
    enabled: r.enabled,
    params: sanitizeParams(r.params),
    environment: r.environment,
    status: r.status,
  }));
  return new Response(JSON.stringify({ ok: true, worker_id: workerId, configs: rows, correlation_id: correlationId }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function sanitizeParams(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== "object") return {};
  const banned = /secret|key|password|passphrase|token|seed|mnemonic|private/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (banned.test(k)) continue;
    if (typeof v === "string" && v.length > 2000) continue;
    out[k] = v;
  }
  return out;
}

async function handleEventInsert(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const code = String(payload.event ?? payload.code ?? "");
  const level = String(payload.level ?? "info");
  let message = String(payload.message ?? "").slice(0, MAX_MESSAGE_LEN);
  const userId = payload.user_id ? String(payload.user_id) : null;
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : {};
  if (!ALLOWED_EVENT_CODES.has(code)) return jsonError(400, "EVENT_CODE_NOT_ALLOWED", correlationId);
  if (!ALLOWED_LEVELS.has(level)) return jsonError(400, "BAD_LEVEL", correlationId);
  const detailJson = JSON.stringify(detail);
  if (detailJson.length > MAX_METADATA_BYTES) return jsonError(413, "DETAIL_TOO_LARGE", correlationId);
  if (containsSecretPattern(message) || containsSecretPattern(detailJson)) {
    // Reject outright — worker should not be sending this. Also redact just in case a
    // downstream logger echoes.
    return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);
  }
  message = redact(message);

  const enrichedDetail = { ...detail, worker_id: workerId, source: "worker-ingest" };
  const { error } = await admin.from("bot_events").insert({
    user_id: userId,
    level,
    event: code,
    detail: enrichedDetail,
  });
  if (error) return jsonError(500, "EVENT_INSERT_FAILED", correlationId);

  // Candidate registry mirror. Idempotent on candidate_id: a replayed worker
  // cycle re-sends the identical contract and must not create a second row or
  // rewrite the original. Failure here never fails the event insert.
  if (code === "STRATEGY_CANDIDATE_CREATED" && userId) {
    const d = detail as Record<string, unknown>;
    const candidateId = typeof d.candidate_id === "string" ? d.candidate_id : "";
    const evidenceHash = typeof d.evidence_hash === "string" ? d.evidence_hash : "";
    const direction = d.direction === "long" || d.direction === "short" ? d.direction : null;
    const closeMs = Number(d.candle_close_ms);
    if (candidateId && evidenceHash && direction && Number.isFinite(closeMs)) {
      const mdMs = Number(d.market_data_ts_ms);
      await admin.from("strategy_candidates").upsert({
        candidate_id: candidateId,
        user_id: userId,
        connection_id: typeof d.connection_id === "string" ? d.connection_id : null,
        strategy: String(d.strategy ?? "unknown").slice(0, 64),
        symbol: String(d.symbol ?? "").slice(0, 32),
        timeframe: String(d.timeframe ?? "").slice(0, 16),
        direction,
        candle_close_at: new Date(closeMs).toISOString(),
        market_data_at: Number.isFinite(mdMs) ? new Date(mdMs).toISOString() : null,
        freshness_ms: Number.isFinite(mdMs) ? Math.max(0, Math.trunc(mdMs - closeMs)) : null,
        entry_zone: d.entry_zone ?? null,
        invalidation: typeof d.invalidation === "number" ? d.invalidation : null,
        tp_ladder: Array.isArray(d.tp_ladder) ? d.tp_ladder : [],
        evidence: d.evidence && typeof d.evidence === "object" ? d.evidence : {},
        evidence_hash: evidenceHash,
        schema_version: String(d.schema_version ?? "candidate.v1").slice(0, 32),
        technical_decision:
          d.technical_decision === "technical_rejected"
            ? "technical_rejected"
            : "technical_validated",
        idempotency_key:
          typeof d.idempotency_key === "string" ? d.idempotency_key.slice(0, 256) : null,
      }, { onConflict: "candidate_id", ignoreDuplicates: true });
    }
  }

  return new Response(JSON.stringify({ ok: true, correlation_id: correlationId }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// EXECUTION_GUARD_READ — signed, server-authorized kill-switch read.
//
// Effective halt rule (a global halt ALWAYS wins over a scoped non-halt):
//   effective_halt =
//     global_halt
//     OR user_halt (scope='user' AND user_id=p_user_id)
//     OR user_connection_halt (scope='connection' AND user_id=p_user_id AND connection_id=p_connection_id)
//     OR ownership_mismatch (p_connection_id not owned by p_user_id)
//
// Deterministic scope precedence for the returned `scope` / `reason_code`:
//   global > user > user_connection > none
//
// Scope naming mapping (spec vs. DB):
//   spec 'user_connection' == DB kill_switches.scope='connection'
//   (the DB CHECK constraint forbids a "connection-only-without-user" row,
//    so the plain 'connection' scope in the spec is not representable and
//    is intentionally not emitted).
//
// The identity used for evaluation comes from the AUTHENTICATED worker
// context (worker_registry row + environment). The `worker_id` from the
// request payload is IGNORED (only the HMAC-authenticated header value is
// trusted); user_id / connection_id are validated as UUIDs and passed as
// authorization inputs to the DB.
//
// Response shape:
//   { ok, halted, scope, reason_code, guard_version, evaluated_at,
//     environment, worker_id, correlation_id }
// It NEVER echoes user_id or connection_id back to the caller.
async function handleAccountEquityRead(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  const connection_id = typeof payload.connection_id === "string" ? payload.connection_id : "";
  if (!UUID_RE.test(user_id) || !UUID_RE.test(connection_id)) {
    return jsonError(400, "BAD_EQUITY_INPUT", correlationId);
  }
  // Ownership + liveness. A caller may only read equity for a connection the
  // named user owns.
  const { data: conn, error: connErr } = await admin
    .from("exchange_connections")
    .select("id, environment, exchange, status")
    .eq("id", connection_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (connErr) return jsonError(503, "EQUITY_LOOKUP_FAILED", correlationId);
  if (!conn) return jsonError(403, "OWNERSHIP_MISMATCH", correlationId);

  const loaded = await loadApexReadCreds(
    admin as unknown as Parameters<typeof loadApexReadCreds>[0],
    connection_id,
    String((conn as { environment?: string | null }).environment ?? "mainnet"),
  );
  if (!loaded.ok) return jsonError(502, `CREDENTIALS_UNAVAILABLE:${loaded.reason}`, correlationId);

  const res = await fetchAccountEquity(loaded.creds);
  if (!res.ok) return jsonError(502, `EQUITY_READ_FAILED:${res.reason}`, correlationId);

  return new Response(
    JSON.stringify({
      ok: true,
      connection_id,
      environment: String((conn as { environment?: string | null }).environment ?? "mainnet"),
      total_equity: res.equity.total_equity,
      available_balance: res.equity.available_balance,
      currency: res.equity.currency,
      correlation_id: correlationId,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleExecutionGuardRead(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  environment: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  const connection_id = typeof payload.connection_id === "string" ? payload.connection_id : "";
  if (!UUID_RE.test(user_id) || !UUID_RE.test(connection_id)) {
    return jsonError(400, "BAD_GUARD_INPUT", correlationId);
  }

  // Fail-closed default.
  let halted = true;
  let scope: "global" | "user" | "user_connection" | "none" = "none";
  let reason_code: string = "NO_GUARD_RECORD";

  try {
    // 1. Ownership check — a compromised or buggy caller must not be able to
    //    ask about a (user, connection) pair the user does not own.
    const { data: conn, error: connErr } = await admin
      .from("exchange_connections")
      .select("id")
      .eq("id", connection_id)
      .eq("user_id", user_id)
      .maybeSingle();
    if (connErr) {
      // DB failure → fail closed.
      halted = true; scope = "none"; reason_code = "NO_GUARD_RECORD";
    } else if (!conn) {
      halted = true; scope = "none"; reason_code = "OWNERSHIP_MISMATCH";
    } else {
      // 2. Load every active kill_switch row that could apply to this pair.
      //    Filtered server-side; no client-controlled predicates.
      const { data: rows, error: ksErr } = await admin
        .from("kill_switches")
        .select("scope, user_id, connection_id")
        .eq("active", true);
      if (ksErr) {
        halted = true; scope = "none"; reason_code = "NO_GUARD_RECORD";
      } else {
        let hasGlobal = false;
        let hasUser = false;
        let hasUserConn = false;
        for (const r of (rows ?? []) as Array<
          { scope?: string; user_id?: string | null; connection_id?: string | null }
        >) {
          const s = String(r.scope ?? "");
          if (s === "global") hasGlobal = true;
          else if (s === "user" && r.user_id === user_id) hasUser = true;
          else if (
            s === "connection" && r.user_id === user_id && r.connection_id === connection_id
          ) hasUserConn = true;
        }
        // Deterministic precedence: global > user > user_connection > none.
        if (hasGlobal)         { halted = true;  scope = "global";          reason_code = "GLOBAL_HALT"; }
        else if (hasUser)      { halted = true;  scope = "user";            reason_code = "USER_HALT"; }
        else if (hasUserConn)  { halted = true;  scope = "user_connection"; reason_code = "CONNECTION_HALT"; }
        else                   { halted = false; scope = "none";            reason_code = ""; }
      }
    }
  } catch {
    halted = true; scope = "none"; reason_code = "NO_GUARD_RECORD";
  }

  const body = {
    ok: true,
    halted,
    scope: halted ? scope : "none",
    reason_code: halted ? reason_code : null,
    guard_version: GUARD_VERSION,
    evaluated_at: new Date().toISOString(),
    environment,
    worker_id: workerId,
    correlation_id: correlationId,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}


// ---------------------------------------------------------------------------
// EXCHANGE_CREDENTIALS_READ_OWNED — signer-only read.
//
// Returns encrypted credential columns + minimal exchange/environment
// metadata for a (user_id, connection_id) pair the user owns and whose
// connection is not disconnected/disabled. NEVER returns plaintext, NEVER
// touches STARK/zk material, NEVER authorizes an order. The signer decrypts
// locally with TURTLE_CREDENTIAL_ENCRYPTION_KEY; this endpoint has no
// awareness of the key.
//
// Inputs (validated as UUIDs, no other predicates accepted from the caller):
//   { operation, user_id, connection_id }
//
// Response:
//   { ok, credential: { encrypted_api_key, encrypted_api_secret,
//     encrypted_passphrase, encrypted_omni_seed, encryption_version, exchange, environment,
//     connection_status }, correlation_id }
async function handleExchangeCredentialsReadOwned(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  const connection_id = typeof payload.connection_id === "string" ? payload.connection_id : "";
  if (!UUID_RE.test(user_id) || !UUID_RE.test(connection_id)) {
    return jsonError(400, "BAD_CREDENTIAL_READ_INPUT", correlationId);
  }

  // 1) Ownership + status filter on the connection. Both predicates in the
  //    query — never a caller-side `if`.
  const { data: conn, error: connErr } = await admin
    .from("exchange_connections")
    .select("id, user_id, exchange, environment, status")
    .eq("id", connection_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (connErr) return jsonError(500, "CONNECTION_LOOKUP_FAILED", correlationId);
  if (!conn) return jsonError(404, "CONNECTION_NOT_FOUND", correlationId);
  if (conn.status === "disconnected" || conn.status === "disabled") {
    return jsonError(404, "CONNECTION_NOT_FOUND", correlationId);
  }

  // 2) Encrypted credential columns only. Never any plaintext column.
  const { data: cred, error: credErr } = await admin
    .from("exchange_credentials")
    .select(
      "encrypted_api_key, encrypted_api_secret, encrypted_passphrase, encrypted_omni_seed, encryption_version",
    )
    .eq("connection_id", connection_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (credErr) return jsonError(500, "CREDENTIAL_LOOKUP_FAILED", correlationId);
  if (!cred) return jsonError(404, "CONNECTION_NOT_FOUND", correlationId);

  // Defence-in-depth: refuse if the row somehow carries a suspicious key.
  for (const k of Object.keys(cred)) {
    if (!/^encrypted_|^encryption_version$/.test(k)) {
      return jsonError(500, "CREDENTIAL_SHAPE_UNEXPECTED", correlationId);
    }
  }

  const body = {
    ok: true,
    credential: {
      encrypted_api_key: cred.encrypted_api_key,
      encrypted_api_secret: cred.encrypted_api_secret,
      encrypted_passphrase: cred.encrypted_passphrase ?? null,
      encrypted_omni_seed: cred.encrypted_omni_seed ?? null,
      encryption_version: cred.encryption_version,
      exchange: conn.exchange,
      environment: conn.environment,
      connection_status: conn.status,
    },
    worker_id: workerId,
    correlation_id: correlationId,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// SCOUT GUARDIAN — Position Monitoring Layer.
//
// The Railway worker is the always-on Position Guardian. These ops let it read
// every open paper position and record its deterministic decisions/directives.
// They read/write ONLY paper simulation state with the service role. They never
// touch the signer, exchange credentials, order intents, the ApeX write
// allowlist, or any live-venue path — the sealed-envelope architecture is
// unchanged and the worker still holds no order-submission authority.
// ---------------------------------------------------------------------------

// OPEN_POSITIONS_READ — return every open paper position (non-credential
// columns only), so the Guardian can supervise positions regardless of which
// strategy or user opened them. Bounded row count. No client-supplied predicate.
async function handleOpenPositionsRead(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  correlationId: string,
): Promise<Response> {
  const { data, error } = await admin
    .from("paper_positions")
    .select(GUARDIAN_POSITION_COLUMNS)
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(GUARDIAN_MAX_POSITIONS);
  if (error) return jsonError(500, "POSITIONS_READ_FAILED", correlationId);
  return new Response(
    JSON.stringify({ ok: true, worker_id: workerId, positions: data ?? [], correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// GUARDIAN_DECISION_INSERT — persist a batch of Guardian decisions (including
// "hold, no action") to the existing onyx_decisions ledger, and mirror a
// coarse watchdog row into ops_events for the correlation spine. Every field is
// validated; server sets strategy + envelope/rules versions.
async function handleGuardianDecisionInsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const items = Array.isArray(payload.decisions) ? payload.decisions : [];
  if (items.length === 0) return jsonError(400, "NO_DECISIONS", correlationId);
  if (items.length > GUARDIAN_MAX_DECISIONS) return jsonError(413, "TOO_MANY_DECISIONS", correlationId);

  const decisionRows: Record<string, unknown>[] = [];
  const opsRows: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return jsonError(400, "BAD_DECISION", correlationId);
    const d = raw as Record<string, unknown>;
    const userId = typeof d.user_id === "string" ? d.user_id : "";
    const correlation = typeof d.correlation_id === "string" ? d.correlation_id : "";
    const symbol = typeof d.symbol === "string" ? d.symbol.slice(0, 32) : "";
    const side = String(d.side ?? "");
    const decision = String(d.decision ?? "");
    if (!UUID_RE.test(userId)) return jsonError(400, "BAD_DECISION_USER", correlationId);
    if (!UUID_RE.test(correlation)) return jsonError(400, "BAD_DECISION_CORRELATION", correlationId);
    if (!symbol) return jsonError(400, "BAD_DECISION_SYMBOL", correlationId);
    if (!GUARDIAN_SIDES.has(side)) return jsonError(400, "BAD_DECISION_SIDE", correlationId);
    if (!GUARDIAN_DECISIONS.has(decision)) return jsonError(400, "BAD_DECISION_VERDICT", correlationId);

    const detail = (d.detail && typeof d.detail === "object") ? d.detail : {};
    const detailJson = JSON.stringify(detail);
    if (detailJson.length > MAX_METADATA_BYTES) return jsonError(413, "DECISION_DETAIL_TOO_LARGE", correlationId);
    if (containsSecretPattern(detailJson)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);

    const supporting = Array.isArray(d.supporting_codes)
      ? d.supporting_codes.filter((x) => typeof x === "string").slice(0, 32)
      : [];
    const conflicting = Array.isArray(d.conflicting_codes)
      ? d.conflicting_codes.filter((x) => typeof x === "string").slice(0, 32)
      : [];
    const riskCheck = (d.risk_check && typeof d.risk_check === "object") ? d.risk_check : {};

    decisionRows.push({
      user_id: userId,
      correlation_id: correlation,
      symbol,
      side,
      decision,
      reject_reason: typeof d.reject_reason === "string" ? d.reject_reason.slice(0, 64) : null,
      strategy: "scout_guardian",
      wallet_id: typeof d.wallet_id === "string" && UUID_RE.test(d.wallet_id) ? d.wallet_id : null,
      confidence: typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : null,
      envelope_version: GUARDIAN_ENVELOPE_VERSION,
      rules_version: GUARDIAN_RULES_VERSION,
      supporting_codes: supporting,
      conflicting_codes: conflicting,
      risk_check: riskCheck,
      detail,
    });
    opsRows.push({
      user_id: userId,
      correlation_id: correlation,
      stage: "watchdog",
      component: "scout_guardian",
      severity: decision === "reject" ? "warn" : "info",
      message: `guardian ${decision} ${symbol} ${side}`.slice(0, MAX_MESSAGE_LEN),
      detail,
    });
  }

  const { error: decErr } = await admin.from("onyx_decisions").insert(decisionRows);
  if (decErr) return jsonError(500, "DECISION_INSERT_FAILED", correlationId);
  // ops_events is the correlation spine; a failure here is not fatal to the
  // decision ledger write above.
  await admin.from("ops_events").insert(opsRows).then(() => {}, () => {});

  return new Response(
    JSON.stringify({ ok: true, inserted: decisionRows.length, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// GUARDIAN_DIRECTIVE_UPSERT — enqueue action directives the paper engine will
// enforce on its next tick. Idempotent: the partial unique index
// (position_id, directive_type) WHERE status='pending' collapses re-emission of
// the same directive on successive worker cycles. A 23505 is a no-op success.
async function handleGuardianDirectiveUpsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const items = Array.isArray(payload.directives) ? payload.directives : [];
  if (items.length === 0) return jsonError(400, "NO_DIRECTIVES", correlationId);
  if (items.length > GUARDIAN_MAX_DIRECTIVES) return jsonError(413, "TOO_MANY_DIRECTIVES", correlationId);

  let inserted = 0;
  let deduped = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return jsonError(400, "BAD_DIRECTIVE", correlationId);
    const d = raw as Record<string, unknown>;
    const userId = typeof d.user_id === "string" ? d.user_id : "";
    const positionId = typeof d.position_id === "string" ? d.position_id : "";
    const symbol = typeof d.symbol === "string" ? d.symbol.slice(0, 32) : "";
    const directiveType = String(d.directive_type ?? "");
    const reasonCode = typeof d.reason_code === "string" ? d.reason_code.slice(0, 64) : "";
    if (!UUID_RE.test(userId)) return jsonError(400, "BAD_DIRECTIVE_USER", correlationId);
    if (!UUID_RE.test(positionId)) return jsonError(400, "BAD_DIRECTIVE_POSITION", correlationId);
    if (!symbol) return jsonError(400, "BAD_DIRECTIVE_SYMBOL", correlationId);
    if (!GUARDIAN_DIRECTIVE_TYPES.has(directiveType)) return jsonError(400, "BAD_DIRECTIVE_TYPE", correlationId);
    if (!reasonCode) return jsonError(400, "BAD_DIRECTIVE_REASON", correlationId);

    const evidence = (d.evidence && typeof d.evidence === "object") ? d.evidence : {};
    const evidenceJson = JSON.stringify(evidence);
    if (evidenceJson.length > MAX_METADATA_BYTES) return jsonError(413, "DIRECTIVE_EVIDENCE_TOO_LARGE", correlationId);
    if (containsSecretPattern(evidenceJson)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);

    const correlation = typeof d.correlation_id === "string" && UUID_RE.test(d.correlation_id)
      ? d.correlation_id
      : null;
    const cycleTs = typeof d.guardian_cycle_ts_ms === "number" && Number.isFinite(d.guardian_cycle_ts_ms)
      ? Math.trunc(d.guardian_cycle_ts_ms)
      : null;

    const { error } = await admin.from("scout_guardian_directives").insert({
      user_id: userId,
      position_id: positionId,
      wallet_key: typeof d.wallet_key === "string" ? d.wallet_key.slice(0, 64) : null,
      symbol,
      directive_type: directiveType,
      reason_code: reasonCode,
      evidence,
      correlation_id: correlation,
      guardian_cycle_ts_ms: cycleTs,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") { deduped++; continue; }
      return jsonError(500, "DIRECTIVE_INSERT_FAILED", correlationId);
    }
    inserted++;
  }

  return new Response(
    JSON.stringify({ ok: true, inserted, deduped, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GUARDIAN_RECENT_CLOSES_READ — return recent guardian-class closes so the
// worker can build its per-cycle re-entry lockout set. Pure read; server
// applies the window (default ~2× REENTRY_LOCKOUT_CANDLES * 5m in ms).
// Response shape: { closes: [{ symbol, direction, exit_reason, closed_at_ms }] }
// ---------------------------------------------------------------------------
async function handleGuardianRecentClosesRead(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  // Client may pass window_ms as a hint; server clamps to [1 min, 6 h].
  const raw = typeof payload.window_ms === "number" && Number.isFinite(payload.window_ms)
    ? Math.trunc(payload.window_ms) : 0;
  const DEFAULT_MS = 12 * 5 * 60_000 * 2; // 12 candles × 5m × 2 safety margin
  const windowMs = raw > 0
    ? Math.max(60_000, Math.min(6 * 60 * 60_000, raw))
    : DEFAULT_MS;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();

  const { data, error } = await admin
    .from("paper_trades")
    .select("symbol, direction, exit_reason, closed_at")
    .in("exit_reason", Array.from(GUARDIAN_LOCKOUT_EXIT_REASONS))
    .gte("closed_at", sinceIso)
    .order("closed_at", { ascending: false })
    .limit(GUARDIAN_MAX_RECENT_CLOSES);
  if (error) return jsonError(500, "RECENT_CLOSES_READ_FAILED", correlationId);

  const closes = (data ?? []).map((r) => ({
    symbol: r.symbol,
    direction: r.direction,
    exit_reason: r.exit_reason,
    closed_at_ms: r.closed_at ? Date.parse(r.closed_at as string) : null,
  })).filter((r) => r.closed_at_ms !== null && Number.isFinite(r.closed_at_ms));

  return new Response(
    JSON.stringify({ ok: true, worker_id: workerId, closes, window_ms: windowMs, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// DECISION_UPSERT — record ONE canonical deterministic decision.
//
// IDEMPOTENT BY CONSTRUCTION. `decision_id` is the primary key and is a pure
// function of (connection_id, symbol, candle_close_at), which is also a
// unique index. Concurrent retries therefore collapse onto one row: the
// first write wins and stays immutable, and every later caller receives that
// stored row back.
//
// The response ALWAYS carries the STORED `execution_state`. That is the
// durable duplicate-submission guard — a worker that restarts mid-candle
// learns from the server that the decision was already acted on, which an
// in-memory set could never tell it.
//
// This op signs nothing, decrypts nothing, reads no credential and reaches no
// exchange. It writes exactly one table.
// ---------------------------------------------------------------------------
const DECISION_DIRECTIONS = new Set(["long", "short", "wait"]);
const DECISION_ID_RE = /^dec_v1_[0-9a-f]{32}$/;

// Monotonic execution ranks. A transition to a rank at or below the stored
// one is IGNORED, so a late retry can never downgrade a recorded ApeX result.
const EXECUTION_RANK: Record<string, number> = {
  not_reached: 0,
  blocked: 10,
  intent_created: 20,
  submitted: 30,
  ambiguous: 35,
  rejected: 40,
  filled: 50,
};

async function handleDecisionUpsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const d = (payload.decision && typeof payload.decision === "object")
    ? payload.decision as Record<string, unknown>
    : null;
  if (!d) return jsonError(400, "BAD_DECISION", correlationId);

  const decisionId = typeof d.decision_id === "string" ? d.decision_id : "";
  const userId = typeof d.user_id === "string" ? d.user_id : "";
  const connectionId = typeof d.connection_id === "string" ? d.connection_id : "";
  const symbol = typeof d.symbol === "string" ? d.symbol.slice(0, 32) : "";
  const direction = String(d.direction ?? "");
  const reasonCode = typeof d.reason_code === "string" ? d.reason_code.slice(0, 48) : "";
  const candleCloseAt = typeof d.candle_close_at === "string" ? d.candle_close_at : "";
  const evidenceHash = typeof d.evidence_hash === "string" ? d.evidence_hash.slice(0, 128) : "";

  if (!DECISION_ID_RE.test(decisionId)) return jsonError(400, "BAD_DECISION_ID", correlationId);
  if (!UUID_RE.test(userId)) return jsonError(400, "BAD_DECISION_USER", correlationId);
  if (!UUID_RE.test(connectionId)) return jsonError(400, "BAD_DECISION_CONNECTION", correlationId);
  if (!symbol) return jsonError(400, "BAD_DECISION_SYMBOL", correlationId);
  if (!DECISION_DIRECTIONS.has(direction)) return jsonError(400, "BAD_DECISION_DIRECTION", correlationId);
  if (!reasonCode) return jsonError(400, "BAD_DECISION_REASON", correlationId);
  if (!candleCloseAt || Number.isNaN(Date.parse(candleCloseAt))) {
    return jsonError(400, "BAD_DECISION_CANDLE", correlationId);
  }
  if (!evidenceHash) return jsonError(400, "BAD_DECISION_EVIDENCE", correlationId);

  const takeProfits = Array.isArray(d.take_profits)
    ? d.take_profits.filter((x) => typeof x === "number" && Number.isFinite(x)).slice(0, 12)
    : [];
  const entryZone =
    d.entry_zone && typeof d.entry_zone === "object" &&
    typeof (d.entry_zone as Record<string, unknown>).low === "number" &&
    typeof (d.entry_zone as Record<string, unknown>).high === "number"
      ? d.entry_zone
      : null;

  const row = {
    decision_id: decisionId,
    user_id: userId,
    connection_id: connectionId,
    symbol,
    strategy: String(d.strategy ?? "unknown").slice(0, 32),
    armed_leg: typeof d.armed_leg === "string" ? d.armed_leg.slice(0, 32) : null,
    timeframe: "5m",
    candle_close_at: new Date(candleCloseAt).toISOString(),
    direction,
    reason_code: reasonCode,
    reason: typeof d.reason === "string" ? d.reason.slice(0, 200) : "",
    entry_zone: entryZone,
    invalidation: typeof d.invalidation === "number" ? d.invalidation : null,
    take_profits: takeProfits,
    evidence: d.evidence && typeof d.evidence === "object" ? d.evidence : {},
    evidence_hash: evidenceHash,
    schema_version: String(d.schema_version ?? "decision.v1").slice(0, 32),
    created_at: typeof d.created_at === "string" ? d.created_at : new Date().toISOString(),
  };

  // ignoreDuplicates: the FIRST decision for a candle is the decision. A
  // replay must never rewrite direction, reason, or geometry.
  const { error: upsertErr } = await admin
    .from("strategy_decisions")
    .upsert(row, { onConflict: "decision_id", ignoreDuplicates: true });
  if (upsertErr) return jsonError(500, "DECISION_UPSERT_FAILED", correlationId);

  // Always read back: the caller needs the STORED state, which after a
  // duplicate is the prior row's, not the one just offered.
  const { data: stored, error: readErr } = await admin
    .from("strategy_decisions")
    .select("decision_id, execution_state, direction, reason_code")
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (readErr || !stored) return jsonError(500, "DECISION_READBACK_FAILED", correlationId);

  return new Response(
    JSON.stringify({
      ok: true,
      decision_id: stored.decision_id,
      execution_state: stored.execution_state ?? "not_reached",
      stored_direction: stored.direction,
      stored_reason_code: stored.reason_code,
      correlation_id: correlationId,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// DECISION_EXECUTION_UPDATE — move ONE decision's execution record FORWARD.
//
// The decision itself is immutable and no column of it is writable here. Only
// the execution columns move, and only to a strictly higher rank, so an
// out-of-order retry cannot turn a recorded rejection back into "in flight".
// ---------------------------------------------------------------------------
async function handleDecisionExecutionUpdate(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const decisionId = typeof payload.decision_id === "string" ? payload.decision_id : "";
  const state = String(payload.execution_state ?? "");
  if (!DECISION_ID_RE.test(decisionId)) return jsonError(400, "BAD_DECISION_ID", correlationId);
  if (!(state in EXECUTION_RANK)) return jsonError(400, "BAD_EXECUTION_STATE", correlationId);

  const { data: current, error: readErr } = await admin
    .from("strategy_decisions")
    .select("execution_state")
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (readErr || !current) return jsonError(404, "DECISION_NOT_FOUND", correlationId);

  const currentRank = EXECUTION_RANK[String(current.execution_state ?? "not_reached")] ?? 0;
  if (EXECUTION_RANK[state] <= currentRank) {
    return new Response(
      JSON.stringify({
        ok: true, applied: false, execution_state: current.execution_state,
        correlation_id: correlationId,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const patch: Record<string, unknown> = {
    execution_state: state,
    execution_updated_at: new Date().toISOString(),
  };
  if (typeof payload.reason_code === "string") {
    patch.execution_reason_code = payload.reason_code.slice(0, 64);
  }
  for (const [field, column] of [
    ["safety", "safety_checks"],
    ["intent", "order_intent"],
    ["apex_result", "apex_result"],
  ] as const) {
    const value = payload[field];
    if (value && typeof value === "object") {
      const json = JSON.stringify(value);
      if (json.length > MAX_METADATA_BYTES) return jsonError(413, "DETAIL_TOO_LARGE", correlationId);
      if (containsSecretPattern(json)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);
      patch[column] = value;
    }
  }

  const { error: updErr } = await admin
    .from("strategy_decisions")
    .update(patch)
    .eq("decision_id", decisionId);
  if (updErr) return jsonError(500, "DECISION_UPDATE_FAILED", correlationId);

  return new Response(
    JSON.stringify({ ok: true, applied: true, execution_state: state, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// SHADOW_LEDGER_INSERT — persist a batch of paper (and, once live activates,
// live) decision rows into paper_live_shadow_ledger. Row shape from the
// worker: { source, user_id, cycle_ts_ms, symbol, side, decision,
// reason_code?, correlation_id?, detail? }. Server maps side→direction,
// decision→directive_type, detail→paper_decision, and packs meta into notes.
// Rows with side='flat' are dropped (table CHECK is long|short).
// ---------------------------------------------------------------------------
async function handleShadowLedgerInsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const items = Array.isArray(payload.rows) ? payload.rows : [];
  if (items.length === 0) return jsonError(400, "NO_SHADOW_ROWS", correlationId);
  if (items.length > GUARDIAN_MAX_SHADOW_ROWS) return jsonError(413, "TOO_MANY_SHADOW_ROWS", correlationId);

  const rows: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return jsonError(400, "BAD_SHADOW_ROW", correlationId);
    const d = raw as Record<string, unknown>;
    const source = String(d.source ?? "");
    const userId = typeof d.user_id === "string" ? d.user_id : "";
    const symbol = typeof d.symbol === "string" ? d.symbol.slice(0, 32) : "";
    const side = String(d.side ?? "");
    const decision = String(d.decision ?? "");
    if (!SHADOW_LEDGER_SOURCES.has(source)) return jsonError(400, "BAD_SHADOW_SOURCE", correlationId);
    if (!UUID_RE.test(userId)) return jsonError(400, "BAD_SHADOW_USER", correlationId);
    if (!symbol) return jsonError(400, "BAD_SHADOW_SYMBOL", correlationId);
    if (!GUARDIAN_SIDES.has(side)) return jsonError(400, "BAD_SHADOW_SIDE", correlationId);
    if (!GUARDIAN_DECISIONS.has(decision)) return jsonError(400, "BAD_SHADOW_DECISION", correlationId);
    if (side === "flat") continue; // silently drop — table CHECK is long|short

    const detail = (d.detail && typeof d.detail === "object") ? d.detail : {};
    const detailJson = JSON.stringify(detail);
    if (detailJson.length > MAX_METADATA_BYTES) return jsonError(413, "SHADOW_DETAIL_TOO_LARGE", correlationId);
    if (containsSecretPattern(detailJson)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);

    const reasonCode = typeof d.reason_code === "string" ? d.reason_code.slice(0, 64) : null;
    const correlation = typeof d.correlation_id === "string" && UUID_RE.test(d.correlation_id)
      ? d.correlation_id : null;
    const cycleTs = typeof d.cycle_ts_ms === "number" && Number.isFinite(d.cycle_ts_ms)
      ? Math.trunc(d.cycle_ts_ms) : null;
    const leg = typeof d.leg === "string" ? d.leg.slice(0, 32) : "guardian";
    const regime = typeof d.regime === "string" ? d.regime.slice(0, 32) : null;
    const trendAge = typeof d.trend_age_candles === "number" && Number.isFinite(d.trend_age_candles)
      ? Math.trunc(d.trend_age_candles) : null;

    const decisionBlob = source === "live" ? { live_decision: detail } : { paper_decision: detail };

    rows.push({
      user_id: userId,
      symbol,
      leg,
      direction: side,
      regime,
      trend_age_candles: trendAge,
      directive_type: decision,
      ...decisionBlob,
      comparison_status: source === "live" ? "live_only" : "paper_only",
      divergence_reason: reasonCode,
      notes: {
        source,
        cycle_ts_ms: cycleTs,
        correlation_id: correlation,
        reason_code: reasonCode,
      },
    });
  }

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, inserted: 0, dropped: items.length, correlation_id: correlationId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const { error } = await admin.from("paper_live_shadow_ledger").insert(rows);
  if (error) return jsonError(500, "SHADOW_INSERT_FAILED", correlationId);

  return new Response(
    JSON.stringify({ ok: true, inserted: rows.length, dropped: items.length - rows.length, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// WORKER_COMMAND_CLAIM / WORKER_COMMAND_COMPLETE — Proof-of-life directive channel.
//
// CLAIM atomically consumes exactly ONE pending worker_commands row (currently
// only command='test_order'). The atomicity is achieved by:
//   1. SELECT id … WHERE status='pending' … LIMIT 1
//   2. UPDATE … SET status='consumed', claimed_at=…, claimed_by=<worker_id>
//      WHERE id=? AND status='pending'  RETURNING *
// If two workers race, the second UPDATE returns 0 rows → caller sees "no
// command". "Consumed-before-emit" is thus guaranteed: the row transitions to
// `consumed` BEFORE the worker calls submit_order_intent. A crash mid-flight
// leaves the row consumed (no double-fire). COMPLETE flips it to
// `completed` or `failed` with the sanitized outcome for UI polling.
// ---------------------------------------------------------------------------
async function handleWorkerCommandClaim(
  admin: ReturnType<typeof createClient>,
  workerId: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  // Optional filter: 'test_order' | 'strategy_test'. Two dispatchers claim
  // independently so a proof-of-life poll never swallows a strategy_test row
  // (or vice-versa), which would leave it consumed with no completion.
  const filter = typeof payload.command === "string" &&
    (payload.command === "test_order" || payload.command === "strategy_test")
    ? payload.command : null;
  let sel = admin
    .from("worker_commands")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);
  if (filter) sel = sel.eq("command", filter);
  const { data: pending, error: selErr } = await sel.maybeSingle();
  if (selErr) return jsonError(500, "COMMAND_READ_FAILED", correlationId);
  if (!pending) {
    return new Response(
      JSON.stringify({ ok: true, command: null, correlation_id: correlationId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const nowIso = new Date().toISOString();
  const { data: claimed, error: updErr } = await admin
    .from("worker_commands")
    .update({
      status: "consumed",
      claimed_by: workerId,
      claimed_at: nowIso,
      consumed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id, user_id, command, symbol, params, correlation_id")
    .maybeSingle();
  if (updErr) return jsonError(500, "COMMAND_CLAIM_FAILED", correlationId);
  if (!claimed) {
    // Race: another worker claimed it. Report no command.
    return new Response(
      JSON.stringify({ ok: true, command: null, correlation_id: correlationId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ ok: true, command: claimed, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleWorkerCommandComplete(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const commandId = typeof payload.command_id === "string" ? payload.command_id : "";
  const outcomeStatus = String(payload.status ?? "");
  if (!commandId) return jsonError(400, "MISSING_COMMAND_ID", correlationId);
  if (outcomeStatus !== "completed" && outcomeStatus !== "failed") {
    return jsonError(400, "BAD_OUTCOME_STATUS", correlationId);
  }
  const result = payload.result && typeof payload.result === "object" ? payload.result : null;
  const errorMessage = typeof payload.error_message === "string"
    ? payload.error_message.slice(0, MAX_MESSAGE_LEN)
    : null;
  const nowIso = new Date().toISOString();
  const { error } = await admin
    .from("worker_commands")
    .update({
      status: outcomeStatus,
      completed_at: nowIso,
      updated_at: nowIso,
      result,
      error_message: errorMessage,
    })
    .eq("id", commandId)
    .eq("status", "consumed");
  if (error) return jsonError(500, "COMMAND_COMPLETE_FAILED", correlationId);
  return new Response(
    JSON.stringify({ ok: true, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// SIGNER DB PROXY — narrow ops that let the Railway signer read/write only
// the rows /v1/orders needs (credential lookup, halted check, audit inserts)
// without holding SUPABASE_SERVICE_ROLE_KEY. The signer cannot read the
// service role on Lovable Cloud, so the service role stays inside this edge
// function and every input is validated as UUID/enum server-side.
// ---------------------------------------------------------------------------

// Whitelist of `event` literals accepted by the apex_credential_audit CHECK.
const APEX_AUDIT_EVENTS = new Set([
  "created", "verified", "rotated", "used", "revoked", "signing_failed",
]);

// order_audit.phase CHECK values.
const ORDER_AUDIT_PHASES = new Set([
  "received", "validated", "rejected", "submitted", "exchange_response",
]);

// order_intents.state enum values the signer may legally insert as an initial
// intent row. The lifecycle transitions (signing/submitted/…) are UPDATE-only
// and not exposed by this op.
const ORDER_INTENT_INITIAL_STATES = new Set(["previewed", "confirmed", "queued"]);
const ORDER_INTENT_SIDES = new Set(["BUY", "SELL"]);
const ORDER_INTENT_TYPES = new Set(["MARKET", "LIMIT", "STOP_MARKET", "STOP_LIMIT"]);
const ORDER_INTENT_ENVIRONMENTS = new Set(["mainnet", "testnet"]);

function safeStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, max);
  return s.length > 0 ? s : null;
}

async function handleApexCredentialFindActive(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  const connection_id = typeof payload.exchange_connection_id === "string"
    ? payload.exchange_connection_id : "";
  const environment = String(payload.environment ?? "");
  if (!UUID_RE.test(user_id)) return jsonError(400, "BAD_USER_ID", correlationId);
  if (!UUID_RE.test(connection_id)) return jsonError(400, "BAD_CONNECTION_ID", correlationId);
  if (!ORDER_INTENT_ENVIRONMENTS.has(environment)) {
    return jsonError(400, "BAD_ENVIRONMENT", correlationId);
  }

  // Ownership pre-check: the (user_id, connection_id) pair must belong
  // to the caller-declared user. RLS is not in play (service role), so this
  // predicate is applied explicitly.
  const { data: conn, error: connErr } = await admin
    .from("exchange_connections")
    .select("id")
    .eq("id", connection_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (connErr) return jsonError(500, "CONNECTION_LOOKUP_FAILED", correlationId);
  if (!conn) return jsonError(404, "CONNECTION_NOT_FOUND", correlationId);

  const { data, error } = await admin
    .from("apex_execution_credentials")
    .select(
      "id, user_id, exchange_connection_id, environment, wallet_address, " +
      "apex_account_id, " +
      "encrypted_credentials, encryption_key_version, credential_fingerprint, " +
      "active, revoked_at",
    )
    .eq("user_id", user_id)
    .eq("exchange_connection_id", connection_id)
    .eq("environment", environment)
    .eq("active", true)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (error) return jsonError(500, "CREDENTIAL_LOOKUP_FAILED", correlationId);

  return new Response(
    JSON.stringify({ ok: true, credential: data ?? null, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleExecutionHaltedCheck(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  const connection_id = typeof payload.connection_id === "string" ? payload.connection_id : "";
  if (!UUID_RE.test(user_id)) return jsonError(400, "BAD_USER_ID", correlationId);
  if (connection_id && !UUID_RE.test(connection_id)) {
    return jsonError(400, "BAD_CONNECTION_ID", correlationId);
  }
  const { data, error } = await admin.rpc("is_execution_halted", {
    p_user_id: user_id,
    p_connection_id: connection_id || null,
  });
  if (error) {
    // Fail closed: caller MUST treat any non-200 as halted.
    return jsonError(500, "HALTED_CHECK_FAILED", correlationId);
  }
  const halted = typeof data === "boolean" ? data
    : (Array.isArray(data) && typeof data[0] === "boolean" ? data[0] : true);
  return new Response(
    JSON.stringify({ ok: true, halted, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleOrderIntentInsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const row = (payload.row && typeof payload.row === "object")
    ? payload.row as Record<string, unknown> : null;
  if (!row) return jsonError(400, "BAD_INTENT_ROW", correlationId);
  const user_id = safeStr(row.user_id, 64) ?? "";
  const connection_id = safeStr(row.connection_id, 64) ?? "";
  const client_order_id = safeStr(row.client_order_id, 128) ?? "";
  const environment = String(row.environment ?? "");
  const venue = safeStr(row.venue, 32) ?? "";
  const symbol = safeStr(row.symbol, 32) ?? "";
  const side = String(row.side ?? "").toUpperCase();
  const order_type = String(row.order_type ?? "").toUpperCase();
  const state = String(row.state ?? "");
  const size = typeof row.size === "number" && Number.isFinite(row.size) ? row.size : null;
  const reduce_only = Boolean(row.reduce_only);
  if (!UUID_RE.test(user_id)) return jsonError(400, "BAD_INTENT_USER", correlationId);
  if (!UUID_RE.test(connection_id)) return jsonError(400, "BAD_INTENT_CONNECTION", correlationId);
  if (!client_order_id) return jsonError(400, "BAD_INTENT_COID", correlationId);
  if (!ORDER_INTENT_ENVIRONMENTS.has(environment)) return jsonError(400, "BAD_INTENT_ENV", correlationId);
  if (!venue) return jsonError(400, "BAD_INTENT_VENUE", correlationId);
  if (!symbol) return jsonError(400, "BAD_INTENT_SYMBOL", correlationId);
  if (!ORDER_INTENT_SIDES.has(side)) return jsonError(400, "BAD_INTENT_SIDE", correlationId);
  if (!ORDER_INTENT_TYPES.has(order_type)) return jsonError(400, "BAD_INTENT_TYPE", correlationId);
  if (!ORDER_INTENT_INITIAL_STATES.has(state)) return jsonError(400, "BAD_INTENT_STATE", correlationId);
  if (size === null || size <= 0) return jsonError(400, "BAD_INTENT_SIZE", correlationId);

  const insert: Record<string, unknown> = {
    user_id, connection_id, client_order_id, environment, venue, symbol,
    side, order_type, size, reduce_only, state,
  };
  const price = typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null;
  if (price !== null) insert.protected_price = price;

  const { data, error } = await admin
    .from("order_intents")
    .insert(insert)
    .select("id")
    .maybeSingle();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return jsonError(409, "INTENT_DUPLICATE", correlationId);
    return jsonError(500, "INTENT_INSERT_FAILED", correlationId);
  }
  return new Response(
    JSON.stringify({ ok: true, id: data?.id ?? null, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleOrderAuditInsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const row = (payload.row && typeof payload.row === "object")
    ? payload.row as Record<string, unknown> : null;
  if (!row) return jsonError(400, "BAD_AUDIT_ROW", correlationId);
  const phase = String(row.phase ?? "");
  if (!ORDER_AUDIT_PHASES.has(phase)) return jsonError(400, "BAD_AUDIT_PHASE", correlationId);
  const user_id = safeStr(row.user_id, 64);
  if (user_id && !UUID_RE.test(user_id)) return jsonError(400, "BAD_AUDIT_USER", correlationId);
  const connection_id = safeStr(row.connection_id, 64);
  if (connection_id && !UUID_RE.test(connection_id)) return jsonError(400, "BAD_AUDIT_CONNECTION", correlationId);
  const sanitized = (row.sanitized_response && typeof row.sanitized_response === "object")
    ? row.sanitized_response : {};
  const sanitizedJson = JSON.stringify(sanitized);
  if (sanitizedJson.length > MAX_METADATA_BYTES) return jsonError(413, "AUDIT_DETAIL_TOO_LARGE", correlationId);
  if (containsSecretPattern(sanitizedJson)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);

  const insert = {
    user_id: user_id ?? null,
    connection_id: connection_id ?? null,
    idempotency_key: safeStr(row.idempotency_key, 128),
    phase,
    venue: safeStr(row.venue, 32),
    symbol: safeStr(row.symbol, 32),
    side: safeStr(row.side, 8),
    order_type: safeStr(row.order_type, 16),
    size: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : null,
    price: typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null,
    leverage: typeof row.leverage === "number" && Number.isFinite(row.leverage) ? row.leverage : null,
    is_live: typeof row.is_live === "boolean" ? row.is_live : null,
    reject_reason: safeStr(row.reject_reason, 128),
    exchange_order_id: safeStr(row.exchange_order_id, 128),
    exchange_status: safeStr(row.exchange_status, 64),
    sanitized_response: sanitized,
  };
  const { error } = await admin.from("order_audit").insert(insert);
  if (error) return jsonError(500, "AUDIT_INSERT_FAILED", correlationId);
  return new Response(
    JSON.stringify({ ok: true, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleApexCredentialAuditInsert(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Response> {
  const row = (payload.row && typeof payload.row === "object")
    ? payload.row as Record<string, unknown> : null;
  if (!row) return jsonError(400, "BAD_CRED_AUDIT_ROW", correlationId);
  const user_id = safeStr(row.user_id, 64) ?? "";
  if (!UUID_RE.test(user_id)) return jsonError(400, "BAD_CRED_AUDIT_USER", correlationId);
  const event = String(row.event ?? "");
  if (!APEX_AUDIT_EVENTS.has(event)) return jsonError(400, "BAD_CRED_AUDIT_EVENT", correlationId);
  const credential_id = safeStr(row.credential_id, 64);
  if (credential_id && !UUID_RE.test(credential_id)) return jsonError(400, "BAD_CRED_AUDIT_CRED", correlationId);
  const detail = (row.detail && typeof row.detail === "object") ? row.detail : {};
  const detailJson = JSON.stringify(detail);
  if (detailJson.length > MAX_METADATA_BYTES) return jsonError(413, "CRED_AUDIT_DETAIL_TOO_LARGE", correlationId);
  if (containsSecretPattern(detailJson)) return jsonError(400, "SECRET_PATTERN_REJECTED", correlationId);
  const { error } = await admin.from("apex_credential_audit").insert({
    user_id, event, credential_id: credential_id ?? null, detail,
  });
  if (error) return jsonError(500, "CRED_AUDIT_INSERT_FAILED", correlationId);
  return new Response(
    JSON.stringify({ ok: true, correlation_id: correlationId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
