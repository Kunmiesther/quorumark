/**
 * Paper engine operations — typed sanitized stage results + durable
 * idempotency claim wrapper.
 *
 * Phase 4A introduces two primitives that later slices wire into `runPaperTick`:
 *
 *   1. `StageResult<T>` — a typed success / failure discriminated union that
 *      forbids leaking user IDs, error text, or stack traces. Every stage of
 *      the engine returns one of these; the outer orchestrator aggregates
 *      counts only.
 *   2. `claimEngineOperation(...)` — thin wrapper over the
 *      `claim_paper_engine_operation` RPC. Provides exact-replay semantics
 *      (same op_key + same fingerprint returns the prior sanitized result) and
 *      fail-closed conflict detection (same op_key + different fingerprint
 *      returns `conflict`). Concurrent claims yield exactly one owner.
 *
 * These primitives NEVER see the signer, execution-broker, or any order
 * table. They govern the paper simulation only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type StageFailureReason =
  | "timeout"
  | "market_data"
  | "signal"
  | "risk"
  | "onyx"
  | "fills"
  | "accounting"
  | "conflict"
  | "unauthorized"
  | "internal";

export type StageResult<T> = { ok: true; value: T } | { ok: false; reason: StageFailureReason };

/** Coerce arbitrary thrown values into a sanitized stage failure. */
export function sanitizeError<T>(reason: StageFailureReason): StageResult<T> {
  return { ok: false, reason };
}

export type OperationOutcome =
  | { status: "claimed"; opKey: string }
  | { status: "replayed"; opKey: string; result: unknown }
  | { status: "conflict"; opKey: string }
  | { status: "error"; opKey: string; reason: StageFailureReason };

interface RpcClaimRow {
  status: "claimed" | "replayed" | "conflict";
  result: unknown;
}

/**
 * Claim a `(user_id, op_key)` operation slot. Semantics enforced by the RPC:
 *   - first caller with a given key: `claimed`
 *   - subsequent caller, same fingerprint AND prior result present: `replayed`
 *     with the exact stored result
 *   - subsequent caller, different fingerprint: `conflict`
 *   - concurrent callers: exactly one gets `claimed`, the rest get
 *     `replayed`/`conflict` depending on fingerprint
 *   - any DB error: fail closed → `error`
 */
export async function claimEngineOperation(
  supabase: SupabaseClient,
  userId: string,
  opKey: string,
  fingerprint: string,
): Promise<OperationOutcome> {
  try {
    // Use the caller-provided backend client. The cron route passes the
    // service client; re-importing a second client here made failed claims look
    // like normal strategy rejections and prevented any open rows from landing.
    const { data, error } = await supabase.rpc("claim_paper_engine_operation", {
      _user_id: userId,
      _op_key: opKey,
      _fingerprint: fingerprint,
    });
    if (error) return { status: "error", opKey, reason: "internal" };
    const row = Array.isArray(data)
      ? (data[0] as RpcClaimRow | undefined)
      : (data as RpcClaimRow | null);
    if (!row) return { status: "error", opKey, reason: "internal" };
    if (row.status === "claimed") return { status: "claimed", opKey };
    if (row.status === "replayed") return { status: "replayed", opKey, result: row.result };
    if (row.status === "conflict") return { status: "conflict", opKey };
    return { status: "error", opKey, reason: "internal" };
  } catch {
    return { status: "error", opKey, reason: "internal" };
  }
}

/**
 * Persist the final sanitized result for an already-claimed operation. Only
 * the owning user can complete their own operation (enforced by RLS +
 * SECURITY DEFINER function).
 */
export async function completeEngineOperation(
  supabase: SupabaseClient,
  userId: string,
  opKey: string,
  result: unknown,
): Promise<StageResult<true>> {
  try {
    const { error } = await supabase.rpc("complete_paper_engine_operation", {
      _user_id: userId,
      _op_key: opKey,
      _result: result as never,
    });
    if (error) return { ok: false, reason: "internal" };
    return { ok: true, value: true };
  } catch {
    return { ok: false, reason: "internal" };
  }
}

/**
 * Mark a claimed operation as failed-after-claim so the same minute bucket does
 * not stay permanently blocked when an atomic RPC rejects before completion.
 */
export async function deadLetterEngineOperation(
  supabase: SupabaseClient,
  userId: string,
  opKey: string,
  reason: string,
): Promise<StageResult<true>> {
  try {
    const { error } = await supabase.rpc(
      "dead_letter_paper_engine_operation" as never,
      {
        _user_id: userId,
        _op_key: opKey,
        _reason: reason.slice(0, 120),
      } as never,
    );
    if (error) return { ok: false, reason: "internal" };
    return { ok: true, value: true };
  } catch {
    return { ok: false, reason: "internal" };
  }
}

/** Deterministic fingerprint of a serialisable request payload. */
export async function fingerprintPayload(payload: unknown): Promise<string> {
  const json = stableStringify(payload);
  const enc = new TextEncoder().encode(json);
  // Prefer Web Crypto (workers, jsdom). Fall back to node:crypto for older envs.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", enc);
    return bufToHex(buf);
  }
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.createHash("sha256").update(json).digest("hex");
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
