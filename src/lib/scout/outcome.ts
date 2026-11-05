/**
 * Deterministic outcome evaluator. PURE.
 *
 * Given the entry_price, direction, entry timestamp, and forward closed
 * candles, computes MFE / MAE / net move over 15m / 1h / 4h / 24h windows
 * and whether a scored target or invalidation was hit.
 *
 * Outputs are additive rows for `scout_outcomes`. Corrections are new rows
 * that reference a prior row via `supersedes_id` (append-only).
 *
 * READ-ONLY MODULE.
 */

import { CLOSE, HIGH, LOW, type Candle } from "@/lib/paper/signal";
import type { OutcomeReasonCode } from "./reasonCodes";
import { OUTCOME_SCHEMA_VERSION } from "./versions";

export type OutcomeStatus = "pending" | "complete" | "insufficient_data";

export type WindowKey = "15m" | "1h" | "4h" | "24h";

export const WINDOW_MS: Record<WindowKey, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export interface OutcomeInput {
  entry_price: number;
  direction: "long" | "short";
  /** Signed [-1, +1]; used to scale the "target" bar (bigger score → bigger target). */
  score: number;
  entry_ts_ms: number;
  now: number;
  /** Forward candles (>= entry_ts_ms). Any interval OK; we scan HIGH/LOW/CLOSE. */
  forward_candles: Candle[];
  /** Optional absolute price where the setup is invalidated. */
  invalidation_price?: number | null;
}

export interface WindowResult {
  window: WindowKey;
  status: OutcomeStatus;
  mfe_pct: number;
  mae_pct: number;
  net_pct: number;
  target_hit: boolean;
  invalidation_hit: boolean;
  bars_used: number;
  reason_codes: OutcomeReasonCode[];
}

export interface OutcomeReport {
  entry_price: number;
  direction: "long" | "short";
  entry_ts_ms: number;
  windows: WindowResult[];
  outcome_schema_version: number;
}

/**
 * Predefined target: base 0.5% scaled up to 2% at |score|=1.
 * Invalidation: 1% adverse OR explicit `invalidation_price`.
 */
function targetPct(score: number): number {
  const base = 0.005;
  const boost = Math.min(0.015, 0.015 * Math.abs(score));
  return base + boost;
}

function evaluateWindow(
  input: OutcomeInput,
  windowKey: WindowKey,
): WindowResult {
  const endTs = input.entry_ts_ms + WINDOW_MS[windowKey];
  const rel = input.forward_candles.filter(
    (c) => c[0] >= input.entry_ts_ms && c[0] < endTs,
  );
  const reasons: OutcomeReasonCode[] = [];

  if (rel.length === 0) {
    const windowClosed = input.now >= endTs;
    return {
      window: windowKey,
      status: windowClosed ? "insufficient_data" : "pending",
      mfe_pct: 0,
      mae_pct: 0,
      net_pct: 0,
      target_hit: false,
      invalidation_hit: false,
      bars_used: 0,
      reason_codes: [windowClosed ? "insufficient_forward_data" : "insufficient_forward_data"],
    };
  }

  const entry = input.entry_price;
  const isLong = input.direction === "long";
  let bestFav = 0;
  let worstAdv = 0;
  for (const c of rel) {
    const hi = c[HIGH];
    const lo = c[LOW];
    const favMove = isLong ? (hi - entry) / entry : (entry - lo) / entry;
    const advMove = isLong ? (entry - lo) / entry : (hi - entry) / entry;
    if (favMove > bestFav) bestFav = favMove;
    if (advMove > worstAdv) worstAdv = advMove;
  }
  const lastClose = rel[rel.length - 1][CLOSE];
  const net = isLong ? (lastClose - entry) / entry : (entry - lastClose) / entry;

  const tgt = targetPct(input.score);
  const invPct = input.invalidation_price != null
    ? Math.abs(input.invalidation_price - entry) / entry
    : 0.01;

  const target_hit = bestFav >= tgt;
  const invalidation_hit = worstAdv >= invPct;

  const windowClosed = input.now >= endTs;
  const status: OutcomeStatus = target_hit || invalidation_hit || windowClosed ? "complete" : "pending";
  if (target_hit) reasons.push("target_hit");
  if (invalidation_hit) reasons.push("invalidation_hit");
  if (!target_hit && !invalidation_hit && windowClosed) reasons.push("window_expired");
  if (status === "pending") reasons.push("insufficient_forward_data");

  return {
    window: windowKey,
    status,
    mfe_pct: bestFav,
    mae_pct: worstAdv,
    net_pct: net,
    target_hit,
    invalidation_hit,
    bars_used: rel.length,
    reason_codes: reasons,
  };
}

export function evaluateOutcome(input: OutcomeInput): OutcomeReport {
  return {
    entry_price: input.entry_price,
    direction: input.direction,
    entry_ts_ms: input.entry_ts_ms,
    windows: (Object.keys(WINDOW_MS) as WindowKey[]).map((w) => evaluateWindow(input, w)),
    outcome_schema_version: OUTCOME_SCHEMA_VERSION,
  };
}
