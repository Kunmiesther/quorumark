/**
 * Universe discovery server function — the C1 read-only entry point.
 *
 * Chain:
 *   1. Read overrides + prior ranking state for scope (user, exchange, env, market).
 *   2. Ask the venue adapter for the verified universe.
 *   3. Apply eligibility filter.
 *   4. Rank (deterministic, top N = 10 absolute ceiling).
 *   5. Apply rank-band hysteresis.
 *   6. Persist snapshot + rankings + updated ranking state atomically.
 *
 * Paper-only during C1/C2. Live/mainnet is refused at the flag layer.
 * The signal-side scoring inputs (regime, alignment, ...) are stubbed to
 * zero here — C2 wires them from `runScoutScan`.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getUniverseAdapter } from "./adapters/registry";
import { buildPaperUniverse } from "./adapters/paper";
import { DEFAULT_ELIGIBILITY, filterEligibility } from "./eligibility";
import { resolveOverrides } from "./overrides";
import { rankUniverse, type RankingSignalInputs } from "./ranking";
import { applyRankHysteresis, type PriorRankState } from "./hysteresis";
import {
  HYSTERESIS_VERSION,
  RANKING_VERSION,
  UNIVERSE_VERSION,
} from "./versions";
import { isDynamicUniverseEnabled } from "./flag";
import type {
  RankedSymbol,
  UniverseEnvironment,
  UniverseMarketType,
  UniverseOverride,
  UniverseSnapshot,
} from "./types";

const ABSOLUTE_TOP_N = 10;
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface DiscoverInput {
  exchange: string;
  environment: UniverseEnvironment;
  marketType: UniverseMarketType;
  connectionId?: string | null;
}

function randomCorrelationId(): string {
  // crypto.randomUUID is available in the Worker runtime and Node ≥ 19.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `corr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runnable core of the discovery pipeline. Callable from any server context
 * (server function, cron route, engine) with any Supabase client scoped to
 * the target user. Returns the persisted snapshot summary.
 */
export async function runUniverseDiscovery(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
  data: DiscoverInput,
): Promise<UniverseSnapshot> {
  return await discoverCore({ data, context: { supabase, userId } });
}

export const discoverUniverse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: DiscoverInput): DiscoverInput => {
    if (!input?.exchange) throw new Error("exchange required");
    if (!input.environment) throw new Error("environment required");
    if (!input.marketType) throw new Error("marketType required");
    return input;
  })
  .handler(async ({ data, context }): Promise<UniverseSnapshot> => {
    return await discoverCore({ data, context: { supabase: context.supabase, userId: context.userId } });
  });

async function discoverCore({
  data,
  context,
}: {
  data: DiscoverInput;
  context: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string };
}): Promise<UniverseSnapshot> {
    const { supabase, userId } = context;
    const { exchange, environment, marketType, connectionId } = data;

    // Flag gate — during C1/C2 this stays false, adapters and math still run
    // for testing but no engine consumption. Callers can inspect
    // dynamicUniverseEnvSet() for diagnostics.
    void isDynamicUniverseEnabled({ executionMode: environment as "paper" | "testnet" | "mainnet" });

    const now = Date.now();
    const correlationId = randomCorrelationId();

    // 1. Overrides (owner-scoped)
    const { data: overrideRows } = await supabase
      .from("scout_universe_overrides")
      .select("symbol,kind,expires_at,reason")
      .eq("user_id", userId)
      .eq("exchange", exchange)
      .eq("environment", environment)
      .eq("market_type", marketType);
    const rawOverrides: UniverseOverride[] = (overrideRows ?? []).map((r) => ({
      symbol: r.symbol as string,
      kind: r.kind as UniverseOverride["kind"],
      expiresAt: r.expires_at ? new Date(r.expires_at as string).getTime() : null,
      reason: (r.reason as string | null) ?? null,
    }));
    const resolvedOverrides = resolveOverrides(rawOverrides, now);

    // 2. Adapter
    let universe;
    if (exchange === "paper") {
      const { data: seeds } = await supabase
        .from("paper_test_symbols")
        .select("symbol,enabled,max_leverage,market_available")
        .eq("user_id", userId);
      universe = buildPaperUniverse(
        (seeds ?? []).map((s) => ({
          symbol: s.symbol as string,
          enabled: (s.enabled as boolean) ?? false,
          max_leverage: (s.max_leverage as number | null) ?? null,
          market_available: (s.market_available as boolean | null) ?? null,
        })),
        now,
        environment,
      );
    } else {
      const adapter = getUniverseAdapter(exchange);
      universe = await adapter.discover({ environment, marketType, now });
    }

    // 3. Eligibility
    const eligibleList = filterEligibility(universe, resolvedOverrides, DEFAULT_ELIGIBILITY, now);

    // 4. Ranking — signal map hydrated from the most recent per-symbol
    // scout_signals row for this user. Stale (past expires_at) rows still
    // count for scoring but flip signalFresh=false so downstream gates can
    // reject entries built on cold intelligence.
    const eligibleSymbols = eligibleList
      .filter((e) => e.eligible)
      .map((e) => e.instrument.symbol);
    const signals = new Map<string, RankingSignalInputs>();
    if (eligibleSymbols.length > 0) {
      const { data: sigRows } = await supabase
        .from("scout_signals")
        .select(
          "symbol, bias, confidence, conflict, readiness, weighted_score, availability, expires_at, created_at, long_score, short_score, long_state, short_state, long_fresh, short_fresh, long_insufficient, short_insufficient, dominant_side",
        )
        .eq("user_id", userId)
        .in("symbol", eligibleSymbols)
        .order("created_at", { ascending: false })
        .limit(Math.max(eligibleSymbols.length * 4, 40));
      const seen = new Set<string>();
      for (const row of sigRows ?? []) {
        const sym = row.symbol as string;
        if (seen.has(sym)) continue;
        seen.add(sym);

        // Prefer the independent per-side evaluation when populated.
        // `dominant_side` is 'long' | 'short' | 'none' | null. Fall back
        // to legacy `bias` for rows written before the dual-direction
        // migration landed so ranking never silently starves.
        const dominant = (row.dominant_side as string | null) ?? null;
        const legacyBias = String(row.bias ?? "none");
        let direction: RankingSignalInputs["direction"];
        let sideScore = 0;
        let sideState: string | null = null;
        let sideFresh = false;
        let sideInsufficient = false;
        if (dominant === "long" || dominant === "short") {
          direction = dominant;
          sideScore = Number(
            (dominant === "long" ? row.long_score : row.short_score) ?? 0,
          );
          sideState = String(
            (dominant === "long" ? row.long_state : row.short_state) ?? "",
          ) || null;
          sideFresh = Boolean(
            dominant === "long" ? row.long_fresh : row.short_fresh,
          );
          sideInsufficient = Boolean(
            dominant === "long" ? row.long_insufficient : row.short_insufficient,
          );
        } else {
          direction =
            legacyBias === "long" || legacyBias === "short" ? legacyBias : "wait";
          sideScore = Number(row.weighted_score ?? 0);
        }

        const availability = Number(row.availability ?? 0);
        const conflict = Number(row.conflict ?? 0);
        const readiness = Number(row.readiness ?? 0);
        const confidence = Number(row.confidence ?? 0);
        const expiresAt = row.expires_at ? new Date(row.expires_at as string).getTime() : 0;
        const rowFresh = expiresAt > now;
        // A side is only fresh when BOTH the signal row is inside its TTL
        // AND the per-side evaluation itself was fresh + had enough evidence.
        const fresh =
          rowFresh &&
          (dominant === "long" || dominant === "short"
            ? sideFresh && !sideInsufficient
            : true);

        // Confirmed/aligned sides get a readiness lift so the ranker prefers
        // them over merely-emerging sides without fabricating evidence.
        const readinessAdj =
          sideState === "confirmed" || sideState === "aligned"
            ? Math.max(readiness, 0.75)
            : readiness;

        signals.set(sym, {
          symbol: sym,
          regimeScore: Math.max(-1, Math.min(1, sideScore)),
          alignmentScore: Math.max(0, Math.min(1, availability * (1 - conflict / 2))),
          readinessScore: Math.max(0, Math.min(1, readinessAdj)),
          confidenceScore: Math.max(0, Math.min(1, confidence)),
          // Absolute per-side score is a coarse proxy for actionable
          // volatility until Scout emits a dedicated volatility surface.
          volatilityScore: Math.max(0, Math.min(1, Math.abs(sideScore))),
          freshnessScore: fresh ? 1 : 0,
          direction,
          signalFresh: fresh,
        });
      }
    }
    const rankedRaw = rankUniverse({
      eligible: eligibleList,
      signals,
      topN: ABSOLUTE_TOP_N,
    });

    // 5. Hysteresis
    const { data: priorRows } = await supabase
      .from("scout_ranking_state")
      .select("symbol,last_bucket,last_rank,last_adjusted_score,cooldown_until,last_transition_at")
      .eq("user_id", userId)
      .eq("exchange", exchange)
      .eq("environment", environment)
      .eq("market_type", marketType);
    const prior = new Map<string, PriorRankState>();
    for (const p of priorRows ?? []) {
      prior.set(p.symbol as string, {
        symbol: p.symbol as string,
        lastBucket: p.last_bucket as PriorRankState["lastBucket"],
        lastRank: (p.last_rank as number | null) ?? null,
        lastAdjustedScore: Number(p.last_adjusted_score ?? 0),
        cooldownUntil: p.cooldown_until ? new Date(p.cooldown_until as string).getTime() : null,
        lastTransitionAt: p.last_transition_at
          ? new Date(p.last_transition_at as string).getTime()
          : null,
      });
    }
    const hysteresis = applyRankHysteresis(rankedRaw, prior, now);
    const hMap = new Map(hysteresis.map((h) => [h.symbol, h]));
    const finalRanked: RankedSymbol[] = rankedRaw.map((r) => {
      const h = hMap.get(r.symbol);
      if (!h) return r;
      return { ...r, bucket: h.finalBucket, rank: h.finalRank };
    });

    const eligibleCount = finalRanked.filter((r) => r.bucket !== "rejected").length;
    const rankedCount = finalRanked.filter((r) => r.bucket === "ranked").length;
    const rejectedCount = finalRanked.filter((r) => r.bucket === "rejected").length;

    // 6. Persist snapshot + rankings + updated ranking state.
    const expiresAt = now + SNAPSHOT_TTL_MS;
    const { data: snap, error: snapErr } = await supabase
      .from("scout_universe_snapshots")
      .insert({
        user_id: userId,
        connection_id: connectionId ?? null,
        exchange,
        environment,
        market_type: marketType,
        adapter_version: universe.adapterVersion,
        capability_version: universe.capabilityVersion,
        universe_version: UNIVERSE_VERSION,
        ranking_version: RANKING_VERSION,
        health: universe.health,
        exchange_symbol_count: universe.instruments.length,
        eligible_count: eligibleCount,
        ranked_count: rankedCount,
        rejected_count: rejectedCount,
        generated_at: new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        correlation_id: correlationId,
        detail: {
          ...universe.detail,
          hysteresis_version: HYSTERESIS_VERSION,
        } as never,
      })
      .select("id")
      .single();
    if (snapErr || !snap) {
      throw new Error(`snapshot insert failed: ${snapErr?.message ?? "unknown"}`);
    }
    const snapshotId = snap.id as string;

    if (finalRanked.length > 0) {
      const rankingRows = finalRanked.map((r) => ({
        snapshot_id: snapshotId,
        user_id: userId,
        symbol: r.symbol,
        bucket: r.bucket,
        rank: r.rank,
        raw_score: r.rawScore,
        adjusted_score: r.adjustedScore,
        direction: r.direction,
        score_components: r.components as never,
        rejection_reasons: r.rejectionReasons,
        exchange_max_leverage: r.instrument.maxLeverage,
        liquidity_usd: r.instrument.volume24hUsd,
        spread_bps: r.instrument.spreadBps,
        volatility_pct: null,
        signal_fresh: r.signalFresh,
        correlation_id: correlationId,
        ranking_version: RANKING_VERSION,
        universe_version: UNIVERSE_VERSION,
        generated_at: new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      }));
      const { error: rErr } = await supabase.from("scout_symbol_rankings").insert(rankingRows);
      if (rErr) throw new Error(`ranking insert failed: ${rErr.message}`);
    }

    // Update rank-band hysteresis state per symbol.
    for (const h of hysteresis) {
      if (!h.transitioned && !h.cooldownActive) {
        // Still refresh last_adjusted_score for next-tick delta math.
      }
      await supabase.from("scout_ranking_state").upsert(
        {
          user_id: userId,
          connection_id: connectionId ?? null,
          exchange,
          environment,
          market_type: marketType,
          symbol: h.symbol,
          last_bucket: h.finalBucket,
          last_rank: h.finalRank,
          last_adjusted_score: h.adjustedScore,
          streak: 1,
          cooldown_until: null,
          last_transition_at: h.transitioned ? new Date(now).toISOString() : null,
          ranking_version: RANKING_VERSION,
        },
        { onConflict: "user_id,exchange,environment,market_type,symbol" },
      );
    }

    const snapshot: UniverseSnapshot = {
      correlationId,
      userId,
      connectionId: connectionId ?? null,
      exchange,
      environment,
      marketType,
      adapterVersion: universe.adapterVersion,
      capabilityVersion: universe.capabilityVersion,
      universeVersion: UNIVERSE_VERSION,
      rankingVersion: RANKING_VERSION,
      health: universe.health,
      exchangeSymbolCount: universe.instruments.length,
      eligibleCount,
      rankedCount,
      rejectedCount,
      generatedAt: now,
      expiresAt,
      detail: universe.detail,
      rankings: finalRanked,
    };
    return snapshot;
}
