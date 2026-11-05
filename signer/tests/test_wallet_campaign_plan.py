"""Five-rung wallet campaigns are plans, never one mislabeled market order."""
from decimal import Decimal

import pytest

from app.builder import BuildError, build_wallet_campaign_plan


ARGS = dict(
    symbol="BTC-USDT", side="BUY", mark_price="100", leverage=50,
    tick_size="0.01", step_size="0.0001", min_order_size="0.001",
    max_order_size="10000", venue_max_leverage=50,
    settled_wallet_balance_usd="2500", available_collateral_usd="2500",
    decimals=8, l2_pair_id=1, taker_fee_rate="0.0005",
    maker_fee_rate="0.0002",
)


def plan(**changes):
    return build_wallet_campaign_plan(**{**ARGS, **changes})


@pytest.mark.parametrize("wallet,target", [
    ("1000", "50"), ("3000", "150"), ("5000", "250"),
    ("20000", "1000"),
])
def test_each_wallet_gets_five_real_rungs_with_no_app_dollar_cap(wallet, target):
    campaign = plan(settled_wallet_balance_usd=wallet, available_collateral_usd=wallet)
    assert len(campaign.rungs) == 5
    assert [r.index for r in campaign.rungs] == [1, 2, 3, 4, 5]
    assert all(r.built.order_type == "LIMIT" for r in campaign.rungs)
    assert all(Decimal(r.margin_usd) <= Decimal(target) / 5 for r in campaign.rungs)
    assert sum(Decimal(r.margin_usd) for r in campaign.rungs) <= Decimal(target)
    assert Decimal(campaign.total_margin_usd) == sum(
        Decimal(r.margin_usd) for r in campaign.rungs
    )


def test_long_rungs_descend_and_stop_is_beyond_deepest():
    campaign = plan()
    prices = [Decimal(r.limit_price) for r in campaign.rungs]
    assert prices == sorted(prices, reverse=True)
    assert Decimal(campaign.hard_stop_price) < prices[-1]
    assert campaign.hard_stop_side == "SELL"


def test_short_rungs_ascend_and_stop_is_beyond_deepest():
    campaign = plan(side="SELL")
    prices = [Decimal(r.limit_price) for r in campaign.rungs]
    assert prices == sorted(prices)
    assert Decimal(campaign.hard_stop_price) > prices[-1]
    assert campaign.hard_stop_side == "BUY"


def test_wallet_balance_not_free_collateral_is_sizing_basis():
    campaign = plan(settled_wallet_balance_usd="3000", available_collateral_usd="1000")
    assert Decimal(campaign.total_margin_usd) > Decimal("50")
    assert Decimal(campaign.total_margin_usd) <= Decimal("150")


@pytest.mark.parametrize("changes,code", [
    ({"available_collateral_usd": "200"}, "CAMPAIGN_COLLATERAL_INSUFFICIENT"),
    ({"min_order_size": "1000"}, "CAMPAIGN_RUNG_BELOW_VENUE_MINIMUM"),
    ({"max_order_size": "1"}, "CAMPAIGN_RUNG_ABOVE_VENUE_MAXIMUM"),
    ({"step_size": "1000"}, "SIZE_TOO_SMALL"),
    ({"tick_size": "10"}, "CAMPAIGN_RUNG_PRICE_COLLISION"),
    ({"settled_wallet_balance_usd": "0"}, "CAMPAIGN_BALANCE_INVALID"),
    ({"leverage": 51}, "BAD_LEVERAGE"),
])
def test_invalid_or_unaffordable_campaign_refuses_without_clamping(changes, code):
    with pytest.raises(BuildError) as caught:
        plan(**changes)
    assert caught.value.code == code
