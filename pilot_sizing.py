"""Owner-ratified pilot funding rule — live-worker + broker consumers.

allocation = clamp(equity - allocation_reserve_floor_usd, 0, allocation_ceiling_usd)
leverage   = min(requested_leverage, pilot.max_leverage)

Both sides (Python worker, TS broker translator) load from the SAME
shared JSON `pilot.*` block. No duplicate literal permitted.
"""
from __future__ import annotations

from shared.parity_constants import get as _pc_get

RESERVE_FLOOR_USD: float = float(_pc_get("pilot", "allocation_reserve_floor_usd"))
CEILING_USD: float = float(_pc_get("pilot", "allocation_ceiling_usd"))
MAX_LEVERAGE: int = int(_pc_get("pilot", "max_leverage"))


def pilot_allocation(equity_usd: float) -> float:
    """Working allocation for the pilot. Never negative, never above the ceiling.
    Equity below the reserve floor → 0 (nothing goes on-desk)."""
    if equity_usd is None:
        return 0.0
    try:
        eq = float(equity_usd)
    except (TypeError, ValueError):
        return 0.0
    if eq <= RESERVE_FLOOR_USD:
        return 0.0
    return min(eq - RESERVE_FLOOR_USD, CEILING_USD)


def pilot_leverage(requested_leverage: float = MAX_LEVERAGE) -> int:
    """Clamp the requested leverage to the pilot ceiling."""
    try:
        r = int(requested_leverage)
    except (TypeError, ValueError):
        r = MAX_LEVERAGE
    return max(1, min(r, MAX_LEVERAGE))
