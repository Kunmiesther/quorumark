"""AUTHORITATIVE SIZING CONTRACT — the signer must not recompute a size the
caller's intent already fixed. It only quantizes DOWN onto the venue step;
authenticated free collateral and venue limits are enforced in preflight."""
from decimal import Decimal

import pytest

from app.builder import BuildError, BuildInput, build_order


def _inp(**kw) -> BuildInput:
    base = dict(
        symbol="BTC-USDT",
        side="BUY",
        mark_price="60000",
        leverage=100,
        capital_baseline_usd="0",
        tick_size="0.1",
        step_size="0.001",
        decimals=6,
        l2_pair_id=1,
        taker_fee_rate="0.0005",
        maker_fee_rate="0.0002",
    )
    base.update(kw)
    return BuildInput(**base)


def test_size_override_is_used_verbatim_when_on_step_grid():
    built = build_order(_inp(size_override="0.05"))
    assert built.size == "0.05"
    assert Decimal(built.notional_usd) == Decimal("0.05") * Decimal("60000")


def test_size_override_quantizes_down_never_up():
    built = build_order(_inp(size_override="0.0509"))
    assert built.size == "0.05"


def test_size_override_has_no_application_level_dollar_cap():
    built = build_order(_inp(size_override="100"))
    assert built.size == "100"
    assert Decimal(built.margin_usd) == Decimal("60000")


def test_size_override_refuses_non_positive():
    with pytest.raises(BuildError) as e:
        build_order(_inp(size_override="0"))
    assert e.value.code == "BAD_SIZE_OVERRIDE"


def test_size_override_below_one_step_refuses():
    with pytest.raises(BuildError) as e:
        build_order(_inp(size_override="0.0009"))
    assert e.value.code == "SIZE_TOO_SMALL"


def test_no_override_keeps_ladder_derived_sizing():
    a = build_order(_inp())
    b = build_order(_inp(size_override=None))
    assert a.size == b.size
    assert Decimal(a.size) > 0


def test_size_override_market_protected_price_unchanged():
    a = build_order(_inp())
    b = build_order(_inp(size_override="0.01"))
    assert a.protected_price == b.protected_price


def test_size_override_limit_prices_off_the_rung_limit():
    built = build_order(_inp(order_type="LIMIT", limit_price="59000.07",
                             size_override="0.02"))
    assert built.protected_price == "59000"
    assert built.size == "0.02"
