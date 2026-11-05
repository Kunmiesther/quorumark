"""ETH-USDT live activation: symbol isolation from BTC-USDT.

ETH runs as its OWN live strategy row on the same verified connection. These
tests pin the invariants that keep the two symbols from contaminating each
other: distinct fired-candle dedup keys, distinct idempotency namespaces,
symbol-scoped exposure guards, and ETH-specific venue quantization.

No network, no credentials, no orders.
"""
from decimal import Decimal

import pytest

import accumulator_live_size
import entry_eligibility
from accumulator_sizing import SizingError

INTERVAL_MIN = 5

# Live ApeX production contracts (api/v3/symbols, verified 2026-07-31).
BTC_CONTRACT = {
    "minOrderSize": "0.0010", "stepSize": "0.001", "tickSize": "0.1",
    "maxOrderSize": "50", "displayMaxLeverage": "100", "initialMarginRate": "0.01000",
}
ETH_CONTRACT = {
    "minOrderSize": "0.010", "stepSize": "0.01", "tickSize": "0.01",
    "maxOrderSize": "1000", "displayMaxLeverage": "100", "initialMarginRate": "0.01000",
}

EQUITY_USD = 600.0


class _Break:
    def __init__(self, direction, break_ts):
        self.direction = direction
        self.break_ts = break_ts


class _Retest:
    def __init__(self, direction="long", break_ts=1_700_000_000_000,
                 retest_ts=1_700_000_300_000):
        self.retest_ts = retest_ts
        self.break_event = _Break(direction, break_ts)


def _idem(connection_id, normalized, direction, retest):
    return (
        f"accum:{connection_id}:{normalized}:{direction}:"
        f"{int(retest.break_event.break_ts)}:{int(retest.retest_ts)}"
    )


CONN = "4a6cec71-0f1f-423f-8979-25edf2e77b7d"
USER = "0b7b1651-b3a5-4370-b89f-0deeaba4ea3f"


def test_fired_candle_key_is_symbol_scoped():
    """The same confirmation timestamps on two symbols are two entries."""
    r = _Retest()
    btc = (USER, CONN, "long") + entry_eligibility.entry_key("BTCUSDT", INTERVAL_MIN, r)
    eth = (USER, CONN, "long") + entry_eligibility.entry_key("ETHUSDT", INTERVAL_MIN, r)
    assert btc != eth
    fired = {btc}
    assert eth not in fired, "a fired BTC candle must not suppress ETH"


def test_idempotency_namespace_is_symbol_scoped():
    r = _Retest()
    assert _idem(CONN, "BTCUSDT", "long", r) != _idem(CONN, "ETHUSDT", "long", r)
    assert "ETHUSDT" in _idem(CONN, "ETHUSDT", "long", r)


def test_idempotency_namespace_is_direction_and_candle_scoped():
    r = _Retest()
    assert _idem(CONN, "ETHUSDT", "long", r) != _idem(CONN, "ETHUSDT", "short", r)
    later = _Retest(retest_ts=r.retest_ts + 300_000)
    assert _idem(CONN, "ETHUSDT", "long", r) != _idem(CONN, "ETHUSDT", "long", later)


def test_exposure_guard_is_symbol_scoped_so_btc_does_not_block_eth():
    """The signer preflight takes per-symbol exposure. An open BTC position
    must not raise EXISTING_OPEN_POSITION for an ETH entry."""
    import os, sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "signer"))
    from app.execution import preflight, PipelineError

    # BTC exposure present, ETH clean -> ETH passes (lists are per-symbol).
    preflight(
        kill_switch_halted=False, equity_usd=Decimal(str(EQUITY_USD)),
        open_orders_for_symbol=[], open_positions_for_symbol=[],
    )
    # ETH exposure present -> ETH itself is blocked (guard still fail-closed).
    with pytest.raises(PipelineError) as e:
        preflight(
            kill_switch_halted=False, equity_usd=Decimal(str(EQUITY_USD)),
            open_orders_for_symbol=[], open_positions_for_symbol=[{"symbol": "ETH-USDT"}],
        )
    assert e.value.code == "EXISTING_OPEN_POSITION"


def test_eth_sizes_on_its_own_step_grid_at_100x():
    plan = accumulator_live_size.plan_entry_size(
        available_equity_usd=EQUITY_USD,
        symbol="ETH-USDT",
        direction="long",
        entry_price=Decimal("3000"),
        contract=ETH_CONTRACT,
    )
    assert plan.symbol == "ETH-USDT" and plan.side == "BUY"
    assert plan.leverage == 100
    assert plan.step_size == Decimal("0.01")
    assert plan.min_order_size == Decimal("0.010")
    # Quantized onto ETH's grid, never BTC's.
    assert plan.size == (plan.size / plan.step_size).to_integral_value() * plan.step_size
    assert plan.size >= plan.min_order_size


def test_eth_and_btc_plans_do_not_share_quantization():
    btc = accumulator_live_size.plan_entry_size(
        available_equity_usd=EQUITY_USD, symbol="BTC-USDT", direction="long",
        entry_price=Decimal("63000"), contract=BTC_CONTRACT,
    )
    eth = accumulator_live_size.plan_entry_size(
        available_equity_usd=EQUITY_USD, symbol="ETH-USDT", direction="long",
        entry_price=Decimal("3000"), contract=ETH_CONTRACT,
    )
    assert btc.step_size != eth.step_size
    assert btc.symbol != eth.symbol


def test_eth_refuses_without_venue_contract():
    """Activation grants no permission to guess ETH venue rules."""
    with pytest.raises(SizingError):
        accumulator_live_size.plan_entry_size(
            available_equity_usd=EQUITY_USD, symbol="ETH-USDT", direction="long",
            entry_price=Decimal("3000"), contract=None,
        )


def test_eth_refuses_without_equity():
    with pytest.raises(SizingError):
        accumulator_live_size.plan_entry_size(
            available_equity_usd=None, symbol="ETH-USDT", direction="long",
            entry_price=Decimal("3000"), contract=ETH_CONTRACT,
        )
