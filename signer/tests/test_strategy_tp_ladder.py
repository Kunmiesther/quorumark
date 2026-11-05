"""Signer TP-ladder build tests (strategy path). Pure — no network."""
from decimal import Decimal

import pytest

# `signer/app/main.py` transitively imports FastAPI / apex SDK / eth_account
# stack at module load — fine in prod, heavy in tests. Skip cleanly when the
# environment is missing any of them so this file can live in the repo
# without forcing a full signer dep install for every test run.
_deps_missing = False
try:
    from app.main import _build_tp_ladder, _default_stop_for, TpTierBody
except Exception:
    _deps_missing = True

pytestmark = pytest.mark.skipif(_deps_missing, reason="signer runtime deps not installed")


# ETH-SHAPED FIXTURE, deliberately.
#
# These tests previously used mark=118000 with entry_size == step_size ==
# "0.001" — a BTC-shaped, ONE-STEP position. The ladder floors each tier's
# size onto the step grid, so every tier of a one-step entry rounds to zero
# and the ladder comes out empty. The old expectation (three tiers from one
# indivisible unit) was arithmetically impossible, and the suite had been red
# on main since 2026-07-28 because of it.
#
# ETH is also what the owner-triggered test orders now target: BTC carries
# live exposure, so the signer's EXISTING_OPEN_ORDER preflight refuses a BTC
# test before it can prove anything. See bot_worker.TEST_ORDER_SYMBOL.
ETH_MARK = Decimal("3000")
ETH_TICK = "0.1"
ETH_STEP = "0.01"
ETH_ENTRY = "0.05"


def _tiers():
    return [
        TpTierBody(rr_multiple=1.75, size_frac=0.5),
        TpTierBody(rr_multiple=2.0, size_frac=0.3),
        TpTierBody(rr_multiple=2.5, size_frac=0.2),
    ]


def test_buy_ladder_prices_above_mark_and_tick_rounded():
    mark = ETH_MARK
    stop = _default_stop_for("BUY", mark, ETH_ENTRY, ETH_TICK)
    lad = _build_tp_ladder("BUY", mark, stop.trigger_price, ETH_ENTRY, ETH_STEP, ETH_TICK, _tiers())
    assert [p.kind for p in lad] == ["TP1", "TP2", "TP3"]
    prices = [Decimal(p.trigger_price) for p in lad]
    # BUY TPs are above mark.
    assert all(px > mark for px in prices)
    # Monotone increasing rr → increasing price.
    assert prices == sorted(prices)
    # Tick alignment: every price sits on the 0.1 grid.
    for px in prices:
        assert (px * 10).to_integral_value() == px * 10
    # Reduce-only kind and correct order type.
    assert all(p.order_type == "TAKE_PROFIT_MARKET" for p in lad)


def test_sell_ladder_prices_below_mark():
    mark = ETH_MARK
    stop = _default_stop_for("SELL", mark, ETH_ENTRY, ETH_TICK)
    lad = _build_tp_ladder("SELL", mark, stop.trigger_price, ETH_ENTRY, ETH_STEP, ETH_TICK, _tiers())
    prices = [Decimal(p.trigger_price) for p in lad]
    assert all(px < mark for px in prices)


def test_a_one_step_entry_cannot_be_split_and_yields_no_ladder():
    """The behaviour the old BTC-shaped fixture was accidentally asserting
    against. A position of exactly one venue step cannot be divided 50/30/20,
    so every tier floors to zero and the ladder is empty.

    This is arithmetically correct, and it is PINNED here rather than left
    implicit, because it is the case that silently drops take-profits: an
    entry at one step gets its stop and no TPs. Anything relying on a TP
    ladder must size above a single step."""
    mark = ETH_MARK
    stop = _default_stop_for("BUY", mark, ETH_STEP, ETH_TICK)
    lad = _build_tp_ladder("BUY", mark, stop.trigger_price, ETH_STEP, ETH_STEP, ETH_TICK, _tiers())
    assert list(lad) == []


def test_default_stop_directional_rounding():
    mark = ETH_MARK
    buy = _default_stop_for("BUY", mark, ETH_ENTRY, ETH_TICK)
    sell = _default_stop_for("SELL", mark, ETH_ENTRY, ETH_TICK)
    # BUY stop below mark; SELL stop above.
    assert Decimal(buy.trigger_price) < mark
    assert Decimal(sell.trigger_price) > mark
    # STOP_MARKET kind preserved.
    assert buy.order_type == "STOP_MARKET" and sell.order_type == "STOP_MARKET"


def test_ladder_size_floors_to_step():
    # Price-independent: this one is about step flooring, so it keeps a
    # 10-step entry that divides cleanly.
    mark = ETH_MARK
    stop = _default_stop_for("BUY", mark, "0.010", "0.1")
    lad = _build_tp_ladder("BUY", mark, stop.trigger_price, "0.010", "0.001", "0.1", _tiers())
    sizes = [Decimal(p.size) for p in lad]
    # 0.010 * (0.5, 0.3, 0.2) exact on 0.001 step.
    assert sizes == [Decimal("0.005"), Decimal("0.003"), Decimal("0.002")]
