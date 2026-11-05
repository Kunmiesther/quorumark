"""Effective TP — Python mirror of src/lib/paper/effectiveTp.ts.

FIX 1 (TP mismatch, live-money-critical): the live worker exit loop MUST
use the same effective-TP rule as the paper engine — the nearer of the
per-lot rung TP and the position's strategy tp_level wins for the position
direction. When tp_level is missing/invalid the per-lot rung TP stands.

Callers that compare current price to a rung TP should first pass that
rung TP through `effective_tp(direction, rung_tp, position_tp_level)`.

See docs/MAINNET_PARITY.md §2.
"""
from __future__ import annotations

from typing import Literal, Optional

Direction = Literal["long", "short"]


def effective_tp(direction: Direction, lot_tp: float,
                 position_tp_level: Optional[float]) -> float:
    if position_tp_level is None:
        return lot_tp
    try:
        tp_l = float(position_tp_level)
    except (TypeError, ValueError):
        return lot_tp
    if tp_l <= 0 or tp_l != tp_l:  # <=0 or NaN
        return lot_tp
    return min(lot_tp, tp_l) if direction == "long" else max(lot_tp, tp_l)
