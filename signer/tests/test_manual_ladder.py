"""Manual Deploy Formation — ladder planner arithmetic + LIMIT builder.

Covers the owner-ratified safety requirements:
  * per-rung margin sums to no more than ladder.dca_total_margin_usd (60);
  * the current five-rung deploy spends at most 60 total, NOT 300;
  * LIMIT rung prices round to tick in the correct direction (BUY DOWN,
    SELL UP) so a rung is never worse than requested;
  * MARKET behavior is byte-identical to the pre-change baseline (also
    guarded by the pre-existing test_builder.py suite).
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.builder import (
    BuildError, BuildInput, build_order, build_ladder_plan,
)
from shared.parity_constants import get_decimal as _pget


LADDER_ARGS = dict(
    symbol="BTC-USDT", side="BUY", mark_price="60000", leverage=100,
    tick_size="0.1", step_size="0.001", decimals=8, l2_pair_id=1,
    taker_fee_rate="0.0005", maker_fee_rate="0.0002",
)


def _total_margin() -> Decimal:
    return _pget("ladder", "dca_total_margin_usd")


def test_ladder_default_rungs_actual_margin_never_exceeds_total():
    plan = build_ladder_plan(**LADDER_ARGS)
    actual = sum(Decimal(r.margin_usd) for r in plan.rungs)
    assert actual <= _total_margin(), (actual, _total_margin())
    # LadderPlan reports ACTUAL, not intended.
    assert Decimal(plan.total_margin_usd) == actual


@pytest.mark.parametrize("n", [4, 5, 6, 7, 8])
def test_ladder_is_fixed_at_five_and_actual_margin_bounded(n):
    plan = build_ladder_plan(**LADDER_ARGS, rungs=n)
    actual = sum(Decimal(r.margin_usd) for r in plan.rungs)
    assert actual <= _total_margin(), (n, actual)
    assert len(plan.rungs) == 5


def test_five_rung_actual_margin_le_60_computed_from_built_notional():
    """ACTUAL guard, not the tautological intended-sum. Uses built.notional_usd
    divided by leverage — the same computation the OVERSPEND check runs."""
    plan = build_ladder_plan(**LADDER_ARGS, rungs=5)
    actual = sum(
        Decimal(r.built.notional_usd) / Decimal(plan.leverage)
        for r in plan.rungs
    )
    assert actual <= Decimal("60"), actual
    assert actual != Decimal("300")


def test_requested_four_rungs_clamp_to_five_and_margin_le_60():
    plan = build_ladder_plan(**LADDER_ARGS, rungs=4)
    assert len(plan.rungs) == 5
    actual = sum(
        Decimal(r.built.notional_usd) / Decimal(plan.leverage)
        for r in plan.rungs
    )
    assert actual <= Decimal("60"), actual


def test_ladder_high_step_symbol_rung_rounds_down_and_under_target():
    """BTC-USDT at ~$118k with five rungs targets $12 per rung. The venue
    step must round size down, never exceed that rung's intended margin."""
    plan = build_ladder_plan(**{**LADDER_ARGS, "mark_price": "118000"}, rungs=5)
    for r in plan.rungs:
        actual_margin = Decimal(r.built.notional_usd) / Decimal(plan.leverage)
        assert actual_margin <= Decimal("12"), (r.index, actual_margin)
        # And the size itself is on the step grid, rounded DOWN.
        assert Decimal(r.size) <= Decimal("0.011"), r.size


def test_ladder_overspend_raises_when_actual_exceeds_total(monkeypatch):
    """Deliberate construction: patch build_order to return an inflated
    notional so actual_total_margin > total_margin. The ACTUAL guard must
    fire, not the intended-margin tautology."""
    import app.builder as _b

    real_build = _b.build_order

    def _inflated_build(inp: BuildInput):
        out = real_build(inp)
        # Inflate notional by 2x — sum will now be ~2x total_margin.
        return _b.BuiltOrder(
            symbol=out.symbol, side=out.side, order_type=out.order_type,
            size=out.size, protected_price=out.protected_price,
            mark_price=out.mark_price,
            notional_usd=format((Decimal(out.notional_usd) * 2).normalize(), "f"),
            margin_usd=out.margin_usd, leverage=out.leverage,
            l2_pair_id=out.l2_pair_id, decimals=out.decimals,
            taker_fee_rate=out.taker_fee_rate, maker_fee_rate=out.maker_fee_rate,
            slippage_bps=out.slippage_bps,
        )

    monkeypatch.setattr(_b, "build_order", _inflated_build)
    with pytest.raises(BuildError) as e:
        build_ladder_plan(**LADDER_ARGS, rungs=4)
    assert e.value.code == "LADDER_OVERSPEND"


def test_ladder_rung_clamp():
    below = build_ladder_plan(**LADDER_ARGS, rungs=1)
    above = build_ladder_plan(**LADDER_ARGS, rungs=99)
    assert len(below.rungs) == int(_pget("ladder", "dca_rungs_min"))
    assert len(above.rungs) == int(_pget("ladder", "dca_rungs_max"))


def test_limit_price_rounds_toward_safe_side():
    # BUY resting rung must round DOWN (never up into worse price).
    b = build_order(BuildInput(
        symbol="BTC-USDT", side="BUY", mark_price="60000", leverage=100,
        capital_baseline_usd="0", tick_size="0.1", step_size="0.001",
        decimals=8, l2_pair_id=1,
        taker_fee_rate="0.0005", maker_fee_rate="0.0002",
        order_type="LIMIT", limit_price="59999.567",
        margin_override_usd="7.5",
    ))
    assert b.order_type == "LIMIT"
    assert Decimal(b.protected_price) == Decimal("59999.5")

    # SELL resting rung must round UP.
    s = build_order(BuildInput(
        symbol="BTC-USDT", side="SELL", mark_price="60000", leverage=100,
        capital_baseline_usd="0", tick_size="0.1", step_size="0.001",
        decimals=8, l2_pair_id=1,
        taker_fee_rate="0.0005", maker_fee_rate="0.0002",
        order_type="LIMIT", limit_price="60000.123",
        margin_override_usd="7.5",
    ))
    assert Decimal(s.protected_price) == Decimal("60000.2")


def test_limit_requires_price():
    with pytest.raises(BuildError) as e:
        build_order(BuildInput(
            symbol="BTC-USDT", side="BUY", mark_price="60000", leverage=100,
            capital_baseline_usd="0", tick_size="0.1", step_size="0.001",
            decimals=8, l2_pair_id=1,
            taker_fee_rate="0.0005", maker_fee_rate="0.0002",
            order_type="LIMIT", limit_price=None,
            margin_override_usd="7.5",
        ))
    assert e.value.code == "LIMIT_PRICE_REQUIRED"


def test_market_behavior_unchanged_baseline():
    # This mirrors test_builder.py::test_sizing_reads_ladder_margin — proves
    # the MARKET path is byte-identical after the LIMIT extension.
    b = build_order(BuildInput(
        symbol="BTC-USDT", side="BUY", mark_price="60000", leverage=100,
        capital_baseline_usd="0", tick_size="0.1", step_size="0.001",
        decimals=8, l2_pair_id=1,
        taker_fee_rate="0.0005", maker_fee_rate="0.0002",
    ))
    assert b.order_type == "MARKET"
    assert Decimal(b.margin_usd) == Decimal("60")
    assert Decimal(b.notional_usd) == Decimal("6000")


def test_ladder_hard_stop_below_deepest_buy_rung():
    plan = build_ladder_plan(**LADDER_ARGS, rungs=8)
    deepest = min(Decimal(r.limit_price) for r in plan.rungs)
    assert plan.hard_stop_side == "SELL"
    assert Decimal(plan.hard_stop_price) < deepest


def test_ladder_hard_stop_above_deepest_sell_rung():
    plan = build_ladder_plan(**{**LADDER_ARGS, "side": "SELL"}, rungs=8)
    deepest = max(Decimal(r.limit_price) for r in plan.rungs)
    assert plan.hard_stop_side == "BUY"
    assert Decimal(plan.hard_stop_price) > deepest


def test_ladder_rungs_step_against_position():
    plan = build_ladder_plan(**LADDER_ARGS, rungs=8)
    prices = [Decimal(r.limit_price) for r in plan.rungs]
    # BUY: rung 1 at (or near) mark, subsequent rungs step DOWN.
    for i in range(1, len(prices)):
        assert prices[i] <= prices[i - 1]
