"""BUILD_ORDER arithmetic — proves sizing follows shared parity JSON."""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.builder import (
    ACCOUNT_FLOOR_USD, STRATEGY_CAP_USD,
    BuildError, BuildInput, build_order,
)
from shared.parity_constants import get_decimal as _pget


BASE = dict(
    symbol="BTC-USDT", side="BUY", mark_price="60000",
    leverage=100, capital_baseline_usd="0",
    tick_size="0.1", step_size="0.001", decimals=8, l2_pair_id=1,
    taker_fee_rate="0.0005", maker_fee_rate="0.0002",
)


def test_sizing_reads_ladder_margin_from_parity_json():
    # target_margin = ladder.dca_total_margin_usd = 60
    # target_notional at 100x = 60 * 100 = 6000
    # step 0.001 at $60k -> raw_size 0.1, notional 6000
    b = build_order(BuildInput(**BASE))
    assert Decimal(b.margin_usd) == Decimal("60")
    assert Decimal(b.notional_usd) == Decimal("6000")
    assert b.leverage == 100


def test_step_rounds_at_high_btc_mark():
    b = build_order(BuildInput(**{**BASE, "mark_price": "118000"}))
    # 6000/118000 = 0.05084 -> nearest step 0.001 -> 0.051 -> notional 6018
    assert b.size == "0.051"
    assert Decimal(b.notional_usd) == Decimal("6018")


def test_sizing_scales_with_leverage_at_one_x():
    b = build_order(BuildInput(**{**BASE, "leverage": 1}))
    # target_margin=60, notional=60 at 1x
    assert Decimal(b.margin_usd) == Decimal(b.notional_usd)
    assert Decimal(b.notional_usd) == Decimal("60")


def test_capital_baseline_usd_is_ignored():
    # Field is deprecated; any value works (including wildly different ones)
    # and produces the same result — sizing does not read it.
    a = build_order(BuildInput(**{**BASE, "capital_baseline_usd": "0"}))
    b = build_order(BuildInput(**{**BASE, "capital_baseline_usd": "9999"}))
    assert a.size == b.size
    assert a.notional_usd == b.notional_usd


def test_bad_leverage_refused():
    for lev in (0, -1, 101):
        with pytest.raises(BuildError):
            build_order(BuildInput(**{**BASE, "leverage": lev}))


def test_protected_price_respects_side():
    long = build_order(BuildInput(**BASE))
    short = build_order(BuildInput(**{**BASE, "side": "SELL"}))
    assert Decimal(long.protected_price) > Decimal(long.mark_price)
    assert Decimal(short.protected_price) < Decimal(short.mark_price)


def test_step_too_coarse_refused():
    # step 1 BTC at $60k -> minimum step_notional $60k; target $6k drift huge.
    with pytest.raises(BuildError) as e:
        build_order(BuildInput(**{**BASE, "step_size": "1"}))
    assert e.value.code in ("SIZE_TOO_SMALL", "NOTIONAL_ROUND_ERROR")


def test_bounds_sourced_from_shared_parity_json():
    assert ACCOUNT_FLOOR_USD == _pget("pilot", "allocation_reserve_floor_usd")
    assert STRATEGY_CAP_USD == _pget("pilot", "allocation_ceiling_usd")
    assert ACCOUNT_FLOOR_USD == Decimal("100")
    assert STRATEGY_CAP_USD == Decimal("500")



# --- tick-size rounding -----------------------------------------------------

from decimal import Decimal as _D
from app.builder import round_price_to_tick, round_size_to_step


def _tick_ok(price: str, tick: str) -> bool:
    p = _D(price); t = _D(tick)
    return (p / t) == (p / t).to_integral_value()


def test_round_price_to_tick_btc():
    # ApeX BTC-USDT: tick 0.1 — 62132.565 must snap to 62132.5 (DOWN)
    # or 62132.6 (UP).
    assert round_price_to_tick("62132.565", "0.1", "DOWN") == "62132.5"
    assert round_price_to_tick("62132.565", "0.1", "UP") == "62132.6"


def test_round_price_to_tick_fine_symbol():
    # Fine-tick symbol (e.g. DOGE-USDT tick 0.00001).
    assert round_price_to_tick("0.123456789", "0.00001", "DOWN") == "0.12345"
    assert round_price_to_tick("0.123456789", "0.00001", "UP") == "0.12346"


def test_no_price_we_send_violates_tick():
    # Every price the builder emits (protected_price) must sit on the tick
    # grid for both a coarse-tick and a fine-tick symbol.
    for tick, mark in (("0.1", "62132.565"), ("0.00001", "0.1234567")):
        cfg = {**BASE, "mark_price": mark, "tick_size": tick,
               # step must be feasible for the target notional
               "step_size": "0.001" if tick == "0.1" else "1"}
        for side in ("BUY", "SELL"):
            b = build_order(BuildInput(**{**cfg, "side": side}))
            assert _tick_ok(b.protected_price, tick), (side, tick, b.protected_price)


def test_round_size_to_step_btc():
    # BTC step 0.001 — 0.0019 must snap DOWN to 0.001; 0.0025 to 0.002.
    assert round_size_to_step("0.0019", "0.001") == "0.001"
    assert round_size_to_step("0.0025", "0.001") == "0.002"


def test_bad_round_direction_refused():
    with pytest.raises(BuildError):
        round_price_to_tick("100", "0.1", "NEAREST")
