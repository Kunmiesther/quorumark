/**
 * Agentic sweep for PAPER only.
 *
 * Runs after the deterministic paper tick: re-evaluates open positions through
 * the three advisory seats plus ONYX, then attributes newly closed trades.
 *
 * SAFETY: nothing here touches signer, execution-broker, order tables or any
 * live path. Management actions are recorded unconditionally but only mutate
 * state when the explicit apply gate is open.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandlesBounded } from "./market";
import { INTERVAL_MIN, SETUP_INTERVAL_1H_MIN, SETUP_INTERVAL_4H_MIN, FETCH_LIMIT } from "./constants";
import { fetchEnvironmentContext } from "./environmentFrames";
import {
  sweepPositionManagement,
  type ManagementMarket,
  type ManagementSweepSummary,
} from "./positionManagement.server";
import { sweepTradeReviews, type ReviewSweepSummary } from "./review.server";

/** Candles are ascending tuples: [tsMs, open, high, low, close, volume]. */
const TS = 0;
const CLOSE = 4;
const VOLUME = 5;

const VOLUME_WINDOW = 20;
const MAX_SYMBOLS = 8;

export const PAPER_RUNTIME_VERSION = "paper-agentic-runtime-2026-08-03-v2";

function runtimeVersion(): string {
  return process.env["APP_VERSION"] ?? process.env["VERCEL_GIT_COMMIT_SHA"] ??
    process.env["CF_PAGES_COMMIT_SHA"] ?? process.env["RAILWAY_GIT_COMMIT_SHA"] ?? PAPER_RUNTIME_VERSION;
}

function lastCloseMs(candles: Array<readonly number[]>): number | null {
  const last = candles[candles.length - 1];
  return last ? Number(last[TS]) : null;
}

export interface AgenticSweepSummary {
  management: ManagementSweepSummary;
  review: ReviewSweepSummary;
}

/**
 * Build the market snapshot for the symbols this user currently holds open.
 * Symbols whose feed fails are simply absent — the management sweep then
 * skips those positions rather than acting on stale or invented prices.
 */
export async function loadManagementMarkets(
  reader: SupabaseClient,
  userId: string,
): Promise<Map<string, ManagementMarket>> {
  const markets = new Map<string, ManagementMarket>();

  const { data: rows } = await reader
    .from("paper_positions")
    .select("symbol")
    .eq("user_id", userId)
    .eq("status", "open");

  const symbols = Array.from(
    new Set((rows ?? []).map((r) => String((r as Record<string, unknown>).symbol))),
  ).slice(0, MAX_SYMBOLS);
  if (symbols.length === 0) return markets;

  const results = await Promise.all(
    symbols.map(async (sym) => {
      const [res, setup1h, setup4h, environment] = await Promise.all([
        fetchCandlesBounded(sym, INTERVAL_MIN, FETCH_LIMIT),
        fetchCandlesBounded(sym, SETUP_INTERVAL_1H_MIN, FETCH_LIMIT),
        fetchCandlesBounded(sym, SETUP_INTERVAL_4H_MIN, FETCH_LIMIT),
        fetchEnvironmentContext(sym),
      ]);
      return { sym, res, setup1h, setup4h, environment };
    }),
  );

  for (const { sym, res, setup1h, setup4h, environment } of results) {
    if (!res.ok) continue;
    const candles = res.feed.candles;
    if (!candles.length) continue;
    const last = candles[candles.length - 1] as unknown as number[];
    const window = candles.slice(-VOLUME_WINDOW) as unknown as number[][];
    const avgVolume =
      window.reduce((s, c) => s + Number(c[VOLUME] ?? 0), 0) / Math.max(1, window.length);
    const c1h = setup1h.ok ? setup1h.feed.candles : [];
    const c4h = setup4h.ok ? setup4h.feed.candles : [];

    markets.set(sym, {
      price: Number(last[CLOSE]),
      candleTsMs: Number(last[TS]),
      volume: Number(last[VOLUME] ?? 0),
      avgVolume,
      recentCloses: window.map((c) => Number(c[CLOSE])),
      timeframeCloses: {
        // Legacy field names are retained for stored-event compatibility;
        // both now point at the canonical 15m execution candle.
        close5mMs: Number(last[TS]),
        close15mMs: Number(last[TS]),
        close1hMs: lastCloseMs(c1h),
        close4hMs: lastCloseMs(c4h),
        dailyMs: environment.frames["1d"]?.last_closed_ms ?? null,
        weeklyMs: environment.frames["1w"]?.last_closed_ms ?? null,
        monthlyMs: environment.frames["1M"]?.last_closed_ms ?? null,
      },
      environmentFrames: environment.available ? environment.frames : null,
    });
  }

  return markets;
}

/**
 * One user's agentic sweep. Never throws — a failure in the advisory layer
 * must not break the deterministic paper tick that already committed.
 */
export async function runAgenticSweep(
  reader: SupabaseClient,
  userId: string,
): Promise<AgenticSweepSummary> {
  const empty: AgenticSweepSummary = {
    management: { discovered: 0, positions: 0, events: 0, degradedEvents: 0, actions: {}, errors: 0, skipped: {} },
    review: { scanned: 0, reviewed: 0, unattributed: 0, proposals: 0, errors: 0 },
  };

  const startedAt = new Date().toISOString();
  const version = runtimeVersion();
  let runId: string | null = null;
  try {
    const created = await reader.from("agentic_sweep_runs").insert({
      user_id: userId,
      started_at: startedAt,
      runtime_version: version,
      status: "started",
    }).select("id").single();
    runId = created.data?.id ?? null;
    const markets = await loadManagementMarkets(reader, userId);
    const management = await sweepPositionManagement(reader, userId, markets);
    const review = await sweepTradeReviews(reader, userId);
    if (runId) {
      await reader.from("agentic_sweep_runs").update({
        finished_at: new Date().toISOString(),
        positions_discovered: management.discovered,
        positions_eligible: management.positions,
        skipped_by_reason: management.skipped,
        events_written: management.events,
        errors: management.errors + review.errors,
        error_categories: management.errors + review.errors > 0 ? ["management_or_review_error"] : [],
        status: management.errors + review.errors > 0 ? "completed_with_errors" : "completed",
        detail: { markets_loaded: markets.size, trades_reviewed: review.reviewed },
      }).eq("id", runId);
    }
    return { management, review };
  } catch (error) {
    const category = error instanceof Error ? error.name.slice(0, 80) : "unknown_error";
    if (runId) {
      await reader.from("agentic_sweep_runs").update({
        finished_at: new Date().toISOString(), errors: 1, error_categories: [category], status: "failed",
      }).eq("id", runId);
    }
    return { ...empty, management: { ...empty.management, errors: 1 } };
  }
}
