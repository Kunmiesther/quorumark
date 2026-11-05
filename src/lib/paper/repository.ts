/**
 * Paper engine repository — atomic mutation wrappers (Phase 4B).
 *
 * Each helper here corresponds to exactly one atomic paper mutation RPC
 * (`paper_open_position`, `paper_add_rung`, `paper_reduce_position`,
 * `paper_close_position`). Every RPC runs its writes inside a single Postgres
 * function body, so the multi-row change either commits together or rolls back
 * together.
 *
 * SAFETY / SANITIZATION:
 *   - The wrappers NEVER surface raw DB error text, credentials, SQL, or user
 *     IDs. Every failure collapses to a typed `StageResult` with a coarse
 *     reason ("conflict", "unauthorized", "internal", …).
 *   - Idempotency is delegated to the Phase 4A `paper_engine_operations`
 *     ledger via `claimEngineOperation` / `completeEngineOperation`. Callers
 *     pass an `opKey` + `fingerprint`; an exact replay returns the prior
 *     stored result without re-executing the RPC, and a fingerprint mismatch
 *     surfaces as `conflict`. Any RPC error leaves the ledger in `claimed`
 *     state → caller sees `reconciliationRequired` and does NOT blindly retry.
 *
 * SCOPE: strategy math, sizing, fees, PnL, leverage semantics are computed by
 * the engine before it calls these helpers. This module ONLY carries the
 * precomputed payload into the atomic RPC.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  claimEngineOperation,
  completeEngineOperation,
  deadLetterEngineOperation,
  type StageResult,
} from "./operations";

export interface AtomicResult<T> {
  result: StageResult<T> & { reconciliationRequired?: boolean; detail?: string };
  replayed: boolean;
}


/**
 * Sanitized RPC failure signal.
 *
 * Postgres raises domain-level guardrail violations (e.g.
 * `paper_orchestration_missing`, wallet/margin assertions) as exceptions. The
 * previous `throw new Error("rpc_error")` discarded them, so every guardrail
 * rejection collapsed to an opaque `internal` reason and the operator could
 * not tell an AI-trace gap from a margin assertion.
 *
 * We keep the sanitization contract: no SQL, no credentials, no user IDs — only
 * the Postgres SQLSTATE plus the leading token of the raised message, both of
 * which are authored by our own migrations.
 */
export function sanitizeRpcError(error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" && e.code ? e.code : "unknown";
  const raw = typeof e.message === "string" ? e.message : "";
  // Guardrail exceptions are authored as `token: human detail` — keep the token.
  const token = raw.split(":")[0]?.trim().replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48) || "unspecified";
  return `${code}/${token}`;
}


async function withIdempotency<T>(
  supabase: SupabaseClient,
  userId: string,
  opKey: string,
  fingerprint: string,
  exec: () => Promise<T>,
): Promise<AtomicResult<T>> {
  const claim = await claimEngineOperation(supabase, userId, opKey, fingerprint);
  if (claim.status === "conflict") {
    return { result: { ok: false, reason: "conflict" }, replayed: false };
  }
  if (claim.status === "error") {
    return { result: { ok: false, reason: claim.reason }, replayed: false };
  }
  if (claim.status === "replayed") {
    return { result: { ok: true, value: claim.result as T }, replayed: true };
  }
  // status === "claimed"
  try {
    const value = await exec();
    // Persist the sanitized result. If completion fails, we still return the
    // successful mutation result but flag that the ledger is inconsistent.
    const done = await completeEngineOperation(supabase, userId, opKey, value as unknown);
    if (!done.ok) {
      return {
        result: { ok: true, value, reconciliationRequired: true } as StageResult<T> & { reconciliationRequired?: boolean },
        replayed: false,
      };
    }
    return { result: { ok: true, value }, replayed: false };
  } catch (err) {
    // RPC error before completion: the database mutation was rejected, so move
    // the claim out of `claimed`. Completed mutations are still protected by
    // `completeEngineOperation`; failed opens no longer block the next tick.
    // The sanitized SQLSTATE + guardrail token is persisted on the dead letter
    // AND returned to the caller so the tick evaluation log names the blocker.
    const detail = String((err as Error)?.message ?? "unspecified").slice(0, 64);
    await deadLetterEngineOperation(supabase, userId, opKey, `atomic_rpc_rejected:${detail}`);
    return {
      result: { ok: false, reason: "internal", detail, reconciliationRequired: true } as StageResult<T> & { reconciliationRequired?: boolean; detail?: string },
      replayed: false,
    };

  }

}

async function callRpc(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ data: any; error: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (supabase.rpc as any)(name, args);
}

// ─── OPEN ────────────────────────────────────────────────────────────────
export interface OpenPositionInput {
  userId: string;
  walletId: string;
  payload: Record<string, unknown>;
  opKey: string;
  fingerprint: string;
}
export type OpenPositionResult = { position_id: string };
export function openPosition(
  supabase: SupabaseClient,
  input: OpenPositionInput,
): Promise<AtomicResult<OpenPositionResult>> {
  return withIdempotency(supabase, input.userId, input.opKey, input.fingerprint, async () => {
    const { data, error } = await callRpc(supabase, "paper_open_position", {
      _user_id: input.userId,
      _wallet_id: input.walletId,
      _payload: input.payload,
    });
    if (error) throw new Error(sanitizeRpcError(error));
    return data as OpenPositionResult;
  });
}

// ─── ADD RUNG ────────────────────────────────────────────────────────────
/**
 * A single rung-fill identity persisted atomically alongside the position
 * mutation. `rung_index` is the deterministic 1..N position in the ORIGINAL
 * planned ladder (rung 1 = initial fill). The (position_id, rung_index)
 * unique key makes retries and concurrent duplicate submissions collapse
 * to a single row per rung.
 */
export interface RungFillIdentity {
  rung_index: number;
  price: number;
  qty: number;
  margin: number;
  tp: number;
  fill_status?: "filled" | "cancelled" | "rejected";
  filled_at?: string;
  candle_ts_ms?: number;
}

export interface AddRungInput {
  userId: string;
  positionId: string;
  expectedRungCount: number;
  newState: Record<string, unknown>;
  /**
   * Rung identities being persisted on this tick. Each entry becomes a
   * row in `paper_rung_fills` (ON CONFLICT DO NOTHING). Server derives
   * `filled_rung_count` from persisted identities, not from any client
   * count, and only arms the hard stop when that authoritative count
   * meets `configured_rung_count`.
   */
  rungFills: RungFillIdentity[];
  opKey: string;
  fingerprint: string;
}
export type AddRungResult = {
  position_id: string;
  rung_count: number;
  filled_rung_count: number;
  configured_rung_count: number | null;
  armed: boolean;
};
export function addRungAtomic(
  supabase: SupabaseClient,
  input: AddRungInput,
): Promise<AtomicResult<AddRungResult>> {
  return withIdempotency(supabase, input.userId, input.opKey, input.fingerprint, async () => {
    const { data, error } = await callRpc(supabase, "paper_add_rung", {
      _user_id: input.userId,
      _position_id: input.positionId,
      _expected_rung_count: input.expectedRungCount,
      _new_state: input.newState,
      _rung_fills: input.rungFills,
    });
    if (error) throw new Error(sanitizeRpcError(error));
    return data as AddRungResult;
  });
}

// ─── REDUCE (partial exit) ───────────────────────────────────────────────
export interface ReducePositionInput {
  userId: string;
  positionId: string;
  expectedRungCount: number;
  trade: Record<string, unknown> | Record<string, unknown>[];
  newState: Record<string, unknown>;
  accountDelta: number;
  walletId: string | null;
  walletStats: { trades_delta: number; wins_delta: number; losses_delta: number } | null;
  opKey: string;
  fingerprint: string;
}
export type ReduceResult = { trade_id: string; trade_ids?: string[]; position_id: string };
export function reducePosition(
  supabase: SupabaseClient,
  input: ReducePositionInput,
): Promise<AtomicResult<ReduceResult>> {
  return withIdempotency(supabase, input.userId, input.opKey, input.fingerprint, async () => {
    const { data, error } = await callRpc(supabase, "paper_reduce_position", {
      _user_id: input.userId,
      _position_id: input.positionId,
      _expected_rung_count: input.expectedRungCount,
      _trade: input.trade,
      _new_state: input.newState,
      _account_delta: input.accountDelta,
      _wallet_id: input.walletId,
      _wallet_stats: input.walletStats,
    });
    if (error) throw new Error(sanitizeRpcError(error));
    return data as ReduceResult;
  });
}

// ─── CLOSE (final) ───────────────────────────────────────────────────────
export interface ClosePositionInput {
  userId: string;
  positionId: string;
  lastSeenCandleTsMs: number | null;
  trades: Array<Record<string, unknown>>;
  accountDelta: number;
  walletId: string | null;
  walletStats: { trades_delta: number; wins_delta: number; losses_delta: number } | null;
  opKey: string;
  fingerprint: string;
}
export type CloseResult = { already_closed: boolean; position_id: string; trade_ids: string[] };
export function closePosition(
  supabase: SupabaseClient,
  input: ClosePositionInput,
): Promise<AtomicResult<CloseResult>> {
  return withIdempotency(supabase, input.userId, input.opKey, input.fingerprint, async () => {
    const { data, error } = await callRpc(supabase, "paper_close_position", {
      _user_id: input.userId,
      _position_id: input.positionId,
      _last_seen_candle_ts_ms: input.lastSeenCandleTsMs,
      _trades: input.trades,
      _account_delta: input.accountDelta,
      _wallet_id: input.walletId,
      _wallet_stats: input.walletStats,
    });
    if (error) throw new Error(sanitizeRpcError(error));
    return data as CloseResult;
  });
}

// ─── PARTIAL CLOSE (HTF Guardian promotion — bank a slice) ───────────────
// Atomically: insert one banked paper_trades row, decrement paper_positions
// size/notional/margin, apply the promotion patch (promoted, breakeven stop,
// cancel TP/pending rungs), credit paper_accounts, and stamp wallet stats.
// The RPC is SECURITY DEFINER and restricted to service_role; the caller
// MUST be the server engine (supabaseAdmin) — never the client.
export interface PartialClosePositionInput {
  userId: string;
  positionId: string;
  lastSeenCandleTsMs: number | null;
  trade: Record<string, unknown>;
  sizeQtyDelta: number;
  sizeNotionalDelta: number;
  marginDelta: number;
  accountDelta: number;
  walletId: string | null;
  walletStats: { trades_delta: number; wins_delta: number; losses_delta: number } | null;
  positionPatch: Record<string, unknown>;
  opKey: string;
  fingerprint: string;
}
export type PartialCloseResult = {
  already_closed: boolean;
  position_id: string;
  trade_id?: string;
  new_qty?: number;
};
export function partialClosePosition(
  supabase: SupabaseClient,
  input: PartialClosePositionInput,
): Promise<AtomicResult<PartialCloseResult>> {
  return withIdempotency(supabase, input.userId, input.opKey, input.fingerprint, async () => {
    const { data, error } = await callRpc(supabase, "paper_partial_close_position", {
      _user_id: input.userId,
      _position_id: input.positionId,
      _last_seen_candle_ts_ms: input.lastSeenCandleTsMs,
      _trade: input.trade,
      _size_qty_delta: input.sizeQtyDelta,
      _size_notional_delta: input.sizeNotionalDelta,
      _margin_delta: input.marginDelta,
      _account_delta: input.accountDelta,
      _wallet_id: input.walletId,
      _wallet_stats: input.walletStats,
      _position_patch: input.positionPatch,
    });
    if (error) throw new Error(sanitizeRpcError(error));
    return data as PartialCloseResult;
  });
}
