/**
 * One-shot activation script: seeds 10 paper_execution_slots (idempotent),
 * runs the real ApeX Omni discovery cycle through the shipped adapter +
 * eligibility + ranking + hysteresis modules, then persists a snapshot,
 * rankings and ranking-state for the owner scope using the Supabase
 * service role. Zero entry intents are produced.
 *
 * Scope: user 0b7b1651-…, exchange="apex", environment="paper", market_type="paper".
 * The verified ApeX Omni connection (id e95c60f7…) is recorded on
 * connection_id for the snapshot for auditability but is otherwise unused.
 */
import { createClient } from "@supabase/supabase-js";
import { apexOmniAdapter } from "../src/lib/universe/adapters/apex";
import { DEFAULT_ELIGIBILITY, filterEligibility } from "../src/lib/universe/eligibility";
import { resolveOverrides } from "../src/lib/universe/overrides";
import { rankUniverse } from "../src/lib/universe/ranking";
import { applyRankHysteresis } from "../src/lib/universe/hysteresis";
import {
  HYSTERESIS_VERSION,
  RANKING_VERSION,
  UNIVERSE_VERSION,
} from "../src/lib/universe/versions";

const OWNER_USER_ID = "0b7b1651-b3a5-4370-b89f-0deeaba4ea3f";
const APEX_CONNECTION_ID = "e95c60f7-aba5-4353-b4a5-3cd13cc6cad1";
const EXCHANGE = "apex";
const ENVIRONMENT = "paper" as const;
const MARKET_TYPE = "paper" as const;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const TOP_N = 10;

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => {
      const h = new Headers(init?.headers);
      if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
      h.set("apikey", key);
      h.set("Authorization", `Bearer ${key}`);
      return fetch(input, { ...init, headers: h });
    },
  },
});

async function ensureSlots(): Promise<{ before: number; after: number }> {
  const { data: existingRows } = await sb
    .from("paper_execution_slots")
    .select("slot_index")
    .eq("user_id", OWNER_USER_ID)
    .eq("exchange", EXCHANGE)
    .eq("environment", ENVIRONMENT)
    .eq("market_type", MARKET_TYPE);
  const existing = new Set((existingRows ?? []).map((r) => Number(r.slot_index)));
  const before = existing.size;
  const rows: any[] = [];
  for (let i = 1; i <= 10; i += 1) {
    if (existing.has(i)) continue;
    rows.push({
      user_id: OWNER_USER_ID,
      connection_id: APEX_CONNECTION_ID,
      exchange: EXCHANGE,
      environment: ENVIRONMENT,
      market_type: MARKET_TYPE,
      slot_index: i,
    });
  }
  if (rows.length > 0) {
    const { error } = await sb.from("paper_execution_slots").insert(rows);
    if (error) throw new Error(`slot insert: ${error.message}`);
  }
  return { before, after: before + rows.length };
}

async function runDiscovery() {
  const now = Date.now();
  const correlationId = crypto.randomUUID();

  const universe = await apexOmniAdapter.discover({
    environment: ENVIRONMENT,
    marketType: "futures",
    now,
  });
  console.log(`[apex] health=${universe.health} instruments=${universe.instruments.length}`);

  const overrides = resolveOverrides([], now);
  const eligibleList = filterEligibility(universe, overrides, DEFAULT_ELIGIBILITY, now);
  const rankedRaw = rankUniverse({ eligible: eligibleList, signals: new Map(), topN: TOP_N });
  const finalRanked = applyRankHysteresis(rankedRaw, new Map(), now);
  const hMap = new Map(finalRanked.map((h) => [h.symbol, h]));
  const persisted = rankedRaw.map((r) => {
    const h = hMap.get(r.symbol);
    return h ? { ...r, bucket: h.finalBucket, rank: h.finalRank } : r;
  });

  const eligibleCount = persisted.filter((r) => r.bucket !== "rejected").length;
  const rankedCount = persisted.filter((r) => r.bucket === "ranked").length;
  const rejectedCount = persisted.filter((r) => r.bucket === "rejected").length;
  console.log(`[filter] eligible=${eligibleCount} ranked=${rankedCount} rejected=${rejectedCount}`);

  const expiresAt = now + SNAPSHOT_TTL_MS;
  const { data: snap, error: snapErr } = await sb
    .from("scout_universe_snapshots")
    .insert({
      user_id: OWNER_USER_ID,
      connection_id: APEX_CONNECTION_ID,
      exchange: EXCHANGE,
      environment: ENVIRONMENT,
      market_type: MARKET_TYPE,
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
      detail: { ...universe.detail, hysteresis_version: HYSTERESIS_VERSION, source: "one_shot_activation" },
    })
    .select("id")
    .single();
  if (snapErr || !snap) throw new Error(`snapshot insert: ${snapErr?.message}`);
  const snapshotId = snap.id as string;

  if (persisted.length > 0) {
    const rankingRows = persisted.map((r) => ({
      snapshot_id: snapshotId,
      user_id: OWNER_USER_ID,
      symbol: r.symbol,
      bucket: r.bucket,
      rank: r.rank,
      raw_score: r.rawScore,
      adjusted_score: r.adjustedScore,
      direction: r.direction,
      score_components: r.components as any,
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
    for (let i = 0; i < rankingRows.length; i += 500) {
      const chunk = rankingRows.slice(i, i + 500);
      const { error } = await sb.from("scout_symbol_rankings").insert(chunk);
      if (error) throw new Error(`rankings insert: ${error.message}`);
    }
  }

  for (const h of finalRanked) {
    const { error } = await sb.from("scout_ranking_state").upsert(
      {
        user_id: OWNER_USER_ID,
        connection_id: APEX_CONNECTION_ID,
        exchange: EXCHANGE,
        environment: ENVIRONMENT,
        market_type: MARKET_TYPE,
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
    if (error) throw new Error(`ranking_state upsert (${h.symbol}): ${error.message}`);
  }

  return {
    snapshotId,
    correlationId,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    exchangeSymbolCount: universe.instruments.length,
    eligibleCount,
    rankedCount,
    rejectedCount,
    top: persisted.filter((r) => r.bucket === "ranked").slice(0, 12).map((r) => ({
      symbol: r.symbol,
      rank: r.rank,
      direction: r.direction,
      score: Number(r.adjustedScore.toFixed(4)),
    })),
    topRejectReasons: (() => {
      const counts = new Map<string, number>();
      for (const r of persisted) if (r.bucket === "rejected") for (const x of r.rejectionReasons) counts.set(x, (counts.get(x) ?? 0) + 1);
      return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    })(),
  };
}

async function main() {
  const slots = await ensureSlots();
  console.log("slots", slots);
  const disc = await runDiscovery();
  console.log(JSON.stringify(disc, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
