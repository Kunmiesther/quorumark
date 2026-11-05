"""Canonical live sizing for the Accumulator bridge (accumulator_live_size)
plus the bridge-level wiring that consumes it.

THE THING BEING PINNED: the bridge must never ship a constant size again.
Every test below either proves the size came from accumulator_sizing +
pilot leverage + live venue rules, or proves that a missing input REFUSES
instead of substituting a number.
"""
import socket
from decimal import Decimal
from unittest.mock import patch

import pytest

import accumulator_live_size as als
import accumulator_sizing
import pilot_sizing
import bot_worker as bw

from test_accumulator_live_bridge import (  # noqa: F401 - shared harness
    CFG, CONTRACT, EQUITY_USD, _build_bot, _candles, _FeedClient, _wire, _Zone,
)

PRICE = Decimal("100")
EQUITY = Decimal("600")


def _plan(**over):
    kw = dict(available_equity_usd=EQUITY, symbol="BTC-USDT", direction="long",
              entry_price=PRICE, contract=dict(CONTRACT))
    kw.update(over)
    return als.plan_entry_size(**kw)


def _code(**over):
    with pytest.raises(accumulator_sizing.SizingError) as e:
        _plan(**over)
    return e.value.code


# --------------------------------------------------------------- canonical
def test_size_matches_accumulator_sizing_notional_exactly():
    expected = accumulator_sizing.compute_cycle_sizing(
        EQUITY, leverage=Decimal(pilot_sizing.MAX_LEVERAGE), symbol="BTC-USDT",
        min_notional_usd=Decimal(str(CONTRACT["minOrderSize"])) * PRICE,
    )
    p = _plan()
    assert p.target_notional_usd == expected.position_notional_usd
    assert p.size == expected.position_notional_usd / PRICE
    assert p.cycle_capital_usd == expected.cycle_capital_usd


def test_leverage_comes_from_pilot_clamp_not_a_literal():
    assert _plan().leverage == pilot_sizing.pilot_leverage(pilot_sizing.MAX_LEVERAGE)
    assert _plan(requested_leverage=10_000).leverage == pilot_sizing.MAX_LEVERAGE
    assert _plan(requested_leverage=25).leverage == 25


def test_margin_is_notional_over_leverage():
    p = _plan()
    assert p.margin_usd == p.notional_usd / Decimal(p.leverage)


def test_both_directions_quantize_and_map_side():
    long_p = _plan(direction="long")
    short_p = _plan(direction="short")
    assert (long_p.side, short_p.side) == ("BUY", "SELL")
    assert long_p.size == short_p.size > 0
    for p in (long_p, short_p):
        assert p.size % p.step_size == 0


def test_direction_must_be_long_or_short():
    assert _code(direction="sideways") == "DIRECTION_INVALID"


# ------------------------------------------------------- venue quantization
def test_size_rounds_down_to_step_never_up():
    # step 1.0 on a 50-unit target is exact; step 3 forces a floor to 48.
    p = _plan(contract={**CONTRACT, "stepSize": 3})
    assert p.size == Decimal("48")
    assert p.notional_usd < p.target_notional_usd


def test_step_floor_below_venue_minimum_is_refused():
    # Target 50 units, step 30 floors to 30, which is under the 49.9 minimum.
    # The refusal happens AFTER quantization — the floored size is not nudged
    # back up to the minimum.
    assert _code(contract={**CONTRACT, "minOrderSize": 49.9, "stepSize": 30}) \
        == "SIZE_BELOW_VENUE_MINIMUM"


def test_size_above_venue_maximum_is_refused_not_clamped():
    assert _code(contract={**CONTRACT, "maxOrderSize": 1}) == "SIZE_ABOVE_VENUE_MAXIMUM"


def test_step_larger_than_size_rounds_to_zero_and_refuses():
    assert _code(contract={**CONTRACT, "stepSize": 500, "minOrderSize": 0.001}) \
        == "SIZE_ROUNDS_TO_ZERO"


def test_missing_contract_is_refused():
    assert _code(contract=None) == "VENUE_CONTRACT_UNAVAILABLE"


def test_incomplete_contract_is_refused():
    bad = {**CONTRACT}
    bad.pop("stepSize")
    assert _code(contract=bad) == "VENUE_CONTRACT_INCOMPLETE"


@pytest.mark.parametrize("field", ["minOrderSize", "stepSize", "maxOrderSize"])
def test_non_positive_contract_field_is_refused(field):
    assert _code(contract={**CONTRACT, field: 0}) == "VENUE_CONTRACT_INVALID"


def test_derived_min_notional_blocks_dust_orders():
    # minOrderSize 100 at price 100 => $10k minimum notional > $5k target.
    assert _code(contract={**CONTRACT, "minOrderSize": 100, "maxOrderSize": 1e6}) \
        == "NOTIONAL_BELOW_VENUE_MINIMUM"


# ----------------------------------------------------------------- equity
def test_missing_equity_is_refused():
    assert _code(available_equity_usd=None) == "BALANCE_UNAVAILABLE"


def test_unreadable_equity_is_refused():
    assert _code(available_equity_usd="not-a-number") == "BALANCE_UNREADABLE"


def test_equity_at_or_below_external_buffer_is_refused():
    assert _code(available_equity_usd=100) == "EQUITY_AT_OR_BELOW_EXTERNAL_BUFFER"


def test_zero_equity_is_refused():
    assert _code(available_equity_usd=0) == "BALANCE_ZERO_OR_NEGATIVE"


def test_barely_sufficient_equity_sizes_down_it_never_floors_up():
    # $101 equity => $1 deployable capital => $10 notional => 0.1 units.
    # The pilot ledger is scale-invariant, so tiny equity produces a tiny
    # position rather than a substituted minimum. The venue is the only thing
    # that can refuse from here.
    p = _plan(available_equity_usd=101)
    assert p.cycle_capital_usd == Decimal("1")
    assert p.size == Decimal("0.1")


def test_tiny_equity_refused_by_derived_venue_minimum():
    # Same path, but with a venue whose minimum quantity exceeds the size the
    # ledger produced: refusal, not a bumped-up order.
    assert _code(available_equity_usd=101,
                 contract={**CONTRACT, "minOrderSize": 1}) \
        == "NOTIONAL_BELOW_VENUE_MINIMUM"


def test_smaller_equity_yields_strictly_smaller_size():
    assert _plan(available_equity_usd=300).size < _plan(available_equity_usd=600).size


@pytest.mark.parametrize(
    ("equity", "margin", "per_rung"),
    [(1000, "50", "10"), (3000, "150", "30"), (5000, "250", "50")],
)
def test_automation_campaign_compounds_five_percent_across_five_rungs(
    equity, margin, per_rung
):
    p = _plan(
        available_equity_usd=equity,
        dynamic_wallet_campaign=True,
    )
    assert p.margin_usd == Decimal(margin)
    assert p.rung_count == 5
    assert p.margin_per_rung_usd == Decimal(per_rung)


def test_automation_campaign_has_no_application_dollar_cap():
    small = _plan(available_equity_usd=1000, dynamic_wallet_campaign=True)
    large = _plan(available_equity_usd=20_000, dynamic_wallet_campaign=True)
    assert small.margin_usd == Decimal("50")
    assert large.margin_usd == Decimal("1000")
    assert large.margin_usd > Decimal(str(pilot_sizing.CEILING_USD))


# ------------------------------------------------------------------ price
@pytest.mark.parametrize("bad", [None, 0, -5, "abc", float("nan"), float("inf")])
def test_bad_entry_price_is_refused(bad):
    assert _code(entry_price=bad) == "ENTRY_PRICE_INVALID"


def test_unknown_symbol_leverage_is_refused():
    assert _code(symbol="DOGE-XYZ") == "SYMBOL_LEVERAGE_UNKNOWN"


# --------------------------------------------------------- bridge wiring
def _observe(bot, feed, ts, contract=CONTRACT):
    return bot.observe_signal(CFG, "u1", "c1", now_ms=ts + 1000,
                              feed=_FeedClient(feed, contract))


def test_bridge_intent_carries_calculated_size_not_a_constant(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts)
    intent = submitted[0]
    assert intent["size"] != 0.001
    assert intent["size"] == pytest.approx(
        float(_plan(available_equity_usd=EQUITY_USD).size))
    assert intent["leverage"] == pilot_sizing.MAX_LEVERAGE


def test_bridge_short_intent_is_quantized_too(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch, direction="short",
                                zone=_Zone(100.5, 100.0, 101.0))
    _observe(bot, feed, ts)
    assert submitted[0]["side"] == "SELL"
    assert submitted[0]["size"] > 0


def test_bridge_refuses_when_equity_unavailable(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    bot._accum_available_equity_usd = lambda *a, **kw: None
    _observe(bot, feed, ts)
    assert submitted == []


def test_bridge_refuses_when_venue_contract_unavailable(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts, contract=None)
    assert submitted == []


def test_blocked_intent_stays_eligible_for_a_later_cycle(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    bot._accum_available_equity_usd = lambda *a, **kw: None
    _observe(bot, feed, ts)
    assert submitted == []
    bot._accum_available_equity_usd = lambda *a, **kw: EQUITY_USD
    _observe(bot, feed, ts)
    assert len(submitted) == 1


def test_worker_has_no_equity_source_yet_and_fails_closed(monkeypatch):
    bot = _build_bot(monkeypatch)
    assert bot._accum_available_equity_usd("u1", "c1") is None


def test_no_constant_size_literal_reaches_any_strategy_intent():
    """EVERY strategy leg sizes through `plan_entry_size` or refuses. The
    canary constant is confined to the owner-triggered proof-of-life command
    and must not appear anywhere on the decision-execution path."""
    src = open("bot_worker.py").read()
    execute = src.split("def _execute_decision")[1].split("def _classify_apex_result")[0]
    assert "0.001" not in execute
    assert "CANARY_ORDER_SIZE" not in execute
    assert "plan_entry_size" in execute
    assert '"size": size,' in execute
