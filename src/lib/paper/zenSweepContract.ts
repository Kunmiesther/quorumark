/**
 * Canonical Zen sweep execution contract.
 *
 * This module is deliberately strategy-scoped, not symbol-scoped: every
 * symbol in ORCHESTRATION.scan_symbols is eligible for the same sweep rules.
 * Venue metadata (tick, leverage cap) remains an input.
 */
import raw from "../../../shared/strategy-contracts/zen_sweep_v1.json";
import { ORCHESTRATION } from "./parityConstants";
import type { Direction } from "./signal";
import type { Rung } from "./ladder";

export const ZEN_SWEEP = raw;
export const ZEN_SWEEP_STRATEGY_ID = raw.strategy_id;
export const CANONICAL_SCAN_SYMBOLS = Object.freeze([...ORCHESTRATION.scan_symbols]);
export const CANONICAL_SCAN_SYMBOL_SET: ReadonlySet<string> = new Set(CANONICAL_SCAN_SYMBOLS);

function assertContract(): void {
  if (raw.signal.entry_timeframe_min !== ORCHESTRATION.decision_interval_min) {
    throw new Error("zen_sweep_v1 entry timeframe must equal the orchestration decision interval");
  }
  if (ORCHESTRATION.scan_universe_size !== CANONICAL_SCAN_SYMBOLS.length) {
    throw new Error("orchestration scan_universe_size does not match scan_symbols");
  }
  if (raw.execution.margin_mode !== "cross") {
    throw new Error("zen_sweep_v1 must fail closed unless margin_mode is cross");
  }
  if (raw.execution.rung_count !== 5 || raw.signal.alignment_votes_required !== 2) {
    throw new Error("zen_sweep_v1 canonical five-rung / two-vote contract drifted");
  }
  if (
    raw.execution.rung_count !== ORCHESTRATION.campaign_rung_count ||
    raw.execution.total_margin_fraction_of_available_equity !==
      ORCHESTRATION.campaign_margin_fraction_of_settled_wallet_balance
  ) {
    throw new Error("zen_sweep_v1 must match the universal wallet campaign sizing contract");
  }
}
assertContract();

export function isCanonicalScanSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === "string" && CANONICAL_SCAN_SYMBOL_SET.has(symbol);
}
export type AlignmentState = "bullish_bos" | "bearish_bos" | "none";

export function alignmentVotes(
  direction: Direction,
  states: readonly AlignmentState[],
): number {
  const expected = direction === "long" ? "bullish_bos" : "bearish_bos";
  return states.filter((state) => state === expected).length;
}

export function passesZenSweepAlignment(
  direction: Direction,
  states: readonly AlignmentState[],
): boolean {
  return alignmentVotes(direction, states) >= raw.signal.alignment_votes_required;
}

/**
 * Arm all five orders at acceptance. Rung one is at the alert price; the
 * remaining maker limits are spaced 0.5% against the trade. The complete
 * campaign commits exactly 5% of currently available wallet equity.
 */
export function buildZenSweepLadder(input: {
  direction: Direction;
  alertPrice: number;
  leverage: number;
  availableEquity: number;
}): Rung[] {
  const { direction, alertPrice } = input;
  const leverage = Number(input.leverage);
  const availableEquity = Number(input.availableEquity);
  if (!(alertPrice > 0) || !(leverage > 0) || !(availableEquity > 0)) return [];

  const count = raw.execution.rung_count;
  const totalMargin = availableEquity * raw.execution.total_margin_fraction_of_available_equity;
  const margin = totalMargin / count;
  const spacing = raw.execution.rung_spacing_price_pct;
  const firstTargetMove = (raw.exit.first_target_margin_roi_pct / 100) / leverage;

  return Array.from({ length: count }, (_, index) => {
    const adverse = spacing * index;
    const price = direction === "long"
      ? alertPrice * (1 - adverse)
      : alertPrice * (1 + adverse);
    const qty = (margin * leverage) / price;
    const tp = direction === "long"
      ? price * (1 + firstTargetMove)
      : price * (1 - firstTargetMove);
    return { price, qty, margin, tp };
  });
}

/** Net campaign ROI; banked and open P&L must already include modeled costs. */
export function netCampaignMarginRoiPct(
  bankedNetPnl: number,
  openNetPnl: number,
  initialMargin: number,
): number {
  if (!(initialMargin > 0)) return Number.NEGATIVE_INFINITY;
  return ((bankedNetPnl + openNetPnl) / initialMargin) * 100;
}

export type ZenSweepExitAction = "hold" | "close_half" | "close_all_target" | "close_all_trailing";

export interface ZenSweepExitDecision {
  action: ZenSweepExitAction;
  netRoiPct: number;
  highWaterRoiPct: number;
  trailingFloorRoiPct: number | null;
}

/**
 * Campaign-level 50/50 exit state machine:
 *  - first touch of +100% net margin ROI closes 50% pro-rata;
 *  - the remainder closes at +200%, or at the one-way trailing floor;
 *  - initial floor is +50%; every new ROI high ratchets it upward while
 *    preserving the configured 50-point ROI gap.
 */
export function decideZenSweepExit(input: {
  bankedNetPnl: number;
  openNetPnl: number;
  initialMargin: number;
  firstTargetTaken: boolean;
  previousHighWaterRoiPct?: number | null;
}): ZenSweepExitDecision {
  const netRoiPct = netCampaignMarginRoiPct(
    input.bankedNetPnl,
    input.openNetPnl,
    input.initialMargin,
  );
  const highWaterRoiPct = Math.max(
    Number(input.previousHighWaterRoiPct ?? Number.NEGATIVE_INFINITY),
    netRoiPct,
  );

  if (!input.firstTargetTaken) {
    return {
      action: netRoiPct >= raw.exit.first_target_margin_roi_pct ? "close_half" : "hold",
      netRoiPct,
      highWaterRoiPct,
      trailingFloorRoiPct: null,
    };
  }

  const trailingFloorRoiPct = Math.max(
    raw.exit.initial_trailing_floor_margin_roi_pct,
    highWaterRoiPct - raw.exit.trailing_gap_margin_roi_pct,
  );
  const action: ZenSweepExitAction =
    netRoiPct >= raw.exit.final_target_margin_roi_pct
      ? "close_all_target"
      : netRoiPct <= trailingFloorRoiPct
        ? "close_all_trailing"
        : "hold";
  return { action, netRoiPct, highWaterRoiPct, trailingFloorRoiPct };
}
