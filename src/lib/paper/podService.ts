/**
 * Atomic pod/leg assignment + paper formation service.
 *
 * This is the single entry point that turns a fresh, real Scout signal +
 * ranking + Onyx approval into a paper formation on the correct wallet
 * leg. It composes three DB operations that MUST NOT be split across
 * independent call sites:
 *
 *   1. INSERT paper_authorizations   — single-use, expiring bearer
 *   2. RPC   paper_bind_pod_and_reserve_leg
 *   3. RPC   paper_open_position     — with slot_id/leg_id/pod_id/auth
 *
 * All-or-nothing: any step failure releases the reserved leg (best-effort
 * rollback of the DB-visible side effects that survive a partial call).
 * The DB-side unique indexes + authority trigger make it impossible for a
 * caller to bypass this flow and still land a paper_positions row for a
 * `dynamic_universe` user.
 *
 * Ordinary strategy math (sizing, leverage, TP/stop levels, rung ladder)
 * MUST be computed by the engine before invoking this service — the
 * service only carries the pre-authorized payload into the RPCs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type LegPurpose = "primary" | "hedge" | "opposing_opportunity";
export type LegDirection = "long" | "short";

export interface AuthorizationInput {
  userId: string;
  connectionId: string | null;
  exchange: string;
  environment: Database["public"]["Enums"]["scout_environment"];
  marketType: Database["public"]["Enums"]["scout_market_type"];
  runId: string;
  epochId: string | null;
  scanId: string;
  signalId: string | null;
  rankingSnapshotId: string;
  onyxDecisionId: string;
  symbol: string;
  direction: LegDirection;
  formation: string;
  approvedLeverage: number;
  approvedMarginMode: "cross" | "isolated";
  approvedNotional: number;
  approvedMargin: number;
  universeVersion: number;
  rankingVersion: number;
  envelopeVersion: number | null;
  rulesVersion: number | null;
  ttlSecs: number;
  detail?: Record<string, unknown>;
}

export interface BindResult {
  authorizationId: string;
  podId: string;
  legId: string;
  symbol: string;
  direction: LegDirection;
  purpose: LegPurpose;
}

export interface OpenFormationInput {
  userId: string;
  walletId: string;
  /** All strategy fields the engine would normally pass to paper_open_position. */
  formationPayload: Record<string, unknown>;
}

export type ServiceError =
  | { kind: "auth_insert_failed"; reason: string }
  | { kind: "bind_failed"; reason: string }
  | { kind: "no_free_pod" }
  | { kind: "open_failed"; reason: string; released: boolean }
  | { kind: "unexpected"; reason: string; released: boolean };

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

// ── Step 1: insert a fresh, single-use authorization ─────────────────
export async function insertAuthorization(
  supabase: SupabaseClient<Database>,
  input: AuthorizationInput,
): Promise<ServiceResult<{ authorizationId: string; expiresAt: string; correlationId: string }>> {
  const expires = new Date(Date.now() + Math.max(30, input.ttlSecs) * 1000).toISOString();
  const { data, error } = await supabase
    .from("paper_authorizations")
    .insert({
      user_id: input.userId,
      connection_id: input.connectionId,
      exchange: input.exchange,
      environment: input.environment,
      market_type: input.marketType,
      run_id: input.runId,
      epoch_id: input.epochId,
      scan_id: input.scanId,
      signal_id: input.signalId,
      ranking_snapshot_id: input.rankingSnapshotId,
      onyx_decision_id: input.onyxDecisionId,
      symbol: input.symbol,
      direction: input.direction,
      formation: input.formation,
      approved_leverage: input.approvedLeverage,
      approved_margin_mode: input.approvedMarginMode,
      approved_notional: input.approvedNotional,
      approved_margin: input.approvedMargin,
      universe_version: input.universeVersion,
      ranking_version: input.rankingVersion,
      envelope_version: input.envelopeVersion,
      rules_version: input.rulesVersion,
      expires_at: expires,
      detail: (input.detail ?? {}) as Database["public"]["Tables"]["paper_authorizations"]["Insert"]["detail"],
    })
    .select("id, expires_at, correlation_id")
    .single();
  if (error || !data) {
    return { ok: false, error: { kind: "auth_insert_failed", reason: error?.code ?? "unknown" } };
  }
  return {
    ok: true,
    value: {
      authorizationId: data.id as string,
      expiresAt: data.expires_at as string,
      correlationId: data.correlation_id as string,
    },
  };
}

// ── Step 2: atomic pod bind + leg reserve ────────────────────────────
export async function bindPodAndReserveLeg(
  supabase: SupabaseClient<Database>,
  args: { userId: string; authorizationId: string; purpose: LegPurpose; ttlSecs?: number },
): Promise<ServiceResult<BindResult>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)("paper_bind_pod_and_reserve_leg", {
    _user_id: args.userId,
    _authorization_id: args.authorizationId,
    _purpose: args.purpose,
    _ttl_secs: args.ttlSecs ?? 300,
  });
  if (error) return { ok: false, error: { kind: "bind_failed", reason: error.code ?? "unknown" } };
  const row = (data ?? {}) as Record<string, unknown>;
  if (!row.pod_id || !row.leg_id) return { ok: false, error: { kind: "no_free_pod" } };
  return {
    ok: true,
    value: {
      authorizationId: row.authorization_id as string,
      podId: row.pod_id as string,
      legId: row.leg_id as string,
      symbol: row.symbol as string,
      direction: row.direction as LegDirection,
      purpose: (row.purpose as LegPurpose) ?? args.purpose,
    },
  };
}

// ── Step 3: release a reserved leg (rollback of Step 2) ──────────────
export async function releaseLeg(
  supabase: SupabaseClient<Database>,
  args: { userId: string; legId: string; reason: string },
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)("paper_release_wallet_leg", {
    _user_id: args.userId,
    _leg_id: args.legId,
    _reason: args.reason,
  });
  return !error && Boolean(data);
}

// ── Full atomic sequence: auth → bind → open ─────────────────────────
export interface AtomicOpenInput {
  authorization: AuthorizationInput;
  purpose: LegPurpose;
  formation: OpenFormationInput;
}

export interface AtomicOpenSuccess extends BindResult {
  positionId: string;
}

export async function authorizeAndOpen(
  supabase: SupabaseClient<Database>,
  input: AtomicOpenInput,
): Promise<ServiceResult<AtomicOpenSuccess>> {
  const auth = await insertAuthorization(supabase, input.authorization);
  if (!auth.ok) return auth;

  const bound = await bindPodAndReserveLeg(supabase, {
    userId: input.authorization.userId,
    authorizationId: auth.value.authorizationId,
    purpose: input.purpose,
  });
  if (!bound.ok) return bound;

  const payload = {
    ...input.formation.formationPayload,
    slot_id: null,
    authorization_id: bound.value.authorizationId,
    pod_id: bound.value.podId,
    leg_id: bound.value.legId,
    symbol: bound.value.symbol,
    direction: bound.value.direction,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)("paper_open_position", {
      _user_id: input.authorization.userId,
      _wallet_id: input.formation.walletId,
      _payload: payload,
    });
    if (error) {
      const released = await releaseLeg(supabase, {
        userId: input.authorization.userId,
        legId: bound.value.legId,
        reason: `open_failed:${error.code ?? "unknown"}`,
      });
      return { ok: false, error: { kind: "open_failed", reason: error.code ?? "unknown", released } };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const positionId = row.position_id as string | undefined;
    if (!positionId) {
      const released = await releaseLeg(supabase, {
        userId: input.authorization.userId,
        legId: bound.value.legId,
        reason: "open_no_position_id",
      });
      return { ok: false, error: { kind: "open_failed", reason: "no_position_id", released } };
    }
    return { ok: true, value: { ...bound.value, positionId } };
  } catch (e) {
    const released = await releaseLeg(supabase, {
      userId: input.authorization.userId,
      legId: bound.value.legId,
      reason: "open_threw",
    });
    return {
      ok: false,
      error: { kind: "unexpected", reason: e instanceof Error ? e.message : "unknown", released },
    };
  }
}

// ── Read helpers for UI + capacity checks ────────────────────────────
export interface PodSummary {
  podId: string;
  podIndex: number;
  state: "empty" | "bound" | "retired";
  assignedSymbol: string | null;
  legs: Array<{
    legId: string;
    direction: LegDirection;
    state: string;
    purpose: LegPurpose | null;
    positionId: string | null;
  }>;
}

export async function ensurePodsForScope(
  supabase: SupabaseClient<Database>,
  args: {
    userId: string;
    connectionId: string | null;
    exchange: string;
    environment: Database["public"]["Enums"]["scout_environment"];
    marketType: Database["public"]["Enums"]["scout_market_type"];
    runId: string;
  },
): Promise<{ podsCreated: number; legsCreated: number } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)("paper_ensure_symbol_pods", {
    _user_id: args.userId,
    _connection_id: args.connectionId,
    _exchange: args.exchange,
    _environment: args.environment,
    _market_type: args.marketType,
    _run_id: args.runId,
  });
  if (error) return null;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    podsCreated: Number(row.pods_created ?? 0),
    legsCreated: Number(row.legs_created ?? 0),
  };
}
