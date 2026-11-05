/**
 * Entry eligibility for the paper engine's Phase-A candidate collection.
 *
 * Root problem (2026-07-20 telemetry): the accumulator detector was surfacing
 * many confirmed break-and-retest setups per symbol each cycle (e.g. SOL 16
 * long / 15 short) but the engine only opened on a setup that landed on the
 * BRAND-NEW candle since the wallet cursor. ~99% of valid, never-traded setups
 * were discarded — Onyx saw almost nothing and most wallets never fired.
 *
 * Rule (this module):
 *  - A confirmed retest is FRESH if its retest_index is within
 *    ENTRY_FRESHNESS_CANDLES of the newest completed candle.
 *  - A retest is IDENTITY-KEYED by (symbol, direction, entry_candle_ts). The
 *    engine treats a candidate as already-traded when that key is already in
 *    paper_positions (any status) via `opened_from_signal`.
 *  - Phase A proposes the most-recent FRESH + UN-TRADED retest per (wallet,
 *    direction). Onyx (Phase B) still decides who deploys — this module does
 *    NOT bypass Onyx.
 */
import type { Direction, RetestResult } from "./signal";
import { ELIGIBILITY } from "./parityConstants";

/**
 * How many candles back a confirmed retest may sit and still count as
 * "fresh enough to propose as a candidate". Small on purpose: entries stale
 * past this window are not worth surfacing.
 *
 * NOTE: TS/paper and Python/live diverge here — see MAINNET_PARITY.md §7.
 * The value is sourced from `eligibility.entry_freshness_candles_ts_paper`
 * in the shared parity JSON so future convergence work has one lever.
 */
export const ENTRY_FRESHNESS_CANDLES = ELIGIBILITY.entry_freshness_candles_ts_paper;

/**
 * Stable, timestamp-anchored identity for an accumulator entry. Must match
 * the `opened_from_signal` string the engine writes on paper_positions so
 * the dedup Set roundtrips cleanly.
 */
export function accumulatorSignalKey(
  symbol: string,
  direction: Direction,
  entryCandleTs: number,
): string {
  return `${symbol}:${direction}:${entryCandleTs}`;
}

/**
 * Pick the most-recent confirmed accumulator retest that:
 *  (a) sits within ENTRY_FRESHNESS_CANDLES of the newest candle, AND
 *  (b) has NOT already been traded (identity check via tradedKeys).
 *
 * Returns null if no such candidate exists.
 */
export function pickFreshUntradedAccumulatorEntry(
  entries: RetestResult[],
  newestIdx: number,
  candlesTs: (idx: number) => number,
  symbol: string,
  direction: Direction,
  tradedKeys: ReadonlySet<string>,
): { retest: RetestResult; signalKey: string } | null {
  const minIdx = newestIdx - ENTRY_FRESHNESS_CANDLES;
  const eligible = entries
    .filter(
      (r) =>
        r.state === "confirmed" &&
        r.retest_index != null &&
        (r.retest_index as number) >= minIdx &&
        (r.retest_index as number) <= newestIdx,
    )
    .sort((a, b) => (b.retest_index as number) - (a.retest_index as number));
  for (const r of eligible) {
    const ts = candlesTs(r.retest_index as number);
    const key = accumulatorSignalKey(symbol, direction, ts);
    if (!tradedKeys.has(key)) return { retest: r, signalKey: key };
  }
  return null;
}
