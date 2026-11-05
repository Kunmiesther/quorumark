from decimal import Decimal

import pytest

from app.aster_campaign import (
    AsterPlanError, build_aster_campaign, prepare_aster_campaign,
    validate_entry_preflight,
)


RULES = {
    "symbol": "BTCUSDT", "step_size": "0.001", "min_quantity": "0.001",
    "max_quantity": "1000", "tick_size": "0.1", "min_notional": "5",
}


def plan(**overrides):
    args = dict(
        symbol="BTCUSDT", side="BUY", wallet_balance_usd="2500",
        available_collateral_usd="2400", mark_price="80000",
        leverage=100, venue_max_leverage=100, rules=RULES,
    )
    args.update(overrides)
    return build_aster_campaign(**args)


def test_five_rungs_compound_from_current_wallet_without_app_dollar_cap():
    first = plan()
    larger = plan(wallet_balance_usd="5000", available_collateral_usd="4900")
    assert len(first.rungs) == len(larger.rungs) == 5
    assert first.target_margin_usd == "125"
    assert larger.target_margin_usd == "250"
    assert Decimal(first.actual_margin_usd) <= Decimal("125")
    assert Decimal(larger.actual_margin_usd) <= Decimal("250")
    assert all(Decimal(r.margin_usd) <= Decimal("25") for r in first.rungs)
    assert all(first.rungs[i].price > first.rungs[i + 1].price for i in range(4))
    assert Decimal(first.hard_stop_price) < Decimal(first.rungs[-1].price)


def test_short_rungs_and_stop_are_above_mark():
    short = plan(side="SELL")
    assert all(short.rungs[i].price < short.rungs[i + 1].price for i in range(4))
    assert Decimal(short.hard_stop_price) > Decimal(short.rungs[-1].price)


@pytest.mark.parametrize("side", ["BUY", "SELL"])
def test_125x_ceiling_preserves_five_rung_margin_budget(side):
    campaign = plan(side=side, leverage=125, venue_max_leverage=125)
    assert campaign.leverage == 125
    assert len(campaign.rungs) == 5
    assert campaign.target_margin_usd == "125"
    assert Decimal(campaign.actual_margin_usd) <= Decimal("125")
    assert all(Decimal(r.margin_usd) <= Decimal("25") for r in campaign.rungs)


@pytest.mark.parametrize("leverage,venue_max", [(126, 200), (135, 200), (125, 100), (True, 125)])
def test_leverage_ceiling_and_lower_venue_bracket_are_both_enforced(leverage, venue_max):
    with pytest.raises(AsterPlanError, match="ASTER_CAMPAIGN_BAD_LEVERAGE"):
        plan(leverage=leverage, venue_max_leverage=venue_max)


@pytest.mark.parametrize("changes,code", [
    ({"available_collateral_usd": "100"}, "ASTER_CAMPAIGN_COLLATERAL_INSUFFICIENT"),
    ({"leverage": 101}, "ASTER_CAMPAIGN_BAD_LEVERAGE"),
    ({"rules": {**RULES, "min_quantity": "1"}}, "ASTER_CAMPAIGN_RUNG_BELOW_VENUE_MINIMUM"),
    ({"rules": {**RULES, "tick_size": "1000"}}, "ASTER_CAMPAIGN_RUNG_PRICE_COLLISION"),
])
def test_invalid_venue_or_balance_refuses_without_submitting(changes, code):
    with pytest.raises(AsterPlanError, match=code):
        plan(**changes)


def test_preflight_reads_the_selected_venue_account_not_a_caller_balance():
    balance, available = validate_entry_preflight(
        symbol="BTCUSDT",
        account={"canTrade": True, "totalWalletBalance": "2500", "availableBalance": "2400"},
        positions=[{"symbol": "BTCUSDT", "positionAmt": "0"}],
        open_orders=[], position_mode="one_way",
    )
    assert balance == Decimal("2500")
    assert available == Decimal("2400")


@pytest.mark.parametrize("changes,code", [
    ({"position_mode": "hedge"}, "ASTER_CAMPAIGN_POSITION_MODE_UNSUPPORTED"),
    ({"account": {"canTrade": False, "totalWalletBalance": "2500", "availableBalance": "2400"}},
     "ASTER_CAMPAIGN_ACCOUNT_CANNOT_TRADE"),
    ({"positions": [{"symbol": "BTCUSDT", "positionAmt": "-0.01"}]},
     "ASTER_CAMPAIGN_EXISTING_POSITION"),
    ({"positions": [{"symbol": "BTCUSDT"}]}, "ASTER_CAMPAIGN_POSITION_UNREADABLE"),
    ({"open_orders": [{"symbol": "BTCUSDT", "orderId": 1}]}, "ASTER_CAMPAIGN_EXISTING_ORDER"),
])
def test_preflight_refuses_risky_venue_state(changes, code):
    args = dict(
        symbol="BTCUSDT",
        account={"canTrade": True, "totalWalletBalance": "2500", "availableBalance": "2400"},
        positions=[], open_orders=[], position_mode="one_way",
    )
    args.update(changes)
    with pytest.raises(AsterPlanError, match=code):
        validate_entry_preflight(**args)


def test_preparation_uses_one_venue_account_and_makes_no_writes(monkeypatch):
    from app import aster_campaign

    calls = []
    def observe(name, value):
        def read(*_args, **_kwargs):
            calls.append(name)
            return value
        return read

    monkeypatch.setattr(aster_campaign.aster_v3, "read_account", observe(
        "account", {"canTrade": True, "totalWalletBalance": "2500", "availableBalance": "2400"},
    ))
    monkeypatch.setattr(aster_campaign.aster_v3, "read_position_mode", observe("mode", "one_way"))
    monkeypatch.setattr(aster_campaign.aster_v3, "read_positions", observe("positions", []))
    monkeypatch.setattr(aster_campaign.aster_v3, "read_open_orders", observe("orders", []))
    monkeypatch.setattr(aster_campaign.aster_v3, "symbol_rules", observe("rules", RULES))
    monkeypatch.setattr(aster_campaign.aster_v3, "mark_price", observe("mark", Decimal("80000")))
    monkeypatch.setattr(aster_campaign.aster_v3, "max_initial_leverage", observe("leverage", 100))
    campaign = prepare_aster_campaign(object(), symbol="BTCUSDT", side="BUY", leverage=100)
    assert campaign.target_margin_usd == "125"
    assert len(campaign.rungs) == 5
    assert calls == ["account", "mode", "positions", "orders", "rules", "mark", "leverage"]
