/**
 * Deterministic reason codes emitted by evidence.ts / state.ts / outcome.ts.
 * Codes are stable enum strings; prose lives client-side so we can iterate
 * copy without a DB migration.
 *
 * READ-ONLY MODULE.
 */

export type EvidenceReasonCode =
  // structure
  | "structure_hh_hl"
  | "structure_lh_ll"
  | "structure_range"
  | "bos_up"
  | "bos_down"
  | "choch_up"
  | "choch_down"
  | "failed_breakout_up"
  | "failed_breakout_down"
  // ema
  | "ema_stack_up"
  | "ema_stack_down"
  | "ema_slope_up"
  | "ema_slope_down"
  | "ema_slope_flat"
  // momentum
  | "momentum_bull"
  | "momentum_bear"
  | "momentum_flat"
  // volume
  | "volume_expansion"
  | "volume_contraction"
  // volatility
  | "atr_expansion"
  | "atr_contraction"
  | "atr_normal"
  // data quality
  | "insufficient_history"
  | "stale_data"
  | "missing_fields";

export type StateReasonCode =
  | "htf_missing_or_stale"
  | "ltf_not_aligned"
  | "aligned_pending_hysteresis"
  | "aligned_confirmed"
  | "score_delta_jump"
  | "weakening_ltf_lost"
  | "invalidated_structure"
  | "invalidated_flip_blocked"
  | "invalidated_htf_flipped";

export type OutcomeReasonCode =
  | "target_hit"
  | "invalidation_hit"
  | "window_expired"
  | "insufficient_forward_data";

/** Client-side prose lookup. Kept tiny; the UI extends this. */
export const REASON_PROSE: Record<string, string> = {
  structure_hh_hl: "Higher highs and higher lows",
  structure_lh_ll: "Lower highs and lower lows",
  structure_range: "Ranging structure",
  bos_up: "Break of structure — bullish",
  bos_down: "Break of structure — bearish",
  choch_up: "Change of character — bullish",
  choch_down: "Change of character — bearish",
  failed_breakout_up: "Failed breakout up (liquidity sweep)",
  failed_breakout_down: "Failed breakout down (liquidity sweep)",
  ema_stack_up: "EMA stack bullish",
  ema_stack_down: "EMA stack bearish",
  ema_slope_up: "Fast EMA sloping up",
  ema_slope_down: "Fast EMA sloping down",
  ema_slope_flat: "Fast EMA flat",
  momentum_bull: "Momentum bullish",
  momentum_bear: "Momentum bearish",
  momentum_flat: "Momentum flat",
  volume_expansion: "Volume expanding vs 50-bar median",
  volume_contraction: "Volume contracting vs 50-bar median",
  atr_expansion: "Volatility expanding",
  atr_contraction: "Volatility compressing",
  atr_normal: "Volatility normal",
  insufficient_history: "Not enough closed candles",
  stale_data: "Last candle is stale",
  missing_fields: "Missing OHLCV fields",
  htf_missing_or_stale: "Higher-timeframe context missing or stale",
  ltf_not_aligned: "Lower timeframes not aligned",
  aligned_pending_hysteresis: "Alignment pending 2-scan hysteresis",
  aligned_confirmed: "Alignment confirmed",
  score_delta_jump: "Weighted score jumped past hysteresis threshold",
  weakening_ltf_lost: "Lower-timeframe alignment weakening",
  invalidated_structure: "Structure invalidated",
  invalidated_flip_blocked: "Direction flip blocked — must invalidate first",
  invalidated_htf_flipped: "Higher-timeframe bias flipped",
  target_hit: "Target reached in window",
  invalidation_hit: "Invalidation reached in window",
  window_expired: "Window expired without target",
  insufficient_forward_data: "Not enough forward candles yet",
};
