/**
 * DCA strategy — EXIT MODEL: margin-basis take-profit ladder + trailing stop.
 *
 * This is your ORIGINAL "Accumulator" DCA (down-averaging) strategy's exit
 * logic, being prepared as an ADD (not a replacement) alongside the live
 * break-and-retest trend leg. The DCA shares the break-and-retest ENTRY
 * (already ported in signal.ts); what's distinctive is its MANAGEMENT —
 * down-averaging + a laddered take-profit + a trailing stop.
 *
 * PURE, additive. No I/O, no orders. Nothing imports it yet; the engine
 * wiring (which also needs multi-fill / re-anchored-average position tracking)
 * is a later step.
 *
 * TAKE-PROFIT LADDER — ported faithfully from accumulator_exit.py (S39):
 *   TP1  200% margin ROI on the CURRENT average entry  -> sell half
 *   TP2  300% margin ROI on the CURRENT average entry  -> sell half of remainder
 *   TP3  400% margin ROI on the FROZEN first-fill VWAP  -> full close
 * Margin basis (v1 take_profit.basis): a target of N% margin return is a PRICE
 * move of (N/100)/leverage. So:
 *   long : entry * (1 + (pct/100)/leverage)
 *   short: entry * (1 - (pct/100)/leverage)
 *
 * TRAILING STOP — implements STRATEGY_SPEC_v1 `## stop`, which was SPECIFIED
 * BUT NEVER CODED (this is the DCA's missing downside protection):
 *   active_after : first_rebalance   (no stop until the first resize fills)
 *   level        : most_recent_resize_or_retest_level
 *   trigger      : a CONFIRMED 5m close beyond the level
 *   exit_overrides_resize: true      (a stop exit wins over any pending resize)
 *
 * FAIL CLOSED (S39): an invalid / wrong-side / unrepresentable target raises
 * rather than clamping — clamping an impossible exit into a plausible one is
 * how a strategy silently becomes a different strategy.
 */
export type Side = "long" | "short";

export const TP1_MARGIN_RETURN_PCT = 200;
export const TP2_MARGIN_RETURN_PCT = 300;
export const TP3_MARGIN_RETURN_PCT = 400; // original_first_entry_target

export class DcaExitError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DcaExitError";
  }
}

/** Margin-ROI target price. Fail-closed on impossible/wrong-side targets. */
function targetPrice(entry: number, side: Side, pct: number, leverage: number): number {
  if (!(leverage > 0)) throw new DcaExitError("LEVERAGE_NOT_POSITIVE");
  if (!(entry > 0)) throw new DcaExitError("ENTRY_NOT_POSITIVE");
  const move = pct / 100 / leverage;
  const target = side === "long" ? entry * (1 + move) : entry * (1 - move);
  if (!(target > 0)) throw new DcaExitError("TARGET_UNREPRESENTABLE"); // e.g. short 400% @ lev<=4
  if (side === "long" && target <= entry) throw new DcaExitError("TARGET_WRONG_SIDE");
  if (side === "short" && target >= entry) throw new DcaExitError("TARGET_WRONG_SIDE");
  return target;
}

/** TP1 — 200% margin ROI on the CURRENT (re-anchored) average entry. */
export function tp1Target(currentAvgEntry: number, side: Side, leverage: number): number {
  return targetPrice(currentAvgEntry, side, TP1_MARGIN_RETURN_PCT, leverage);
}

/** TP2 — 300% margin ROI on the CURRENT average entry. */
export function tp2Target(currentAvgEntry: number, side: Side, leverage: number): number {
  return targetPrice(currentAvgEntry, side, TP2_MARGIN_RETURN_PCT, leverage);
}

/**
 * TP3 — 400% margin ROI on the FROZEN first-fill VWAP. This anchor does NOT
 * move when later rungs pull the average down; that frozen anchor is the whole
 * meaning of `original_first_entry_target`.
 */
export function tp3Target(firstFillVwap: number, side: Side, leverage: number): number {
  return targetPrice(firstFillVwap, side, TP3_MARGIN_RETURN_PCT, leverage);
}

/**
 * Re-anchored average entry (VWAP of all filled rungs). `rungs` is the ordered
 * list of {price, qty} fills; the running average moves as rungs fill, which
 * is what TP1/TP2 track. Throws if there is nothing filled or qty is invalid.
 */
export function reanchoredAverage(rungs: ReadonlyArray<{ price: number; qty: number }>): number {
  let notional = 0;
  let qty = 0;
  for (const r of rungs) {
    if (!(r.price > 0) || !(r.qty > 0)) throw new DcaExitError("RUNG_INVALID");
    notional += r.price * r.qty;
    qty += r.qty;
  }
  if (!(qty > 0)) throw new DcaExitError("NO_FILLS");
  return notional / qty;
}

// ─── trailing stop (STRATEGY_SPEC_v1 ## stop) ───────────────────────────────
/**
 * The stop is ARMED only after the first rebalance (resize) has filled.
 * Before that the DCA runs unprotected by design — the resize IS the initial
 * risk response; the trailing stop takes over once averaging has begun.
 */
export function trailingStopActive(rebalanceCount: number): boolean {
  return rebalanceCount >= 1;
}

/**
 * Current trailing-stop level = the MOST RECENT resize-or-retest level. The
 * caller maintains `resizeOrRetestLevels` in chronological order, appending
 * each confirmed resize price and retest level as they occur. Returns null if
 * the stop is not armed yet or no level exists.
 */
export function trailingStopLevel(
  rebalanceCount: number,
  resizeOrRetestLevels: readonly number[],
): number | null {
  if (!trailingStopActive(rebalanceCount)) return null;
  if (resizeOrRetestLevels.length === 0) return null;
  return resizeOrRetestLevels[resizeOrRetestLevels.length - 1];
}

/**
 * Stop trigger: a CONFIRMED 5m close BEYOND the level (below for long, above
 * for short). Pass the COMPLETED candle's close. Returns false when the stop
 * is not armed or has no level (never invents a stop).
 */
export function stopTriggered(
  completedClose: number,
  rebalanceCount: number,
  resizeOrRetestLevels: readonly number[],
  side: Side,
): boolean {
  const level = trailingStopLevel(rebalanceCount, resizeOrRetestLevels);
  if (level == null) return false;
  return side === "long" ? completedClose < level : completedClose > level;
}
