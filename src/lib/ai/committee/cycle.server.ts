/**
 * SCOUT-WIDE COMMITTEE CYCLE — server-only orchestrator.
 *
 * One deterministic pass per closed 15-minute candle, per book:
 *
 *   1. Verify the internal-test symbols against the venue adapter.
 *   2. Derive a deterministic read per symbol from real candles.
 *   3. Prefilter (liquidity, spread, volatility, staleness, precision,
 *      capacity, duplicate suppression) BEFORE spending model budget.
 *   4. Fan the survivors out to the three strategist seats, bounded by
 *      concurrency, a per-candidate timeout and a circuit breaker.
 *   5. Fan in, normalize and rank the whole shortlist against itself.
 *   6. Persist the cycle, every candidate, every rejection reason and the
 *      single selection (or an explicit NO TRADE reason).
 *
 * AUTHORITY: NONE. This module never opens, sizes, cancels or closes anything.
 * It writes only `committee_cycles` and `committee_shortlist`. The selected
 * candidate is a *proposal*; every downstream gate still applies.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUniverseAdapter } from "@/lib/universe/adapters/registry";
import { fetchApexKlines } from "@/lib/paper/feed";
import { deriveCycleSignal, type OHLCV } from "@/lib/ai/cycleSignals";
import {
  PREFILTER_POLICY,
  SHORTLIST_STRATEGY_VERSION,
  cycleKeyFor,
  prefilterCandidates,
  rankShortlist,
  type Direction,
  type PrefilterCandidate,
  type ReviewedCandidate,
  type SeatDecision,
} from "@/lib/ai/shortlist";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";
import { buildEntryPlan, GEOMETRY_VERSION, type EntryPlan } from "@/lib/ai/entryGeometry";
import {
  DEFAULT_PAPER_SYMBOLS,
  EXECUTION_INTERVAL_MIN,
  SCAN_UNIVERSE_SIZE,
} from "@/lib/paper/constants";

export const CYCLE_MS = EXECUTION_INTERVAL_MIN * 60_000;

/** Bounds that keep one cycle inside a single scheduler minute budget. */
export const CYCLE_LIMITS = {
  /** Symbols whose candles we fetch before prefiltering. */
  maxCandleFetch: SCAN_UNIVERSE_SIZE,
  candleConcurrency: 5,
  /** Strategist fan-out concurrency. */
  reviewConcurrency: 3,
  /** Per-candidate committee timeout. */
  reviewTimeoutMs: 45_000,
  /** Consecutive review failures that trip the breaker for the rest of the cycle. */
  breakerThreshold: 3,
  /** Whole-cycle soft deadline; remaining candidates are left unreviewed. */
  cycleDeadlineMs: 150_000,
} as const;

export interface CycleSummary {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  cycleId: string | null;
  cycleKey: string;
  universeSize: number;
  candidateCount: number;
  reviewedCount: number;
  seatResponseCount: number;
  selectedSymbol: string | null;
  selectedDirection: string | null;
  selectedScore: number | null;
  noTradeReason: string | null;
  breakerTripped: boolean;
  durationMs: number;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Last fully closed 15-minute boundary at `now`. */
export function lastClosedCycleMs(now: number): number {
  return Math.floor(now / CYCLE_MS) * CYCLE_MS;
}

interface RunOpts {
  book?: "paper" | "live";
  now?: number;
  maxBatch?: number;
  /** Test/ops override: skip model calls and record every seat unavailable. */
  dryRun?: boolean;
}

export async function runCommitteeCycle(
  admin: SupabaseClient,
  userId: string,
  opts: RunOpts = {},
): Promise<CycleSummary> {
  const started = Date.now();
  const now = opts.now ?? started;
  const book = opts.book ?? "paper";
  const candleCloseMs = lastClosedCycleMs(now);
  const cycleKey = cycleKeyFor(candleCloseMs, book);

  const base: CycleSummary = {
    ok: true,
    skipped: false,
    cycleId: null,
    cycleKey,
    universeSize: 0,
    candidateCount: 0,
    reviewedCount: 0,
    seatResponseCount: 0,
    selectedSymbol: null,
    selectedDirection: null,
    selectedScore: null,
    noTradeReason: null,
    breakerTripped: false,
    durationMs: 0,
  };
  const referenceBySymbol = new Map<string, { price: number; candleCloseMs: number }>();

  // ---- 1. Single selection pass per cycle (durable, not in-memory). -------
  const cycleIns = await admin
    .from("committee_cycles")
    .insert({
      user_id: userId,
      cycle_key: cycleKey,
      book,
      candle_close_at: new Date(candleCloseMs).toISOString(),
      status: "reviewing",
      strategy_version: SHORTLIST_STRATEGY_VERSION,
      geometry_version: GEOMETRY_VERSION,
    })
    .select("id")
    .maybeSingle();

  if (!cycleIns.data) {
    return {
      ...base,
      skipped: true,
      reason: "cycle_already_ran",
      durationMs: Date.now() - started,
    };
  }
  const cycleId = cycleIns.data.id as string;

  const finish = async (
    patch: Partial<CycleSummary> & { status: string },
    rows: Array<Record<string, unknown>> = [],
    provenance: Record<string, unknown> = {},
  ): Promise<CycleSummary> => {
    let feedbackError = false;
    if (rows.length > 0) {
      const shortlistWrite = await admin
        .from("committee_shortlist")
        .upsert(rows, { onConflict: "cycle_id,symbol,direction" });
      // Freeze only unselected decisions. The benchmark starts at the known
      // decision close, not a hypothetical fill, and survives shortlist TTL.
      const feedback = rows.flatMap((row) => {
        const reference = referenceBySymbol.get(String(row.symbol));
        if (
          row.state === "selected" ||
          !reference ||
          (row.direction !== "long" && row.direction !== "short")
        ) return [];
        return [{
          user_id: userId,
          cycle_id: cycleId,
          book,
          symbol: String(row.symbol),
          direction: row.direction,
          decision_at: new Date(reference.candleCloseMs).toISOString(),
          reference_price: reference.price,
          decision_state: String(row.state),
          rejection_reason: row.rejection_reason == null ? null : String(row.rejection_reason),
          strategy_version: SHORTLIST_STRATEGY_VERSION,
          entry_plan: row.entry_plan ?? {},
        }];
      });
      if (shortlistWrite.error) feedbackError = true;
      if (!shortlistWrite.error && feedback.length) {
        // The migration is additive; the generated Database type is refreshed
        // only after the target project applies it.
        const ledgerWrite = await (admin as SupabaseClient)
          .from("missed_opportunities")
          .upsert(feedback, { onConflict: "cycle_id,symbol,direction" });
        if (ledgerWrite.error) feedbackError = true;
      }
    }
    await admin
      .from("committee_cycles")
      .update({
        status: patch.status,
        universe_size: patch.universeSize ?? 0,
        candidate_count: patch.candidateCount ?? 0,
        reviewed_count: patch.reviewedCount ?? 0,
        seat_response_count: patch.seatResponseCount ?? 0,
        selected_symbol: patch.selectedSymbol ?? null,
        selected_direction: patch.selectedDirection ?? null,
        selected_score: patch.selectedScore ?? null,
        no_trade_reason: patch.noTradeReason ?? null,
        provenance,
        completed_at: new Date().toISOString(),
      })
      .eq("id", cycleId);
    return {
      ...base,
      ...patch,
      cycleId,
      reason: feedbackError ? "opportunity_ledger_unavailable" : patch.reason,
      durationMs: Date.now() - started,
    };
  };

  // ---- 2. Verify the internal-test universe against the venue adapter. ---
  let instruments: Awaited<
    ReturnType<ReturnType<typeof getUniverseAdapter>["discover"]>
  >["instruments"] = [];
  try {
    const universe = await getUniverseAdapter("apex").discover({
      environment: "paper",
      marketType: "paper",
      now,
    });
    instruments = universe.instruments;
  } catch (e) {
    return await finish(
      { status: "failed", noTradeReason: "universe_unavailable", ok: false },
      [],
      { error: (e as Error).message.slice(0, 200) },
    );
  }

  const internalSymbols = new Set<string>(DEFAULT_PAPER_SYMBOLS);
  const tradable = instruments
    .filter(
      (instrument) =>
        internalSymbols.has(instrument.symbol) &&
        instrument.tradable &&
        (instrument.volume24hUsd ?? 0) >= PREFILTER_POLICY.minLiquidityUsd,
    )
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    .slice(0, CYCLE_LIMITS.maxCandleFetch);

  // ---- 3. Real candles → deterministic per-symbol read. ------------------
  const signals = await mapLimit(tradable, CYCLE_LIMITS.candleConcurrency, async (inst) => {
    try {
      const feed = await fetchApexKlines(inst.symbol, 15, 140, inst.tickSize ?? undefined);
      const sig = deriveCycleSignal(feed.candles as unknown as OHLCV[], 15 * 60_000);
      return sig ? { inst, sig } : null;
    } catch {
      return null;
    }
  });

  const raw: PrefilterCandidate[] = [];
  const signalBySymbol = new Map<string, NonNullable<(typeof signals)[number]>>();
  for (const s of signals) {
    if (!s || !s.sig.direction) continue;
    signalBySymbol.set(s.inst.symbol, s);
    referenceBySymbol.set(s.inst.symbol, {
      price: s.sig.lastClose,
      candleCloseMs: s.sig.candleCloseMs,
    });
    raw.push({
      symbol: s.inst.symbol,
      direction: s.sig.direction as Direction,
      signalId: `${cycleKey}:${s.inst.symbol}:${s.sig.direction}`,
      candleCloseMs: s.sig.candleCloseMs,
      contractActive: s.inst.tradable,
      liquidityUsd: s.inst.volume24hUsd,
      spreadBps: s.inst.spreadBps,
      volatilityPct: s.sig.volatilityPct,
      exchangeMaxLeverage: s.inst.maxLeverage,
      tickSize: s.inst.tickSize,
      stepSize: s.inst.minQty,
      minNotionalUsd: s.inst.minNotional,
      confidence: null,
      momentum: s.sig.momentum,
      structure: s.sig.structure,
    });
  }

  // ---- 4. Capacity + exposure context. -----------------------------------
  const openRows = await admin
    .from("paper_positions")
    .select("symbol")
    .eq("user_id", userId)
    .eq("status", "open");
  const openSymbols = new Set<string>((openRows.data ?? []).map((r) => r.symbol as string));

  const { accepted, rejected } = prefilterCandidates(raw, {
    nowMs: now,
    openSymbols,
    maxBatch: opts.maxBatch ?? PREFILTER_POLICY.maxBatch,
  });

  const rejectionRows: Array<Record<string, unknown>> = rejected.map((r) => ({
    cycle_id: cycleId,
    user_id: userId,
    symbol: r.symbol,
    direction: r.direction,
    state: "rejected",
    rejection_reason: r.reason,
    score_components: {},
    seat_decisions: [],
  }));

  // ---- 4b. Structure-aware entry geometry BEFORE spending model budget. ---
  // A candidate whose entry is unreachably extended, or for which no stop can
  // satisfy both market noise and the account risk ceiling, is rejected here
  // with an auditable geometric reason instead of being asked about.
  const planBySymbol = new Map<string, EntryPlan>();
  const geometryOk: typeof accepted = [];
  for (const c of accepted) {
    const s = signalBySymbol.get(c.symbol)!;
    const atrAbs = (s.sig.volatilityPct / 100) * s.sig.lastClose;
    const plan = buildEntryPlan({
      direction: c.direction,
      lastClose: s.sig.lastClose,
      candleCloseMs: c.candleCloseMs,
      atrAbs,
      spreadBps: c.spreadBps,
      momentum: s.sig.momentum,
      structure: s.sig.structure,
      highs: s.sig.highs,
      lows: s.sig.lows,
      closes: s.sig.closes,
      volumes: s.sig.volumes,
      tickSize: c.tickSize,
    });
    if (plan.rejectReason) {
      rejectionRows.push({
        cycle_id: cycleId,
        user_id: userId,
        symbol: c.symbol,
        direction: c.direction,
        state: "rejected",
        rejection_reason: `geometry:${plan.rejectReason}`,
        score_components: {},
        seat_decisions: [],
        entry_plan: plan,
      });
      continue;
    }
    planBySymbol.set(c.symbol, plan);
    geometryOk.push(c);
  }

  if (geometryOk.length === 0) {
    return await finish(
      {
        status: "no_trade",
        universeSize: tradable.length,
        candidateCount: 0,
        noTradeReason:
          accepted.length === 0 ? "no_qualified_candidates" : "no_valid_entry_geometry",
      },
      rejectionRows,
      { prefiltered: raw.length, tradable: tradable.length, geometry_version: GEOMETRY_VERSION },
    );
  }

  // ---- 5. Strategist fan-out (bounded, timed, circuit-broken). -----------
  const { evaluateSnapshot } = await import("@/lib/ai/committee/evaluate.server");
  let consecutiveFailures = 0;
  let breakerTripped = false;
  const deadline = started + CYCLE_LIMITS.cycleDeadlineMs;

  const unavailableSeats = (reason: string): SeatDecision[] =>
    ["lead", "risk", "structure"].map((role) => ({
      role,
      available: false,
      direction: null,
      confidence: null,
      reason,
    }));

  const reviewed: ReviewedCandidate[] = await mapLimit(
    geometryOk,
    CYCLE_LIMITS.reviewConcurrency,
    async (c): Promise<ReviewedCandidate> => {
      if (breakerTripped)
        return {
          ...c,
          seats: unavailableSeats("circuit_open"),
          verdict: null,
          consensusDirection: null,
          consensusConfidence: null,
          riskFlags: [],
        };
      if (Date.now() > deadline)
        return {
          ...c,
          seats: unavailableSeats("cycle_deadline"),
          verdict: null,
          consensusDirection: null,
          consensusConfidence: null,
          riskFlags: [],
        };
      if (opts.dryRun)
        return {
          ...c,
          seats: unavailableSeats("dry_run"),
          verdict: null,
          consensusDirection: null,
          consensusConfidence: null,
          riskFlags: [],
        };

      const s = signalBySymbol.get(c.symbol)!;
      const plan = planBySymbol.get(c.symbol)!;
      const snapshot: MarketSnapshot = {
        candidate_id: `cycle:${cycleId}:${c.symbol}:${c.direction}`,
        strategy: "committee_cycle",
        symbol: c.symbol,
        timeframe: "15m",
        candle_close_ms: c.candleCloseMs,
        deterministic: {
          proposed_direction: c.direction,
          entry: plan.entry,
          entry_zone: plan.entryZone,
          invalidation: plan.stop,
          tp_levels: plan.tpLevels,
          regime: null,
          trend_state: c.direction === "long" ? "up" : "down",
          trend_slope_pct: null,
          atr_pct: s.sig.volatilityPct,
          recent_closes: s.sig.closes.slice(-60),
          recent_highs: s.sig.highs.slice(-60),
          recent_lows: s.sig.lows.slice(-60),
          volume_profile: s.sig.volumes.slice(-60),
        },
      };

      try {
        const dto = await withTimeout(
          evaluateSnapshot(admin, userId, snapshot),
          CYCLE_LIMITS.reviewTimeoutMs,
          "committee_review",
        );
        if (!dto) throw new Error("no_evaluation");
        consecutiveFailures = 0;
        const seats: SeatDecision[] = ["lead", "risk", "structure"].map((role) => {
          const o = dto.outcomes.find((x) => x.role === role);
          if (!o)
            return {
              role,
              available: false,
              direction: null,
              confidence: null,
              reason: "not_asked",
            };
          if (!o.available)
            return { role, available: false, direction: null, confidence: null, reason: o.reason };
          return {
            role,
            available: true,
            direction: o.response.direction,
            confidence: o.response.confidence,
            reason: o.response.summary.slice(0, 240),
          };
        });
        return {
          ...c,
          seats,
          verdict: dto.verdict,
          consensusDirection: dto.consensusDirection,
          consensusConfidence: dto.consensusConfidence,
          riskFlags: dto.riskFlags,
          candidateId: dto.candidateId,
          evaluationId: dto.id,
          evidenceHash: dto.evidenceHash,
        };
      } catch (e) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= CYCLE_LIMITS.breakerThreshold) breakerTripped = true;
        const reason = (e as Error).message.slice(0, 60) || "review_failed";
        return {
          ...c,
          seats: unavailableSeats(reason),
          verdict: null,
          consensusDirection: null,
          consensusConfidence: null,
          riskFlags: [],
        };
      }
    },
  );

  // ---- 6. Normalize, rank, select at most one. ---------------------------
  const result = rankShortlist(reviewed);
  const seatResponses = reviewed.reduce((n, c) => n + c.seats.filter((s) => s.available).length, 0);

  const isUuid = (v: string | null | undefined): string | null =>
    v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

  const rankedRows = result.ranked.map((r) => ({
    cycle_id: cycleId,
    user_id: userId,
    symbol: r.symbol,
    direction: r.direction,
    state: r.state,
    rank: r.rank,
    total_score: r.totalScore,
    score_components: r.components,
    liquidity_usd: r.liquidityUsd,
    spread_bps: r.spreadBps,
    volatility_pct: r.volatilityPct,
    expected_net_edge_bps: r.expectedNetEdgeBps,
    seat_decisions: r.seats,
    available_seats: r.availableSeats,
    unavailable_seats: r.unavailableSeats,
    verdict: r.verdict,
    consensus_confidence: r.consensusConfidence,
    risk_veto: r.riskVeto,
    risk_objection: r.riskObjection,
    entry_plan: planBySymbol.get(r.symbol) ?? {},
    rejection_reason: r.rejectionReason,
    candidate_id: r.candidateId,
    evaluation_id: isUuid(r.evaluationId),
    evidence_hash: r.evidenceHash,
    signal_id: null,
  }));

  return await finish(
    {
      status: result.selected ? "selected" : "no_trade",
      universeSize: tradable.length,
      candidateCount: geometryOk.length,
      reviewedCount: reviewed.length,
      seatResponseCount: seatResponses,
      selectedSymbol: result.selected?.symbol ?? null,
      selectedDirection: result.selected?.direction ?? null,
      selectedScore: result.selected?.totalScore ?? null,
      noTradeReason: result.noTradeReason,
      breakerTripped,
    },
    [...rejectionRows, ...rankedRows],
    {
      tradable: tradable.length,
      candles_fetched: signals.filter(Boolean).length,
      prefilter_policy: PREFILTER_POLICY,
      breaker_tripped: breakerTripped,
      strategy_version: SHORTLIST_STRATEGY_VERSION,
      geometry_version: GEOMETRY_VERSION,
    },
  );
}
