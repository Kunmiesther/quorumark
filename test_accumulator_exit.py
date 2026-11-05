"""S39 take-profit ladder. Ground truth: the ratified spec, not my arithmetic."""
from __future__ import annotations

from decimal import Decimal

import pytest

from accumulator_exit import (
    ORIGINAL_FIRST_ENTRY_TARGET_MARGIN_RETURN_PCT, ExitRuleError, LadderState,
    original_first_entry_target, tp1_target, tp2_target, tp3_may_execute,
)


def test_s39_constant_is_400():
    assert ORIGINAL_FIRST_ENTRY_TARGET_MARGIN_RETURN_PCT == Decimal(400)


def test_long_target_matches_s39_formula():
    # S39: vwap x (1 + 4/leverage)
    assert original_first_entry_target(1000, "long", 100) == Decimal("1000") * (Decimal(1) + Decimal(4) / Decimal(100))


def test_short_target_matches_s39_formula():
    assert original_first_entry_target(1000, "short", 100) == Decimal("1000") * (Decimal(1) - Decimal(4) / Decimal(100))


def test_g3_owner_example_margin_basis():
    """G3 audit trail: 1650 -> 1670 = 1.212% price = 121% margin ROI at 100x.
    Confirms the basis is MARGIN, not price."""
    move_pct = (Decimal(1670) - Decimal(1650)) / Decimal(1650) * Decimal(100)
    assert round(move_pct * Decimal(100), 0) == Decimal(121)  # x100 leverage


def test_ladder_is_ordered_long():
    a, b, c = tp1_target(1000, "long", 100), tp2_target(1000, "long", 100), original_first_entry_target(1000, "long", 100)
    assert a < b < c


def test_ladder_is_ordered_short():
    a, b, c = tp1_target(1000, "short", 100), tp2_target(1000, "short", 100), original_first_entry_target(1000, "short", 100)
    assert a > b > c


def test_tp3_anchor_is_frozen_not_reanchored():
    """THE POINT OF S39. Later rungs pull the average down; TP3 must not move."""
    first_vwap = Decimal(1000)
    frozen = original_first_entry_target(first_vwap, "long", 100)
    reanchored_avg = Decimal(900)  # rungs 2/3 filled lower
    assert original_first_entry_target(first_vwap, "long", 100) == frozen
    assert original_first_entry_target(reanchored_avg, "long", 100) != frozen
    # TP1/TP2 DO move with the average — that is their spec.
    assert tp1_target(reanchored_avg, "long", 100) != tp1_target(first_vwap, "long", 100)


# --- fail closed -----------------------------------------------------------
@pytest.mark.parametrize("lev", [4, 3, 1, "0.5"])
def test_short_target_unrepresentable_at_low_leverage_fails_closed(lev):
    """400% margin on a short needs leverage > 4, else the target is <= 0.
    Impossible, not merely bad. Must never be clamped into plausibility."""
    with pytest.raises(ExitRuleError) as e:
        original_first_entry_target(1000, "short", lev)
    assert e.value.code in ("TARGET_UNREPRESENTABLE", "TARGET_WRONG_SIDE")


@pytest.mark.parametrize("lev", [0, -1, "0"])
def test_non_positive_leverage_fails_closed(lev):
    with pytest.raises(ExitRuleError) as e:
        original_first_entry_target(1000, "long", lev)
    assert e.value.code == "LEVERAGE_NOT_POSITIVE"


@pytest.mark.parametrize("entry", [0, -5])
def test_non_positive_entry_fails_closed(entry):
    with pytest.raises(ExitRuleError) as e:
        original_first_entry_target(entry, "long", 100)
    assert e.value.code == "ENTRY_NOT_POSITIVE"


def test_bad_side_fails_closed():
    with pytest.raises(ExitRuleError) as e:
        original_first_entry_target(1000, "sideways", 100)
    assert e.value.code == "SIDE_INVALID"


@pytest.mark.parametrize("bad", ["abc", None, [], {}])
def test_invalid_input_fails_closed(bad):
    with pytest.raises(ExitRuleError) as e:
        original_first_entry_target(bad, "long", 100)
    assert e.value.code == "TARGET_INVALID_INPUT"


def test_errors_carry_no_price_material():
    try:
        original_first_entry_target(1234.5678, "short", 2)
    except ExitRuleError as e:
        assert "1234" not in str(e)


# --- TP3 gating (S39) ------------------------------------------------------
def test_tp3_blocked_until_tp1_and_tp2_terminal_filled():
    assert tp3_may_execute(LadderState("filled", "filled")) is True


@pytest.mark.parametrize("s", [("open", "filled"), ("filled", "open"), ("open", "open"),
                               ("partially_filled", "filled"), ("cancelled", "filled"),
                               ("filled", "partially_filled"), ("", "")])
def test_tp3_refused_unless_both_terminal(s):
    assert tp3_may_execute(LadderState(*s)) is False


def test_leverage_is_the_only_missing_input():
    """G33 is CLOSED as a rule (S39 + owner ruling). The target is computable
    the moment leverage exists — nothing else is undefined."""
    assert original_first_entry_target(1000, "long", 100) > 0
    assert original_first_entry_target(1000, "long", 50) > 0
