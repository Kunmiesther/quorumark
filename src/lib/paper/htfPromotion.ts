/**
 * HTF Guardian Exploit Mode — pure promotion logic.
 *
 * The already-deployed 1h BOS detector (htfBos.ts) is telemetry-only. This
 * module wires it to position behavior: when an open position is profitable
 * AND the 1h BOS state is confirmed in the position's direction, we
 * "promote" it to a runner.
 *
 * OWNER RULING (Phase 3 amendment): NO banking on promotion. Full-size
 * runner. `HTF_PROMOTION_BANK_FRACTION` is retained as a shared parity
 * constant (currently 0) so a partial-bank variant can be re-enabled by
 * data later without a code change; while the value is 0 the engine MUST
 * NOT reduce the position on promotion.
 *
 * Atomic promotion actions (on the FULL position):
 *   1. hard stop → breakeven+fees
 *   2. cancel fixed TP
 *   3. cancel unfilled ladder rungs
 *
 * Post-promotion, the 5m adverse-BOS guardian no longer cuts the position.
 * Runner exits only via:
 *   - confirmed adverse 1h BOS  ("HTF BOS · RUNNER CLOSED")
 *   - breakeven+fees stop hit   ("runner_breakeven_stop")
 * A promoted trade therefore can never realize a net loss.
 *
 * PURE — no I/O, no DB, no Supabase. Fully unit-tested.
 */
import { HTF_PROMOTION } from "./parityConstants";
import { FEE_RATE, SLIP_RATE } from "./constants";
import type { HtfBosState } from "./htfBos";
import type { Direction } from "./signal";

export const HTF_PROMOTION_ENABLED: boolean = HTF_PROMOTION.enabled === true;
/** Configurable — currently 0 (no banking). Retained so a partial-bank
 *  variant can be re-enabled by editing the shared parity JSON. */
export const HTF_PROMOTION_BANK_FRACTION: number = HTF_PROMOTION.bank_fraction;
export const HTF_PROMOTION_MIN_NET_PROFIT_MODE: string =
  HTF_PROMOTION.min_net_profit_mode;

/** True while `HTF_PROMOTION_BANK_FRACTION` is > 0. When false, the engine
 *  MUST skip any partial-close path and promote the FULL size. */
export const HTF_PROMOTION_BANK_ENABLED: boolean =
  HTF_PROMOTION_BANK_FRACTION > 0;

/** Whether the 1h BOS state is confirmed and ALIGNED with position direction. */
export function isAlignedHtfBos(direction: Direction, state: HtfBosState): boolean {
  if (direction === "long") return state === "bullish_bos";
  if (direction === "short") return state === "bearish_bos";
  return false;
}

/** Whether the 1h BOS state is confirmed and ADVERSE to position direction. */
export function isAdverseHtfBos(direction: Direction, state: HtfBosState): boolean {
  if (direction === "long") return state === "bearish_bos";
  if (direction === "short") return state === "bullish_bos";
  return false;
}

export interface PromotionCheckInput {
  isOpen: boolean;
  alreadyPromoted: boolean;
  unrealizedNetPnl: number;
  htfState: HtfBosState;
  direction: Direction;
}

/**
 * Promotion fires iff ALL THREE:
 *   1. position is open (and not already promoted)
 *   2. unrealized net PnL > 0 (breakeven+fees or better — the caller passes
 *      the net-of-fees number, so `> 0` is the correct check)
 *   3. htfBos state is CONFIRMED and ALIGNED with the position direction
 * A losing position can NEVER be promoted, regardless of htfBos.
 * Also gated by the master `HTF_PROMOTION_ENABLED` flag.
 */
export function shouldPromote(input: PromotionCheckInput): boolean {
  if (!HTF_PROMOTION_ENABLED) return false;
  if (!input.isOpen) return false;
  if (input.alreadyPromoted) return false;
  if (!(input.unrealizedNetPnl > 0)) return false;
  if (!isAlignedHtfBos(input.direction, input.htfState)) return false;
  return true;
}

/**
 * Breakeven+fees stop price. Set so that the raw fill (after exit slippage)
 * multiplied by (1 ± taker fee) recovers the entry VWAP exactly — the
 * runner cannot realize a net loss even if it exits precisely at this stop.
 *
 *   Long: exit_fill = stop × (1 - SLIP);  fee = exit_fill × TAKER;
 *         net_zero → stop × (1 - SLIP) × (1 - TAKER) = entry_vwap
 *         ⇒ stop = entry_vwap / ((1 - SLIP) × (1 - TAKER))
 *   Short: mirrored with (1 + SLIP)(1 + TAKER) denominator.
 *
 * Entry-side fees are MAKER (0 bps in the paper engine) and already deducted
 * on open, so the stop formula only needs to recover the exit-side round-trip.
 */
export function computeBreakevenStop(
  entryVwap: number,
  direction: Direction,
): number {
  if (!(entryVwap > 0)) throw new Error("entryVwap must be > 0");
  if (direction === "long") {
    return entryVwap / ((1 - SLIP_RATE) * (1 - FEE_RATE));
  }
  return entryVwap / ((1 + SLIP_RATE) * (1 + FEE_RATE));
}

/** Whether the current close crosses (or exceeds) the runner breakeven stop. */
export function runnerBreakevenStopHit(
  direction: Direction,
  close: number,
  runnerBreakevenStop: number,
): boolean {
  if (!(runnerBreakevenStop > 0) || !(close > 0)) return false;
  return direction === "long" ? close <= runnerBreakevenStop : close >= runnerBreakevenStop;
}
