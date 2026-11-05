/**
 * SNIPER PROFILE — shallow ladder + volatility-scaled early TP.
 *
 * Sniper is the counter-trend / mean-reversion leg armed in neutral regimes.
 * Because chop pays small and reverts, the ladder is intentionally SHALLOW
 * (SNIPER_MAX_RUNGS = 2 → initial + 1 add) and the TP is a NEAR target
 * measured from the CURRENT avg entry:
 *
 *   tp_distance = max(
 *     SNIPER_TP_ATR_MULT × ATR(14) on 5m,
 *     avgEntry × SNIPER_TP_MIN_NET_PCT   // floor so a win can't be a fee donation
 *   )
 *
 *   tp_price = long  → avgEntry + tp_distance
 *              short → avgEntry - tp_distance
 *
 * Both constants live in shared/mainnet_parity_constants.json (`sniper` group)
 * and are mirrored to the live worker via shared/parity_constants.py.
 *
 * NOTE: promotion (htf_promotion) still applies — an early TP is the DEFAULT
 * exit path but a sniper position that qualifies for HTF promotion before its
 * TP is touched is promoted, NOT TP'd, on that tick's ordering. The engine
 * evaluates promotion strictly BEFORE the per-lot TP check.
 */
import type { Direction } from "./signal";
import { SNIPER } from "./parityConstants";

export const SNIPER_MAX_RUNGS: number = (SNIPER as { max_rungs: number }).max_rungs;
export const SNIPER_TP_ATR_MULT: number = (SNIPER as { tp_atr_mult: number }).tp_atr_mult;
export const SNIPER_TP_MIN_NET_PCT: number = (SNIPER as { tp_min_net_pct: number }).tp_min_net_pct;

/**
 * Compute the sniper early-TP price for a given avg-entry and ATR(14).
 * Returns a price that is at least the floor-percent away from the avg
 * so the TP can never be inside modeled round-trip fees + slippage.
 *
 * The `atr` argument MUST be a positive ATR on the 5m timeframe (units:
 * price). Callers with a null / non-positive ATR should skip sniper entries
 * upstream — this helper always applies the floor, so it never returns an
 * unfilled TP, but a zero ATR degenerates into the floor-only geometry.
 */
export function sniperTpPrice(
  avgEntry: number,
  direction: Direction,
  atr: number | null | undefined,
): number {
  if (!(avgEntry > 0)) return avgEntry;
  const a = atr && atr > 0 ? atr : 0;
  const atrDist = SNIPER_TP_ATR_MULT * a;
  const floorDist = avgEntry * SNIPER_TP_MIN_NET_PCT;
  const dist = Math.max(atrDist, floorDist);
  return direction === "long" ? avgEntry + dist : avgEntry - dist;
}
