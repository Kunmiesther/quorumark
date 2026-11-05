from math import isclose

from evaluate_arc_unused_dca import (
    CAMPAIGN_MARGIN_PCT,
    CAPITAL,
    RUNG_OFFSETS_PCT,
    TARGET_MARGIN_ROI,
    close_net,
    raw_target,
)


def test_unused_dca_uses_two_percent_margin_and_five_rungs():
    assert CAPITAL * CAMPAIGN_MARGIN_PCT == 50.0
    assert RUNG_OFFSETS_PCT == (0.0, 0.5, 1.0, 1.5, 2.0)


def test_long_target_nets_thirty_percent_after_costs():
    lots = [{
        "entry": 100.02,
        "qty": 10.0,
        "entry_fee": 0.5,
        "margin": 10.0,
        "rung": 1,
    }]
    target = raw_target(lots, "long")
    net, _ = close_net(lots, target, "long")
    assert isclose(net, lots[0]["margin"] * TARGET_MARGIN_ROI)


def test_short_target_nets_thirty_percent_after_costs():
    lots = [{
        "entry": 99.98,
        "qty": 10.0,
        "entry_fee": 0.5,
        "margin": 10.0,
        "rung": 1,
    }]
    target = raw_target(lots, "short")
    net, _ = close_net(lots, target, "short")
    assert isclose(net, lots[0]["margin"] * TARGET_MARGIN_ROI)
