"""Regime → strategy-leg routing — live-worker mirror of
`src/lib/paper/routing.ts`. DEBT-03 closure.

Pure. Same routing table as TS; trend split by trend_age via
`regime_routing.trend_fresh_max_candles`.

REDESIGN 2026-07-26: neutral regime now returns "sweep" (was "sniper").
Turtle identity/DB label stays "sniper" for continuity — that mapping is
done by the caller. The armed_leg / SIGNAL_EVALUATION telemetry uses
"sweep".
"""
from __future__ import annotations

from typing import Optional

from shared.parity_constants import get as _pc_get

TREND_FRESH_MAX_CANDLES: int = int(_pc_get("regime_routing", "trend_fresh_max_candles"))

StrategyLeg = str  # matches enums.legs in the shared JSON


def leg_for_regime(regime: Optional[str], trend_age_candles: Optional[int] = None) -> Optional[StrategyLeg]:
    if regime == "high_vol":
        return "hunter"
    if regime == "trend":
        if trend_age_candles is None:
            return "accumulator"
        return "vanguard" if trend_age_candles <= TREND_FRESH_MAX_CANDLES else "accumulator"
    if regime == "neutral":
        return "sweep"
    return None
