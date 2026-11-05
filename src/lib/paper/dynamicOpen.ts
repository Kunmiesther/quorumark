/**
 * Dynamic-universe entry adapter.
 *
 * Bridges the engine's Phase-C execution loop to the pod/leg contract:
 *
 *   ONYX approval  →  onyx_decisions row  →  paper_authorizations
 *                  →  paper_bind_pod_and_reserve_leg
 *                  →  paper_open_position
 *
 * Sole entry point for any tick whose `universeGate.active === true`. When
 * this returns `{ ok: false }` the engine MUST skip the position for this
 * tick — nothing is written to paper_positions and no leg stays reserved.
 *
 * This module does NOT decide, size, or route. All strategy math is done
 * upstream by the legs (Hunter/Sniper/Accumulator/DCA/hedge); we only carry
 * a pre-authorized payload into the atomic RPC chain.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { authorizeAndOpen, type LegPurpose, type LegDirection } from "./podService";
import type { OnyxCandidate } from "@/lib/onyx/decide";

export interface DynamicOpenContext {
  scanId: string;
  runId: string;
  epochId: string | null;
  snapshotId: string;
  rankingVersion: number;
  universeVersion: number;
  envelopeVersion: number | null;
  rulesVersion: number | null;
  connectionId: string | null;
  exchange: string;
  environment: Database["public"]["Enums"]["scout_environment"];
  marketType: Database["public"]["Enums"]["scout_market_type"];
}

export interface DynamicOpenResult {
  ok: true;
  positionId: string;
  authorizationId: string;
  podId: string;
  legId: string;
}

export interface DynamicOpenFailure {
  ok: false;
  reason: string;
  released: boolean;
}

export type PaperIntentState = "approved" | "wait" | "rejected" | "executed" | "failed";

export async function recordPaperOrderIntent(
  supabase: SupabaseClient<Database>,
  userId: string,
  ctx: DynamicOpenContext,
  input: {
    symbol: string;
    side: LegDirection;
    strategy?: string | null;
    state: PaperIntentState;
    reasonCode: string;
    reasonDetail?: string | null;
    margin?: number | null;
    notional?: number | null;
    leverage?: number | null;
    onyxDecisionId?: string | null;
    evidence?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { data, error } = await supabase
    .from("paper_order_intents")
    .insert({
      user_id: userId,
      run_id: ctx.runId,
      epoch_id: ctx.epochId,
      scan_id: ctx.scanId,
      ranking_snapshot_id: ctx.snapshotId,
      onyx_decision_id: input.onyxDecisionId ?? null,
      symbol: input.symbol,
      side: input.side,
      strategy: input.strategy ?? null,
      state: input.state,
      reason_code: input.reasonCode,
      reason_detail: input.reasonDetail ?? undefined,
      margin: input.margin ?? undefined,
      notional: input.notional ?? undefined,
      leverage: input.leverage ?? undefined,
      evidence: (input.evidence ?? {}) as Database["public"]["Tables"]["paper_order_intents"]["Insert"]["evidence"],
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id as string;
}

/**
 * Build the DynamicOpenContext for a single tick. Returns `null` when any
 * required piece of evidence is missing — the caller MUST then fall back to
 * fail-closed and record a skip reason. Never fabricates IDs.
 */
export async function loadDynamicContext(
  supabase: SupabaseClient<Database>,
  userId: string,
  snapshotId: string,
): Promise<DynamicOpenContext | null> {
  const snapRes = await supabase
    .from("scout_universe_snapshots")
    .select(
      "id, connection_id, exchange, environment, market_type, universe_version, ranking_version",
    )
    .eq("id", snapshotId)
    .maybeSingle();
  if (snapRes.error || !snapRes.data) return null;
  const snap = snapRes.data;

  const [scanRes, epochRes] = await Promise.all([
    supabase
      .from("scout_scans")
      .select("id")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("paper_epochs")
      .select("id, run_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (scanRes.error || !scanRes.data) return null;
  if (epochRes.error || !epochRes.data) return null;

  return {
    scanId: scanRes.data.id as string,
    runId: epochRes.data.run_id as string,
    epochId: epochRes.data.id as string,
    snapshotId: snap.id as string,
    rankingVersion: Number(snap.ranking_version ?? 0),
    universeVersion: Number(snap.universe_version ?? 0),
    envelopeVersion: null,
    rulesVersion: null,
    connectionId: (snap.connection_id as string | null) ?? null,
    exchange: (snap.exchange as string) ?? "apex",
    environment: snap.environment as Database["public"]["Enums"]["scout_environment"],
    marketType: snap.market_type as Database["public"]["Enums"]["scout_market_type"],
  };
}

export interface OpenDynamicInput {
  approved: OnyxCandidate & {
    rationale?: string;
    entryFee?: number;
  };
  formationPayload: Record<string, unknown>;
  walletId: string;
  purpose: LegPurpose;
  /** Optional advisory signal id from scout_signals for lineage. */
  signalId?: string | null;
  /** Approved margin mode — hard-coded "cross" by policy. */
  marginMode?: "cross" | "isolated";
  /** Authorization TTL in seconds; short so a stalled tick can't hold a leg. */
  ttlSecs?: number;
}

/**
 * Persist the onyx_decisions row, then run the atomic
 * authorize → bind-pod → reserve-leg → open-position chain.
 *
 * If any step fails the leg (if reserved) is released best-effort by
 * podService and no paper_positions row is created. The engine caller
 * must NOT retry with the same key on the same tick — that violates the
 * one-decision-per-approval invariant.
 */
export async function openDynamic(
  supabase: SupabaseClient<Database>,
  userId: string,
  ctx: DynamicOpenContext,
  input: OpenDynamicInput,
): Promise<DynamicOpenResult | DynamicOpenFailure> {
  const approved = input.approved;
  const direction: LegDirection = approved.direction === "short" ? "short" : "long";

  // 1) Persist onyx_decisions FIRST. Every downstream row references it.
  //    Uses the DB default for correlation_id / decision_at.
  const decisionInsert = await supabase
    .from("onyx_decisions")
    .insert({
      user_id: userId,
      symbol: approved.symbol,
      side: direction,
      decision: "approved",
      scan_id: ctx.scanId,
      strategy: approved.leg,
      supporting_codes: [],
      conflicting_codes: [],
      envelope_version: ctx.envelopeVersion ?? 0,
      rules_version: ctx.rulesVersion ?? 0,
      confidence: null,
      risk_check: {
        margin: approved.margin,
        notional: approved.notional,
        leverage: approved.leverage,
        purpose: input.purpose,
      } as unknown as Database["public"]["Tables"]["onyx_decisions"]["Insert"]["risk_check"],
      detail: {
        leg: approved.leg,
        regime: approved.regime,
        walletKey: approved.walletKey,
        openedFromSignal: approved.openedFromSignal,
        rationale: approved.rationale ?? null,
        trendState: approved.trendState,
        trendSlopePct: approved.trendSlopePct,
      } as unknown as Database["public"]["Tables"]["onyx_decisions"]["Insert"]["detail"],
      correlation_id: crypto.randomUUID(),
    })
    .select("id")
    .single();
  if (decisionInsert.error || !decisionInsert.data) {
    return {
      ok: false,
      reason: `onyx_decision_insert_failed:${decisionInsert.error?.code ?? "unknown"}`,
      released: true,
    };
  }
  const onyxDecisionId = decisionInsert.data.id as string;

  const intentId = await recordPaperOrderIntent(supabase, userId, ctx, {
    symbol: approved.symbol,
    side: direction,
    strategy: approved.leg,
    state: "approved",
    reasonCode: "onyx_approved",
    reasonDetail: approved.rationale ?? null,
    margin: approved.margin,
    notional: approved.notional,
    leverage: approved.leverage,
    onyxDecisionId,
    evidence: { key: approved.key, purpose: input.purpose },
  });

  // 2) Atomic auth → bind → open. podService owns the rollback of the leg
  //    if step 3 fails.
  const result = await authorizeAndOpen(supabase, {
    authorization: {
      userId,
      connectionId: ctx.connectionId,
      exchange: ctx.exchange,
      environment: ctx.environment,
      marketType: ctx.marketType,
      runId: ctx.runId,
      epochId: ctx.epochId,
      scanId: ctx.scanId,
      signalId: input.signalId ?? null,
      rankingSnapshotId: ctx.snapshotId,
      onyxDecisionId,
      symbol: approved.symbol,
      direction,
      formation: approved.leg,
      approvedLeverage: approved.leverage,
      approvedMarginMode: input.marginMode ?? "cross",
      approvedNotional: approved.notional,
      approvedMargin: approved.margin,
      universeVersion: ctx.universeVersion,
      rankingVersion: ctx.rankingVersion,
      envelopeVersion: ctx.envelopeVersion,
      rulesVersion: ctx.rulesVersion,
      ttlSecs: input.ttlSecs ?? 120,
    },
    purpose: input.purpose,
    formation: {
      userId,
      walletId: input.walletId,
      formationPayload: input.formationPayload,
    },
  });

  if (!result.ok) {
    const err = result.error;
    const released =
      err.kind === "open_failed" || err.kind === "unexpected" ? err.released : true;
    await recordPaperOrderIntent(supabase, userId, ctx, {
      symbol: approved.symbol,
      side: direction,
      strategy: approved.leg,
      state: "failed",
      reasonCode: `dynamic_open_failed:${err.kind}`,
      reasonDetail: "reason" in err ? err.reason : "",
      margin: approved.margin,
      notional: approved.notional,
      leverage: approved.leverage,
      onyxDecisionId,
      evidence: { approved_intent_id: intentId, released },
    });
    return { ok: false, reason: `${err.kind}:${"reason" in err ? err.reason : ""}`, released };
  }
  if (intentId) {
    await supabase.from("paper_order_intents").update({ state: "executed" }).eq("id", intentId);
  }
  return {
    ok: true,
    positionId: result.value.positionId,
    authorizationId: result.value.authorizationId,
    podId: result.value.podId,
    legId: result.value.legId,
  };
}
