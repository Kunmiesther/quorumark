"""Accumulator take-profit ladder — S39 (closes B-1 / G33).

OWNER-RATIFIED, NOT INFERRED
----------------------------
Implements docs/STRATEGY_SPEC_v1_ADDENDUM_A_CANDIDATE.md S39, confirmed by
owner ruling 2026-07-17 ("Option A — close the entire cycle at the target
derived from the first entry"). S39 and that ruling agree: rung 3 anchors to
the FIRST FILLED entry, not the re-anchored average.

    original_first_entry_target_margin_return_pct = 400

    TP1  200% margin ROI on the CURRENT average entry  -> sell half
    TP2  300% margin ROI on the CURRENT average entry  -> sell half of remainder
    TP3  400% margin ROI on the FROZEN first-fill VWAP -> sell_rest_full_close

Basis is MARGIN, per v1 `take_profit.basis: margin` and G3 (owner example
S10: 1650 -> 1670 = 1.212% price = 121% margin ROI at 100x). So a target of
N% margin return is a price move of (N/100)/leverage:

    long:  entry x (1 + (pct/100)/leverage)
    short: entry x (1 - (pct/100)/leverage)

THE ANCHOR IS THE WHOLE POINT
-----------------------------
TP3 freezes on the actual first filled entry's VWAP at its completed-fill
state. It does NOT move when later rungs fill and pull the average down. That
is the entire meaning of `original_first_entry_target`, and re-anchoring it
would silently convert the strategy into something else.

FAIL CLOSED
-----------
S39: "Invalid/unrepresentable/wrong-side/out-of-bounds target -> fail closed."
A short at leverage <= 4 produces a target of zero or negative — not a bad
price, an impossible one. It raises rather than clamping. Clamping an
impossible exit into a plausible one is how a strategy silently stops being
the strategy.

Gross target, before fees / funding / slippage. Those still count in net P&L
and safeguards (S39) and are NOT modelled here.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal

Side = Literal["long", "short"]

from shared.parity_constants import get as _pc_get
# TP margin-ROI ladder (S39). NOT sourced from shared parity JSON because the
# live-side accumulator TP semantics (margin-ROI ladder) DIVERGE from the
# paper engine's per-rung +1 % price TP — see MAINNET_PARITY.md §7.
TP1_MARGIN_RETURN_PCT = Decimal(200)
TP2_MARGIN_RETURN_PCT = Decimal(300)
ORIGINAL_FIRST_ENTRY_TARGET_MARGIN_RETURN_PCT = Decimal(400)  # S39

# Terminal fill states gating TP3. S39: "TP3 cannot execute before TP1 and TP2
# reach terminal filled states."
TERMINAL_FILLED = frozenset({"filled"})


class ExitRuleError(Exception):
    """Fail-closed. `code` is static and carries no price material."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _target_price(entry: Decimal, side: Side, pct: Decimal, leverage: Decimal) -> Decimal:
    if leverage <= 0:
        raise ExitRuleError("LEVERAGE_NOT_POSITIVE")
    if entry <= 0:
        raise ExitRuleError("ENTRY_NOT_POSITIVE")
    move = (pct / Decimal(100)) / leverage
    if side == "long":
        target = entry * (Decimal(1) + move)
    elif side == "short":
        target = entry * (Decimal(1) - move)
    else:
        raise ExitRuleError("SIDE_INVALID")

    # S39 fail-closed bounds.
    if target <= 0:
        # e.g. short 400% at leverage <= 4 -> zero or negative. Impossible,
        # not merely bad. Never clamp.
        raise ExitRuleError("TARGET_UNREPRESENTABLE")
    if side == "long" and target <= entry:
        raise ExitRuleError("TARGET_WRONG_SIDE")
    if side == "short" and target >= entry:
        raise ExitRuleError("TARGET_WRONG_SIDE")
    return target


def original_first_entry_target(first_fill_vwap, side: Side, leverage) -> Decimal:
    """S39 rung 3. FROZEN at the first filled entry's VWAP.

    `first_fill_vwap` MUST be the actual first filled entry's VWAP at its
    completed-fill state — never the re-anchored running average.
    """
    try:
        vwap = Decimal(str(first_fill_vwap))
        lev = Decimal(str(leverage))
    except (InvalidOperation, TypeError, ValueError):
        raise ExitRuleError("TARGET_INVALID_INPUT")
    return _target_price(vwap, side, ORIGINAL_FIRST_ENTRY_TARGET_MARGIN_RETURN_PCT, lev)


def tp1_target(current_avg_entry, side: Side, leverage) -> Decimal:
    """200% margin ROI on the CURRENT average entry (moves as rungs fill)."""
    try:
        avg = Decimal(str(current_avg_entry)); lev = Decimal(str(leverage))
    except (InvalidOperation, TypeError, ValueError):
        raise ExitRuleError("TARGET_INVALID_INPUT")
    return _target_price(avg, side, TP1_MARGIN_RETURN_PCT, lev)


def tp2_target(current_avg_entry, side: Side, leverage) -> Decimal:
    """300% margin ROI on the CURRENT average entry."""
    try:
        avg = Decimal(str(current_avg_entry)); lev = Decimal(str(leverage))
    except (InvalidOperation, TypeError, ValueError):
        raise ExitRuleError("TARGET_INVALID_INPUT")
    return _target_price(avg, side, TP2_MARGIN_RETURN_PCT, lev)


@dataclass(frozen=True)
class LadderState:
    tp1_state: str
    tp2_state: str


def tp3_may_execute(state: LadderState) -> bool:
    """S39: TP3 cannot execute before TP1 AND TP2 reach terminal filled states.
    Anything not explicitly terminal-filled is a refusal — fail closed."""
    return state.tp1_state in TERMINAL_FILLED and state.tp2_state in TERMINAL_FILLED
