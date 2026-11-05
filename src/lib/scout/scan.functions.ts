/**
 * Scout fleet scan — READ-ONLY intelligence server function (Stage 2).
 *
 * Wires Stage 1 pure modules into a persisted scan:
 *  - Fetches MTF candles (RLS-safe, public ApeX; no execution).
 *  - Computes per-TF `CompactEvidence` (deterministic, versioned).
 *  - Feeds MTF consensus.
 *  - Applies capped market context (BTC/ETH bias, breadth, BTC correlation).
 *  - Reduces the signal-state machine (WATCHING…INVALIDATED).
 *  - Persists everything through `scout_persist_scan` (SECURITY DEFINER, atomic,
 *    version-checked, per-caller ownership-verified).
 *
 * Never touches paper engine, orders, wallets, execution or LLM.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { scoreTimeframe } from "./intelligence";
import { computeConsensus } from "./consensus";
import { applyHysteresis, type BiasState } from "./hysteresis";
import { sharedMarketCache } from "./marketCache";
import { buildEvidence, type CompactEvidence, type EvidenceDirection } from "./evidence";
import { reduceState, INITIAL_STATE, type CurrentState, type SignalState } from "./state";
import { anchorBiasFrom, closesOf, computeBreadth, computeContext } from "./context";
import { classifyMarketRegime } from "./regime";
import { EVIDENCE_SCHEMA_VERSION, RULES_VERSION, STATE_SCHEMA_VERSION } from "./versions";

import {
  TIMEFRAMES,
  TIMEFRAME_TTL_MS,
  type Bias,
  type ScoutFleetReport,
  type ScoutHealth,
  type ScoutSymbolReport,
  type Timeframe,
  type TimeframeState,
} from "./types";
import { selectScanUniverse } from "./scanScope";
import { buildDualSidePayload } from "./dualSideAdapter";

const CANONICAL_ANCHORS = ["BTC-USDT", "ETH-USDT"] as const;

function missingScoutPersistence(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /scout_(preferences|scans|bias_state|signal_state|signals|evidence|rotation_state)|schema cache|does not exist/i.test(
      error.message ?? "",
    )
  );
}

function baseOf(symbol: string): string {
  const i = symbol.indexOf("-");
  return i > 0 ? symbol.slice(0, i) : symbol;
}

function minuteBucket(now = Date.now()): string {
  const d = new Date(Math.floor(now / 60_000) * 60_000);
  return d.toISOString();
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface SymbolWork {
  symbol: string;
  perTf: TimeframeState[];
  evidenceByTf: Map<Timeframe, CompactEvidence>;
  consensus: ReturnType<typeof computeConsensus>;
  closesM5: number[];
  hysteresized: Bias;
}

export const runScoutScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ScoutFleetReport> => {
    const { supabase, userId } = context;
    const startedAt = Date.now();

    const { data: pref, error: prefError } = await supabase
      .from("scout_preferences")
      .select("active")
      .eq("user_id", userId)
      .maybeSingle();
    // Internal-company testing defaults Scout ON when a user has never made
    // an explicit choice. An existing `active = false` preference is still
    // respected, so the user-controlled off switch remains authoritative.
    if (prefError && !missingScoutPersistence(prefError)) {
      throw new Error(`scout preference read failed: ${prefError.message}`);
    }
    if (pref?.active === false) {
      return {
        scanId: null,
        startedAt,
        finishedAt: startedAt,
        symbols: [],
        health: "offline",
        nextRefreshAt: startedAt + 60_000,
      };
    }

    // Internal release scope is the exact shared four-symbol allowlist.
    const scope = await selectScanUniverse({ supabase, userId, now: startedAt });
    const universeSet = new Set<string>(scope.symbols);
    const universe = [...universeSet].sort();

    const bucket = minuteBucket(startedAt);
    const { data: scanRow, error: scanErr } = await supabase
      .from("scout_scans")
      .upsert(
        {
          user_id: userId,
          minute_bucket: bucket,
          symbol_count: universe.length,
          health: "healthy",
        },
        { onConflict: "user_id,minute_bucket", ignoreDuplicates: false },
      )
      .select("id, started_at")
      .single();
    let persistenceAvailable = true;
    if (missingScoutPersistence(scanErr)) persistenceAvailable = false;
    else if (scanErr || !scanRow) {
      throw new Error(`scan row failed: ${scanErr?.message ?? "unknown"}`);
    }
    // Older production deployments never received the Scout ledger tables.
    // Continue the read-only analysis in stateless mode rather than showing
    // Scout as OFF. No execution path depends on these persistence writes.
    const scanId = persistenceAvailable && scanRow ? (scanRow.id as string) : crypto.randomUUID();

    const { data: priorBias } = persistenceAvailable
      ? await supabase
          .from("scout_bias_state")
          .select("symbol, bias, streak, last_score")
          .eq("user_id", userId)
      : { data: null };
    const priorMap = new Map<string, BiasState>();
    for (const row of priorBias ?? []) {
      priorMap.set(row.symbol as string, {
        bias: row.bias as Bias,
        streak: Number(row.streak ?? 1),
        lastScore: Number(row.last_score ?? 0),
      });
    }

    const cache = sharedMarketCache();
    const now = startedAt;

    // Pass 1: compute evidence per (symbol, tf) locally.
    const workBySymbol = new Map<string, SymbolWork>();

    await mapLimit(universe, 4, async (symbol) => {
      const perTf: TimeframeState[] = [];
      const evidenceByTf = new Map<Timeframe, CompactEvidence>();
      let closesM5: number[] = [];
      for (const tf of TIMEFRAMES) {
        try {
          const candles = await cache.getCandles(symbol, tf, now);
          const state = scoreTimeframe(tf, candles, now);
          perTf.push(state);
          const ev = buildEvidence({ symbol, timeframe: tf, candles, now });
          evidenceByTf.set(tf, ev);
          if (tf === "M5") closesM5 = closesOf(candles);
        } catch {
          perTf.push({
            tf,
            state: "unavailable",
            score: 0,
            lastClosedTs: null,
            ageMs: null,
            stale: true,
            reasons: ["stale_data"],
          });
          evidenceByTf.set(tf, buildEvidence({ symbol, timeframe: tf, candles: [], now }));
        }
      }
      const consensus = computeConsensus(perTf);
      const hys = applyHysteresis({
        prev: priorMap.get(symbol) ?? null,
        proposedBias: consensus.bias,
        proposedScore: consensus.weightedScore,
      });
      workBySymbol.set(symbol, {
        symbol,
        perTf,
        evidenceByTf,
        consensus,
        closesM5,
        hysteresized: hys.bias,
      });
    });

    // Pass 2: fleet breadth + anchor bias for context adjustment.
    const btcWork = workBySymbol.get("BTC-USDT");
    const ethWork = workBySymbol.get("ETH-USDT");
    const anchors = {
      btc: anchorBiasFrom(btcWork?.evidenceByTf.get("D") ?? null),
      eth: anchorBiasFrom(ethWork?.evidenceByTf.get("D") ?? null),
    };
    const breadth = computeBreadth([...workBySymbol.values()].map((w) => w.hysteresized));
    const btcClosesM5 = btcWork?.closesM5 ?? [];

    // Pass 3: load prior state-machine states in one query.
    const { data: priorStates } = persistenceAvailable
      ? await supabase
          .from("scout_signal_state")
          .select(
            "symbol, state, direction, weighted_score, aligned_streak, entered_at, prior_state, reason_codes, last_scan_id",
          )
          .eq("user_id", userId)
      : { data: null };
    const priorStateMap = new Map<string, CurrentState>();
    for (const row of priorStates ?? []) {
      priorStateMap.set(row.symbol as string, {
        state: row.state as SignalState,
        direction: (row.direction as EvidenceDirection) ?? "none",
        entered_at: row.entered_at ? new Date(row.entered_at as string).getTime() : 0,
        prior_state: (row.prior_state as SignalState | null) ?? null,
        last_scan_id: (row.last_scan_id as string | null) ?? null,
        aligned_streak: Number(row.aligned_streak ?? 0),
        last_score: Number(row.weighted_score ?? 0),
        reason_codes: (row.reason_codes as string[] | null as CurrentState["reason_codes"]) ?? [],
      });
    }

    // Pass 4: insert signals (need signal_id for evidence FK), then call RPC to persist.
    const reports: ScoutSymbolReport[] = [];
    const persistEntries: unknown[] = [];
    let anyStale = false;
    let anyOffline = false;

    for (const [symbol, w] of workBySymbol) {
      const ctx = computeContext({
        symbol,
        proposedBias: w.consensus.bias,
        proposedScore: w.consensus.weightedScore,
        fleet: breadth,
        anchors,
        symbolCloses: w.closesM5,
        btcCloses: btcClosesM5,
      });
      const finalScore = Math.max(-1, Math.min(1, w.consensus.weightedScore + ctx.adjust));
      const finalConsensus = {
        ...w.consensus,
        bias: w.hysteresized,
        weightedScore: finalScore,
        confidence: Math.max(
          0,
          Math.min(
            1,
            Math.abs(finalScore) * w.consensus.availability * (1 - w.consensus.conflict / 2),
          ),
        ),
      };

      const anchor = (CANONICAL_ANCHORS as readonly string[]).includes(symbol);
      // Anchors are market-context inputs AND tradeable symbols. BTC, ETH,
      // SOL, and XRP all pass through the same strategy eligibility path.
      const paperEnabled = universeSet.has(symbol);
      const higherDegraded = w.perTf.some(
        (s) => (s.tf === "H4" || s.tf === "D") && (s.state === "unavailable" || s.stale),
      );
      if (higherDegraded) anyStale = true;
      const anyDataMissing = w.perTf.every((s) => s.state === "unavailable");
      if (anyDataMissing) anyOffline = true;
      // Bumped from 5m → 15m so a fresh signal survives at least one
      // missed paper tick (cron minute skew, transient slot pressure)
      // and the Scout→Onyx handoff has room to breathe.
      const expiresAt = now + Math.max(TIMEFRAME_TTL_MS.M5, 15 * 60_000);

      // Reduce state + classify regime BEFORE inserting scout_signals so the
      // insert can persist market_regime atomically. The immutable-core
      // trigger locks these columns after first write.
      const h4 = w.evidenceByTf.get("H4");
      const d = w.evidenceByTf.get("D");
      const htfValid =
        !!(h4 && h4.data_quality.fresh && h4.data_quality.candle_count >= 55) &&
        !!(d && d.data_quality.fresh && d.data_quality.candle_count >= 55);
      const h1 = w.evidenceByTf.get("H1");
      const m15 = w.evidenceByTf.get("M15");
      const m5 = w.evidenceByTf.get("M5");
      const dirs = [h1?.direction, m15?.direction, m5?.direction].filter(
        Boolean,
      ) as EvidenceDirection[];
      const ltfAligned = dirs.length === 3 && dirs.every((x) => x === dirs[0] && x !== "none");
      const alignedDirection: EvidenceDirection = ltfAligned ? dirs[0] : "none";
      const prior = priorStateMap.get(symbol) ?? INITIAL_STATE;
      const structureBroken =
        (prior.direction === "long" &&
          (m5?.structure.bos === "down" || m15?.structure.bos === "down")) ||
        (prior.direction === "short" &&
          (m5?.structure.bos === "up" || m15?.structure.bos === "up")) ||
        false;
      const dBias: EvidenceDirection = d?.direction ?? "none";
      const htfFlipped =
        (prior.direction === "long" && dBias === "short") ||
        (prior.direction === "short" && dBias === "long");

      const reduced = reduceState(prior, {
        scan_id: scanId,
        now,
        weighted_score: finalScore,
        htf_valid: htfValid,
        ltf_aligned: ltfAligned,
        aligned_direction: alignedDirection,
        structure_broken: structureBroken,
        htf_flipped: htfFlipped,
      });

      // P1 — Scout intelligence-plane market regime.
      const scanHealth: import("./types").ScoutHealth = anyDataMissing
        ? "offline"
        : higherDegraded
          ? "degraded"
          : "healthy";
      const regimeEvidence = classifyMarketRegime({
        consensus: finalConsensus,
        signalDirection: reduced.next.direction,
        signalState: reduced.next.state,
        stateReasonCodes: reduced.next.reason_codes ?? [],
        htfValid,
        health: scanHealth,
        // Open-position awareness lands in P3.
        openPositionDirection: null,
      });

      reports.push({
        symbol,
        base: baseOf(symbol),
        anchor,
        paperEnabled,
        timeframes: w.perTf,
        consensus: finalConsensus,
        expiresAt,
        degraded: higherDegraded,
        error: null,
        marketRegime: regimeEvidence.regime,
        regimeEvidence,
      });

      // Compute independent Offense/Defense (long/short) evaluations from
      // the SAME evidence map the consensus uses — no re-fetch, no
      // fabrication. `dualDirection` guarantees fresh/confirmed is only set
      // when aligned-tf count + weighted score both clear their thresholds.
      const dualPayload = buildDualSidePayload(w.evidenceByTf);

      // Insert one signal row per symbol (idempotent by (user, scan, symbol)).
      const { data: sigRow, error: sigErr } = persistenceAvailable
        ? await supabase
            .from("scout_signals")
            .upsert(
              {
                user_id: userId,
                scan_id: scanId,
                symbol,
                bias: finalConsensus.bias,
                confidence: finalConsensus.confidence,
                conflict: w.consensus.conflict,
                readiness: finalConsensus.readiness,
                weighted_score: finalConsensus.weightedScore,
                availability: w.consensus.availability,
                expires_at: new Date(expiresAt).toISOString(),
                market_regime: regimeEvidence.regime,
                regime_evidence: regimeEvidence as never,
                regime_schema_version: regimeEvidence.schemaVersion,
                // Dual-direction persistence (Offense/Defense independent).
                long_score: dualPayload.long_score,
                short_score: dualPayload.short_score,
                long_state: dualPayload.long_state,
                short_state: dualPayload.short_state,
                long_aligned_tfs: dualPayload.long_aligned_tfs,
                short_aligned_tfs: dualPayload.short_aligned_tfs,
                long_reason_codes: dualPayload.long_reason_codes,
                short_reason_codes: dualPayload.short_reason_codes,
                long_fresh: dualPayload.long_fresh,
                short_fresh: dualPayload.short_fresh,
                long_insufficient: dualPayload.long_insufficient,
                short_insufficient: dualPayload.short_insufficient,
                dominant_side: dualPayload.dominant_side,
              },
              { onConflict: "user_id,scan_id,symbol" },
            )
            .select("id")
            .single()
        : { data: null, error: null };
      const signalId = sigRow ? (sigRow.id as string) : null;

      // Assemble persistence entry for the RPC.
      if (signalId && !sigErr) {
        const evidenceRows = [...w.evidenceByTf.entries()].map(([tf, ev]) => ({
          timeframe: tf,
          state: w.perTf.find((s) => s.tf === tf)?.state ?? "unavailable",
          score: ev.score,
          reasons: ev.reason_codes,
          stale: !ev.data_quality.fresh,
          direction: ev.direction,
          weighted_score: ev.score,
          evidence: ev,
          candle_count: ev.data_quality.candle_count,
          last_closed_ts_ms: ev.data_quality.last_closed_ts,
          age_ms: ev.data_quality.age_ms,
          fresh: ev.data_quality.fresh,
          missing_fields: ev.data_quality.missing_fields,
        }));

        persistEntries.push({
          symbol,
          signal_id: signalId,
          evidence: evidenceRows,
          next_state: {
            state: reduced.next.state,
            direction: reduced.next.direction,
            weighted_score: reduced.next.last_score,
            aligned_streak: reduced.next.aligned_streak,
            entered_at_ms: reduced.next.entered_at,
            prior_state: reduced.next.prior_state,
            reason_codes: reduced.next.reason_codes,
            state_schema_version: STATE_SCHEMA_VERSION,
          },
          transition: reduced.transition
            ? {
                from: reduced.transition.from,
                to: reduced.transition.to,
                direction: reduced.transition.direction,
                weighted_score: reduced.transition.weighted_score,
                reason_codes: reduced.transition.reason_codes,
                state_schema_version: reduced.transition.state_schema_version,
              }
            : null,
        });
      }

      // Hysteresis persistence (legacy bias table used by UI header).
      if (persistenceAvailable)
        await supabase.from("scout_bias_state").upsert(
          {
            user_id: userId,
            symbol,
            bias: w.hysteresized,
            streak: 1,
            last_score: finalScore,
            updated_at: new Date(now).toISOString(),
          },
          { onConflict: "user_id,symbol" },
        );
    }

    // Stage 2 evidence persistence is gated behind a server-only feature
    // flag until the two-user RLS integration test can execute in the
    // hosted harness. Without persistence Scout still evaluates, displays
    // market state, and returns per-symbol reasoning — only the durable
    // evidence write-back is suppressed. Fail-closed default is OFF.
    const { scoutStage2PersistEnabled } = await import("./stage2-flag");
    if (persistEntries.length && scoutStage2PersistEnabled()) {
      // `scout_persist_scan` is SECURITY DEFINER, executable only by service_role.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: rpcErr } = await supabaseAdmin.rpc("scout_persist_scan", {
        _scan_id: scanId,
        _now_ms: now,
        _evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
        _rules_version: RULES_VERSION,
        _entries: persistEntries as never,
      });
      if (rpcErr) {
        throw new Error(`persist rpc failed: ${rpcErr.message}`);
      }
    }

    const finishedAt = Date.now();
    const health: ScoutHealth = anyOffline ? "offline" : anyStale ? "degraded" : "healthy";

    if (persistenceAvailable) {
      await supabase
        .from("scout_scans")
        .update({ finished_at: new Date(finishedAt).toISOString(), health })
        .eq("id", scanId);
    }

    // Persist rotation telemetry so the next tick advances the cursor and
    // the UI can render true discovered / eligible / scanned / next-rotation
    // counters. Best-effort; failures never block the scan.
    try {
      const rankedCount = reports.filter((r) => {
        const b = r.consensus?.bias;
        return b === "long-priority" || b === "short-priority";
      }).length;
      const freshCovered = reports.filter((r) => !r.degraded).length;
      if (persistenceAvailable)
        await supabase.from("scout_rotation_state").upsert(
          {
            user_id: userId,
            exchange: "apex",
            environment: "paper",
            market_type: "paper",
            last_cursor: scope.cursor,
            next_rotation: scope.nextCursor,
            discovered_count: scope.discoveredCount,
            eligible_count: scope.eligibleCount,
            rejected_count: scope.rejectedCount,
            scanned_this_cycle: scope.scannedThisCycle,
            fresh_covered_count: freshCovered,
            ranked_count: rankedCount,
            last_snapshot_id: scope.snapshotId,
            last_scan_id: scanId,
            detail: {
              source: scope.source,
              coverage_count: scope.coverageCount,
              batch_size: scope.symbols.length,
            },
            updated_at: new Date(finishedAt).toISOString(),
          },
          { onConflict: "user_id,exchange,environment,market_type" },
        );
    } catch {
      /* silent — telemetry only */
    }

    // Ops correlation event — read-only, best-effort.
    try {
      const { emitOpsEvent } = await import("@/lib/ops/emit");
      const { newCorrelationId } = await import("@/lib/ops/correlation");
      await emitOpsEvent(supabase, {
        correlation_id: newCorrelationId(),
        stage: "scout_scan",
        component: "scout",
        severity: health === "offline" ? "error" : health === "degraded" ? "warn" : "info",
        message: `scan ${scanId} ${health} — ${reports.length} symbols`,
        detail: { scan_id: scanId, health, symbols: reports.length },
        latency_ms: finishedAt - startedAt,
      });
    } catch {
      /* silent */
    }

    reports.sort((a, b) => {
      if (a.anchor !== b.anchor) return a.anchor ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });

    return {
      scanId,
      startedAt,
      finishedAt,
      symbols: reports,
      health,
      nextRefreshAt: finishedAt + 60_000,
    };
  });
