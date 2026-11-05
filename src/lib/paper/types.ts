/**
 * Paper-engine public types — extracted from engine.ts (Phase 4C, step 1).
 *
 * SCOPE: type-only declarations and one tiny pure helper (`walletKey`). No
 * runtime, no I/O, no Supabase types, no strategy math. `engine.ts` re-exports
 * these so `import { ... } from "@/lib/paper/engine"` remains the public
 * surface for every existing caller.
 */
import type { Direction, TrendState } from "./signal";
import type { Regime } from "./regime";
import type { StrategyLeg } from "./routing";
import type { Decision } from "@/lib/onyx/decide";

export type PaperSymbol = string;
export type WalletKey = string; // "long" | "short" | "hedge" | "strategy"

/** Directional core strategies use one shared role wallet per direction. */
export function walletKey(symbol: PaperSymbol, dir: Direction): WalletKey {
  void symbol;
  return dir;
}

/** Per-(symbol, direction) evaluation outcome for one tick. Written into
 * `bot_events` (event='PAPER_TICK_REASONS') so a query can bucket why entries
 * did or didn't fire. Also returned in TickResult for the paper dashboard. */
export type EvalReason =
  | "opened"
  | "position_open"
  | "open_failed"
  | "floor_hit"
  | "no_confirmed_signal"
  | "blocked_by_trend_filter"
  | "blocked_no_stop_pivot"
  | "wallet_missing"
  | "symbol_disabled"
  | "armed_hunter_not_wired"
  | "no_regime"
  | "sniper_no_zone"
  | "sniper_no_entry"
  | "sniper_vwap_unavailable"
  | "sniper_vwap_not_profitable"
  | "sniper_no_sweep"
  | "hunter_no_fvg"
  | "hunter_no_retest"
  | "hunter_no_swing_target"
  | "onyx_skipped"
  | "onyx_held"
  | "onyx_capacity"
  | "onyx_benched"
  | "onyx_correlated"
  | "onyx_no_call"
  | "onyx_fallback"
  | "scout_bos"
  | "reentry_lockout"
  | "htf_bos_exit"
  | "runner_breakeven_stop"
  | "already_traded"
  | "blocked_wait_regime"
  | "blocked_universe_capacity"
  | "blocked_by_setup_timeframes"
  | "hedge_proposed"
  | "hedge_rejected"
  | "scout_no_candle"
  | "scout_ingested";

export interface EvaluationDetail {
  symbol: PaperSymbol;
  direction: Direction;
  outcome: EvalReason;
  reason: string;
  trend: TrendState | null;
  trend_slope_pct: number | null;
  fresh_count: number;
}

export interface TickResult {
  ranAt: number;
  perSymbol: Array<{
    symbol: PaperSymbol;
    newestCandleTs: number | null;
    opened: number;
    closed: number;
    trend?: TrendState | null;
    trendEma?: number | null;
    trendSlopePct?: number | null;
    blockedLong?: number;
    blockedShort?: number;
    regime?: Regime | null;
    armedLeg?: StrategyLeg | null;
    /** HTF (1h) BOS telemetry — Phase 1 observe-only. */
    htf_bos_state?: "bullish_bos" | "bearish_bos" | "none";
    htf_bos_confirmed_at?: number | null;
    htf_bos_bars_since?: number | null;
    error?: string;
  }>;
  evaluations: EvaluationDetail[];
  /** True when PAPER_ENGINE_ENABLED is off and the tick exited immediately. */
  disabled?: boolean;
  onyx?: {
    candidates: number;
    approved: number;
    rejected: number;
    aiCalled: boolean;
    aiError: string | null;
    usedFallback: boolean;
    narrative: string;
    skipReason: Decision["skipReason"];
  };
}
