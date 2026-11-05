/**
 * 1h Break-of-Structure (BOS) detector — Phase 1 (telemetry only).
 *
 * REUSES the exact 5m pivot + break rules from `signal.ts` (same
 * `findConfirmedSwings`, `wilderAtrSeries`, `groupLiquidityZones`, and
 * `evaluate()` break definition — close beyond the subject swing pivot AND
 * beyond EMA). The only change is the input timeframe: 1h candles produced
 * by `htfCandles.aggregate1h()`.
 *
 * State machine:
 *   - Walk long+short break events in chronological order.
 *   - A bullish break sets state = "bullish_bos" until superseded by a
 *     confirmed bearish break (which sets "bearish_bos") — and vice versa.
 *   - The initial state (before any confirmed break, or if too few candles)
 *     is "none".
 *
 * PURE — no I/O. Fully unit-testable.
 *
 * Phase 1 comment: this module is telemetry-only in the engine; no gate,
 * exit, or TP path consumes it yet. Phase 3 will wire promotion / trailing.
 */
import type { Candle } from "./signal";
import { evaluate, ATR_PERIOD, EMA_PERIOD, PIVOT_LEFT, PIVOT_RIGHT } from "./signal";

/** Minimum 1h candles required to have any chance of a confirmed break. */
export const MIN_HTF_CANDLES_FOR_BOS =
  Math.max(ATR_PERIOD, EMA_PERIOD) + PIVOT_LEFT + PIVOT_RIGHT + 1;

export type HtfBosState = "bullish_bos" | "bearish_bos" | "none";

export interface HtfBosResult {
  state: HtfBosState;
  confirmedAtTs: number | null;
  brokenLevel: number | null;
  barsSinceConfirm: number | null;
}

/**
 * Detect the current 1h BOS state given completed 1h candles (ascending ts).
 * `tick` is the symbol's price tick (used by the same zone/tolerance math
 * the 5m path uses); pass the engine's `feed.tick`.
 */
export function detectHtfBos(htfCandles: Candle[], tick: number): HtfBosResult {
  const none: HtfBosResult = {
    state: "none", confirmedAtTs: null, brokenLevel: null, barsSinceConfirm: null,
  };
  if (htfCandles.length < MIN_HTF_CANDLES_FOR_BOS) return none;

  const longEval = evaluate(htfCandles, "long", tick);
  const shortEval = evaluate(htfCandles, "short", tick);

  interface Ev { ts: number; index: number; dir: "long" | "short"; level: number }
  const evs: Ev[] = [];
  for (const be of longEval.breaks) {
    evs.push({ ts: be.break_ts, index: be.break_index, dir: "long", level: be.swing.level });
  }
  for (const be of shortEval.breaks) {
    evs.push({ ts: be.break_ts, index: be.break_index, dir: "short", level: be.swing.level });
  }
  if (!evs.length) return none;
  evs.sort((a, b) => (a.ts - b.ts) || (a.index - b.index));

  // Latest event wins (each confirmed opposite break supersedes prior state).
  const latest = evs[evs.length - 1];
  const newestIndex = htfCandles.length - 1;
  return {
    state: latest.dir === "long" ? "bullish_bos" : "bearish_bos",
    confirmedAtTs: latest.ts,
    brokenLevel: latest.level,
    barsSinceConfirm: newestIndex - latest.index,
  };
}
