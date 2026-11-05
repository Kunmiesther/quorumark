/**
 * REGIME → STRATEGY LEG routing — the single source of truth for which
 * strategy the engine arms in each regime.
 *
 * PURE, additive. The engine router calls `legForRegime` per symbol after
 * `classifyRegime`, then runs that leg's entry detector.
 *
 *   high_vol → Hunter          (FVG volatility specialist)
 *   trend    → Vanguard        when trend_age <= TREND_FRESH_MAX_CANDLES
 *              Accumulator     otherwise (aged trend, laddered)
 *   neutral  → Sniper          (range reversal / fakeout)
 *   null     → nobody          (undecided regime — sit out)
 *
 * Arbiter is REGIME-INDEPENDENT and runs as an overlay outside this dispatch;
 * it never occupies the armed_leg slot.
 */
import type { Regime } from "./regime";
import { REGIME_ROUTING } from "./parityConstants";

export type StrategyLeg =
  | "hunter"
  | "accumulator"
  | "sniper"
  | "sweep"
  | "dca"
  | "scout"
  | "vanguard"
  | "arbiter";

export const TREND_FRESH_MAX_CANDLES: number = REGIME_ROUTING.trend_fresh_max_candles;

/**
 * Arm the strategy leg for a regime.
 *
 * NEUTRAL now returns "sweep" (redesigned liquidity-sweep leg — 15m entry,
 * 1h momentum-hold). The engine treats "sweep" and legacy "sniper" as the
 * same code path; DB `strategy` label stays "sniper" for continuity.
 */
export function legForRegime(
  regime: Regime | null,
  trendAgeCandles?: number | null,
): StrategyLeg | null {
  switch (regime) {
    case "high_vol":
      return "hunter";
    case "trend":
      if (trendAgeCandles == null) return "accumulator";
      return trendAgeCandles <= TREND_FRESH_MAX_CANDLES ? "vanguard" : "accumulator";
    case "neutral":
      return "sweep";
    default:
      return null;
  }
}

/** DB `strategy` label for a leg — sweep persists as "sniper" for continuity. */
export function dbStrategyLabel(leg: StrategyLeg): string {
  return leg === "sweep" ? "sniper" : leg;
}
