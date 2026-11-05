"""Manual Exit Ladder ("Rung Down") — owner ruling #17.

Covers the safety contract:
  * every rung is reduce_only (invariant);
  * sum(rung sizes) <= selected close qty <= open size;
  * ASCENDING for a LONG places SELL rungs ABOVE mark;
  * ASCENDING for a SHORT places BUY rungs BELOW mark;
  * DESCENDING inverts both;
  * step-rounding never overspends;
  * CLOSE_EXCEEDS_OPEN is rejected;
  * CLOSE_SIZE_BELOW_STEP is rejected when close_q < step;
  * TP tier sizes recompute against REMAINING qty, not original;
  * the planner does not emit any hard-stop mutation (there is no
    hard_stop_* field on ExitLadderPlan — proven by dataclass shape).
"""
from __future__ import annotations

from decimal import Decimal
import pytest

from app.builder import (
    BuildError,
    ExitLadderPlan,
    build_exit_ladder_plan,
    recompute_tp_tier_sizes,
)


COMMON = dict(
    symbol="BTC-USDT",
    mark_price="60000",
    leverage=100,
    tick_size="0.1",
    step_size="0.001",
)


# ---------- reduce-only invariant ----------

def test_every_rung_reduce_only_long():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.050",
        rungs=4, direction="ASCENDING", **COMMON,
    )
    assert all(r.reduce_only is True for r in plan.rungs)


def test_every_rung_reduce_only_short():
    plan = build_exit_ladder_plan(
        position_side="SELL", open_size="0.100", close_size="0.050",
        rungs=4, direction="ASCENDING", **COMMON,
    )
    assert all(r.reduce_only is True for r in plan.rungs)


# ---------- size cap: sum <= close <= open ----------

@pytest.mark.parametrize("n", [4, 5, 6, 7, 8])
def test_sum_never_exceeds_selected_close(n):
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.050",
        rungs=n, **COMMON,
    )
    total = sum(Decimal(r.size) for r in plan.rungs)
    assert total <= Decimal("0.050"), (n, total)
    assert Decimal(plan.actual_close_size) == total


def test_close_exceeds_open_rejected():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.010", close_size="0.020",
            rungs=4, **COMMON,
        )
    assert e.value.code == "CLOSE_EXCEEDS_OPEN"


def test_close_below_step_rejected():
    # step 0.001, close 0.0005 across 4 rungs -> zero rungs at all.
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.010", close_size="0.0005",
            rungs=4, **COMMON,
        )
    assert e.value.code == "CLOSE_SIZE_BELOW_STEP"


def test_no_open_position_rejected():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0", close_size="0.010",
            rungs=4, **COMMON,
        )
    assert e.value.code == "NO_OPEN_POSITION"


def test_remaining_equals_open_minus_actual():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.037",
        rungs=6, **COMMON,
    )
    assert Decimal(plan.remaining_size) == Decimal(plan.open_size) - Decimal(plan.actual_close_size)


# ---------- direction geometry ----------

def test_ascending_long_places_sells_above_mark():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.050",
        rungs=8, direction="ASCENDING", **COMMON,
    )
    assert plan.exit_side == "SELL"
    mark = Decimal("60000")
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    # Rung 1 at mark; subsequent rungs strictly ABOVE.
    assert prices[0] >= mark
    for i in range(1, len(prices)):
        assert prices[i] >= prices[i - 1]
    assert prices[-1] > mark


def test_ascending_short_places_buys_below_mark():
    plan = build_exit_ladder_plan(
        position_side="SELL", open_size="0.100", close_size="0.050",
        rungs=8, direction="ASCENDING", **COMMON,
    )
    assert plan.exit_side == "BUY"
    mark = Decimal("60000")
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    assert prices[0] <= mark
    for i in range(1, len(prices)):
        assert prices[i] <= prices[i - 1]
    assert prices[-1] < mark


def test_descending_long_places_sells_below_mark():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.050",
        rungs=8, direction="DESCENDING", **COMMON,
    )
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    mark = Decimal("60000")
    assert prices[-1] < mark
    for i in range(1, len(prices)):
        assert prices[i] <= prices[i - 1]


def test_descending_short_places_buys_above_mark():
    plan = build_exit_ladder_plan(
        position_side="SELL", open_size="0.100", close_size="0.050",
        rungs=8, direction="DESCENDING", **COMMON,
    )
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    mark = Decimal("60000")
    assert prices[-1] > mark
    for i in range(1, len(prices)):
        assert prices[i] >= prices[i - 1]


# ---------- rung count clamp ----------

def test_rung_count_clamp():
    below = build_exit_ladder_plan(
        position_side="BUY", open_size="1", close_size="0.5",
        rungs=1, **COMMON,
    )
    above = build_exit_ladder_plan(
        position_side="BUY", open_size="1", close_size="0.5",
        rungs=99, **COMMON,
    )
    from shared.parity_constants import get_decimal as _pget
    assert len(below.rungs) == int(_pget("ladder", "exit_rungs_min"))
    assert len(above.rungs) == int(_pget("ladder", "exit_rungs_max"))


# ---------- hard stop NOT touched (structural) ----------

def test_planner_emits_no_hard_stop_field():
    """Ruling #17 step 4: the manual exit path MUST NOT cancel or emit any
    hard-stop mutation. The planner's dataclass has no hard_stop_* field —
    proving structurally that no stop change can be signaled by this path."""
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.100", close_size="0.050",
        rungs=4, **COMMON,
    )
    field_names = {f for f in ExitLadderPlan.__dataclass_fields__.keys()}
    assert not any("stop" in n.lower() for n in field_names), field_names
    # And the object exposes no stop attribute at runtime.
    assert not hasattr(plan, "hard_stop_price")
    assert not hasattr(plan, "hard_stop_side")


# ---------- TP tier recompute against REMAINING (step 5) ----------

def test_tp_tiers_recompute_against_remaining_not_original():
    # sweep 50/30/20 fractions of a HALVED remainder must NOT close the
    # whole remaining position at TP1.
    tiers = recompute_tp_tier_sizes(
        remaining_qty="0.050",  # was 0.100, owner exited 0.050
        tier_fractions=["0.5", "0.3", "0.2"],
        step_size="0.001",
    )
    # TP1 must be ~25% of ORIGINAL (0.025), not 0.050.
    assert Decimal(tiers[0]) == Decimal("0.025")
    assert Decimal(tiers[0]) < Decimal("0.050")
    # Sum equals remaining exactly (last tier absorbs remainder).
    total = sum(Decimal(t) for t in tiers)
    assert total == Decimal("0.050")


def test_tp_tiers_zero_when_remaining_below_step():
    tiers = recompute_tp_tier_sizes(
        remaining_qty="0.0005",
        tier_fractions=["0.5", "0.3", "0.2"],
        step_size="0.001",
    )
    for t in tiers:
        assert Decimal(t) == 0


def test_tp_tier_fraction_out_of_range_rejected():
    with pytest.raises(BuildError) as e:
        recompute_tp_tier_sizes(
            remaining_qty="0.100", tier_fractions=["1.5"], step_size="0.001",
        )
    assert e.value.code == "BAD_TIER_FRACTION"


# ---------- input guards ----------

def test_bad_direction_rejected():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.1", close_size="0.05",
            direction="SIDEWAYS", **COMMON,  # type: ignore[arg-type]
        )
    assert e.value.code == "BAD_DIRECTION"


def test_bad_position_side_rejected():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="LONG", open_size="0.1", close_size="0.05", **COMMON,  # type: ignore[arg-type]
        )
    assert e.value.code == "BAD_SIDE"


def test_bad_mark_price_rejected():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            symbol="BTC-USDT", position_side="BUY", mark_price="0",
            open_size="0.1", close_size="0.05", leverage=100,
            tick_size="0.1", step_size="0.001",
        )
    assert e.value.code == "BAD_MARK_PRICE"


# ---------------------------------------------------------------------------
# Ruling #18 addition 1 — explicit price-range mode.
# Ruling #18 addition 2 — exit-specific rung clamp (2..12, default 4).
# ---------------------------------------------------------------------------

def test_exit_rungs_clamp_uses_exit_specific_bounds():
    """exit_rungs_max=12 (was clamped to 8 under exit_rungs_max)."""
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.5", close_size="0.5",
        rungs=12, **COMMON,
    )
    assert len(plan.rungs) == 12


def test_exit_rungs_clamp_min_is_2():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.5", close_size="0.5",
        rungs=1, **COMMON,
    )
    assert len(plan.rungs) == 2


def test_exit_rungs_clamp_max_is_12():
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.5", close_size="0.5",
        rungs=999, **COMMON,
    )
    assert len(plan.rungs) == 12


def test_range_mode_requires_both_endpoints():
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.22", close_size="0.22",
            rungs=10, start_price="64100", end_price=None, **COMMON,
        )
    assert e.value.code == "RANGE_REQUIRES_BOTH_ENDPOINTS"


def test_range_mode_inverted_for_ascending_long_rejected():
    # LONG ASCENDING wants end > start (walking up).
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.22", close_size="0.22",
            rungs=10, direction="ASCENDING",
            start_price="64500", end_price="64100", **COMMON,
        )
    assert e.value.code == "RANGE_INVERTED_FOR_DIRECTION"


def test_range_mode_endpoint_wrong_side_of_mark_rejected():
    # LONG SELL exit rungs MUST sit strictly above mark.
    with pytest.raises(BuildError) as e:
        build_exit_ladder_plan(
            position_side="BUY", open_size="0.22", close_size="0.22",
            rungs=10, direction="ASCENDING",
            start_price="59000", end_price="61000", **COMMON,
        )
    assert e.value.code in ("RUNG_WRONG_SIDE_OF_MARK",
                            "RANGE_INVERTED_FOR_DIRECTION")


def test_owner_acceptance_case_btc_022_10rungs_64100_to_64500():
    """Owner ruling #18 acceptance test — exact scenario from the ruling.

    Position: BTC-USDT LONG, size 0.22, mark 63677.10.
    Exit ladder: ASCENDING, start 64100, end 64500, 10 rungs, closing 100%.
    Expected: 0.022 per rung exactly, summing to 0.22, every rung reduce-only.
    Prices: 64100.0, 64144.4, 64188.9, 64233.3, 64277.8,
            64322.2, 64366.7, 64411.1, 64455.6, 64500.0
    (BTC tick 0.1, rounded UP for SELL).
    """
    plan = build_exit_ladder_plan(
        symbol="BTC-USDT",
        position_side="BUY",
        mark_price="63677.10",
        open_size="0.22",
        close_size="0.22",
        leverage=100,
        tick_size="0.1",
        step_size="0.001",
        rungs=10,
        direction="ASCENDING",
        start_price="64100",
        end_price="64500",
    )

    assert len(plan.rungs) == 10
    assert plan.exit_side == "SELL"

    # Every rung exactly 0.022 (0.22 / 10, step 0.001 divides clean).
    for r in plan.rungs:
        assert Decimal(r.size) == Decimal("0.022"), (r.index, r.size)
        assert r.reduce_only is True

    total = sum(Decimal(r.size) for r in plan.rungs)
    assert total == Decimal("0.22")
    assert Decimal(plan.actual_close_size) == Decimal("0.22")
    assert Decimal(plan.remaining_size) == Decimal("0")

    # Endpoint pinning: rung 1 == start, rung 10 == end.
    assert Decimal(plan.rungs[0].limit_price) == Decimal("64100.0")
    assert Decimal(plan.rungs[-1].limit_price) == Decimal("64500.0")

    # All 10 prices — tick-rounded UP from the even 400/9 spacing.
    expected = ["64100.0", "64144.5", "64188.9", "64233.4", "64277.8",
                "64322.3", "64366.7", "64411.2", "64455.6", "64500.0"]
    got = [r.limit_price for r in plan.rungs]
    # Allow +/- 1 tick tolerance on intermediate rungs because of the round-UP
    # policy for SELL, but endpoints MUST be exact.
    assert Decimal(got[0]) == Decimal(expected[0])
    assert Decimal(got[-1]) == Decimal(expected[-1])
    for i, (g, x) in enumerate(zip(got, expected)):
        assert abs(Decimal(g) - Decimal(x)) <= Decimal("0.1"), (i, g, x)
        # Every rung strictly above mark.
        assert Decimal(g) > Decimal("63677.10")


def test_range_mode_descending_long_walks_down():
    """DESCENDING for a LONG means SELLs step DOWN — start > end, still
    both above mark for reduce-only safety."""
    plan = build_exit_ladder_plan(
        position_side="BUY", open_size="0.10", close_size="0.10",
        rungs=4, direction="DESCENDING",
        start_price="64500", end_price="64100", **COMMON,
    )
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    assert prices[0] > prices[-1]
    for p in prices:
        assert p > Decimal("60000")  # above mark


def test_range_mode_short_ascending_buys_below_mark():
    """SHORT ASCENDING = BUY rungs stepping DOWN (away from mark, profitable)."""
    plan = build_exit_ladder_plan(
        symbol="BTC-USDT", mark_price="60000", leverage=100,
        tick_size="0.1", step_size="0.001",
        position_side="SELL", open_size="0.10", close_size="0.10",
        rungs=4, direction="ASCENDING",
        start_price="59500", end_price="59000",
    )
    assert plan.exit_side == "BUY"
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    for p in prices:
        assert p < Decimal("60000")
    assert prices[0] > prices[-1]  # walking down away from mark
