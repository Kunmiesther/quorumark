from math import isclose

from backtest_four_wallet_raw import (
    Order,
    PreEntryHedgeState,
    Position,
    Wallet,
    aggregate_1d,
    arm_campaign_trailing_remainder,
    campaign_reward_risk,
    core_protection_state,
    cross_margin_deleverage,
    daily_trend_state_series,
    entry_boundary_broken,
    liquidity_sweep_signals_for_15m,
    long_entry_quality_rejection,
    manage_pre_entry_hedges,
    make_campaign,
    open_positions,
    orders_before_invalidation,
    pending_orders,
    place_campaign,
    pre_entry_hedge_exit,
    ratchet_trailing_stop,
    signal_invalidation_price,
    stage_all_rungs_at_alert,
    stage_five_rungs_after_five_steps,
    stage_three_rungs_after_three_spaces,
    sweep_vote_quality_rejection,
    timeframe_alignment_votes,
)
from sweep_signal import SweepEntry


def test_two_of_three_timeframe_vote_requires_two_matching_states():
    assert timeframe_alignment_votes(
        "long", "bullish_bos", "bearish_bos", "bullish_bos",
    ) == 2
    assert timeframe_alignment_votes(
        "short", "bullish_bos", "bearish_bos", "none",
    ) == 1


def test_core_hedge_protects_on_1h_turn_and_exits_on_confirmed_4h_reversal():
    assert core_protection_state(
        "short", "bullish_bos", "bearish_bos",
    ) == "protect"
    assert core_protection_state(
        "short", "bullish_bos", "bullish_bos",
    ) == "confirmed_reversal"
    assert core_protection_state(
        "short", "bearish_bos", "bearish_bos",
    ) == "clear"
    assert core_protection_state(None, "bullish_bos", "bullish_bos") == "flat"


def test_vote_quality_filter_is_shared_and_requires_displacement():
    assert sweep_vote_quality_rejection("session", "retest", 0.9) is None
    assert sweep_vote_quality_rejection(
        "session", "rejection", 1.049,
    ) == "vote_filter_rejection_without_displacement"
    assert sweep_vote_quality_rejection("session", "rejection", 1.05) is None
    assert sweep_vote_quality_rejection(
        "swing", "retest", 0.99,
    ) == "vote_filter_weak_swing_momentum"


def test_daily_aggregation_and_state_use_only_completed_days():
    candles = []
    for day in range(12):
        for bar in range(288):
            timestamp = day * 86_400_000 + bar * 300_000
            close = 100.0 + day
            candles.append([timestamp, close, close + 1, close - 1, close, 1.0])
    candles.append([12 * 86_400_000, 112.0, 113.0, 111.0, 112.0, 1.0])

    daily = aggregate_1d(candles)
    states = daily_trend_state_series(daily)

    assert len(daily) == 12
    assert states[-1] == "bullish_bos"


def test_campaign_reward_risk_uses_only_rungs_before_invalidation():
    orders = make_campaign(
        1, "S000001", "long", "break_retest", "BTC-USDT", "long",
        0, 100_000.0,
    )
    geometry = campaign_reward_risk(orders, 99_200.0)

    assert geometry["eligible_rungs"] == 2
    assert geometry["net_reward"] > 0
    assert geometry["invalidation_loss"] > 0
    assert geometry["reward_risk"] > 0


def test_liquidity_sweep_uses_its_stop_as_structural_invalidation():
    signal = SweepEntry(
        direction="long", mode="rejection", entry=100.0, stop=99.0,
        swept_level=99.5, level_source="swing", atr_at_entry=1.0,
        tp_distance=2.5,
    )

    assert signal_invalidation_price(signal) == 99.0
    assert signal_invalidation_price(signal, 0.25) == 98.75

    short_signal = SweepEntry(
        direction="short", mode="rejection", entry=100.0, stop=101.0,
        swept_level=100.5, level_source="swing", atr_at_entry=2.0,
        tp_distance=2.5,
    )
    assert signal_invalidation_price(short_signal, 0.25) == 101.5


def test_15m_liquidity_sweep_output_is_15m_aligned():
    candles = [
        [index * 300_000, 100.0, 101.0, 99.0, 100.0, 1.0]
        for index in range(240)
    ]

    aggregated, signals = liquidity_sweep_signals_for_15m(candles, 0)

    assert aggregated
    assert all(int(row[0]) % 900_000 == 0 for row in aggregated)
    assert all(timestamp % 900_000 == 0 for timestamp in signals)


def test_ladder_is_clipped_at_structural_invalidation():
    orders = make_campaign(
        1, "S000001", "strategy", "hunter", "BTC-USDT", "long",
        0, 100_000.0,
    )

    clipped = orders_before_invalidation(orders, 99_200.0)

    assert {order.rung for order in clipped} == {1, 2}
    assert len(clipped) == 6


def test_stage_three_rungs_after_three_spaces_then_keep_four_and_five():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "BTC-USDT", "long",
        0, 100_000.0,
    )

    selected = stage_three_rungs_after_three_spaces(orders)

    entries = {rung: set() for rung in range(1, 6)}
    for order in selected:
        entries[order.rung].add(order.entry)
    assert entries[1] == entries[2] == entries[3] == {98_500.0}
    assert entries[4] == {98_000.0}
    assert entries[5] == {97_500.0}
    assert len(selected) == 15


def test_stage_three_rungs_can_enter_after_two_spaces():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "BTC-USDT", "long",
        0, 100_000.0,
    )

    selected = stage_three_rungs_after_three_spaces(orders, entry_steps=2)

    entries = {rung: set() for rung in range(1, 6)}
    for order in selected:
        entries[order.rung].add(order.entry)
    assert entries[1] == entries[2] == entries[3] == {99_000.0}
    assert entries[4] == {98_000.0}
    assert entries[5] == {97_500.0}


def test_all_five_rungs_can_enter_at_alert_price():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "BTC-USDT", "long",
        0, 100_000.0,
    )

    selected = stage_all_rungs_at_alert(orders)

    assert {order.entry for order in selected} == {100_000.0}
    assert {order.rung for order in selected} == {1, 2, 3, 4, 5}


def test_core_can_take_half_at_100_percent_and_half_at_200_percent_roi():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "ETH-USDT", "long",
        0, 100.0, margin_per_rung=25.0,
        tp_slices=((0.50, 1.00), (0.50, 2.00)),
    )

    assert len(orders) == 10
    assert {order.slice_fraction for order in orders} == {0.50}
    assert {order.target_roi for order in orders} == {1.00, 2.00}
    assert {order.target for order in orders if order.rung == 1} == {
        101.0, 102.0,
    }


def test_remainder_stop_arms_at_50_percent_roi_and_only_ratchets_forward():
    wallet = Wallet("long")
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "ETH-USDT", "long",
        0, 100.0, rung_count=1, margin_per_rung=25.0,
        tp_slices=((0.50, 1.00), (0.50, 2.00)),
    )
    assert place_campaign(
        wallet, orders, 0, {"ETH-USDT": 100.0}, [], fill_initial=True,
    )
    trigger, remainder = open_positions(wallet)

    assert arm_campaign_trailing_remainder(
        wallet, trigger, 900_000, 0.50, [],
    ) == 1
    assert isclose(remainder.order.stop, 100.5)
    assert ratchet_trailing_stop(
        remainder, [1_800_000, 101.0, 101.6, 100.9, 101.4, 1.0],
    )
    assert isclose(remainder.order.stop, 101.1)
    assert not ratchet_trailing_stop(
        remainder, [2_700_000, 101.0, 101.4, 100.9, 101.1, 1.0],
    )
    assert isclose(remainder.order.stop, 101.1)


def test_stage_three_short_rungs_after_three_spaces_then_keep_four_and_five():
    orders = make_campaign(
        1, "S000001", "short", "liquidity_sweep", "BTC-USDT", "short",
        0, 100_000.0,
    )

    selected = stage_three_rungs_after_three_spaces(orders)

    entries = {rung: set() for rung in range(1, 6)}
    for order in selected:
        entries[order.rung].add(order.entry)
    assert all(
        isclose(entry, 101_500.0)
        for rung in (1, 2, 3) for entry in entries[rung]
    )
    assert all(isclose(entry, 102_000.0) for entry in entries[4])
    assert all(isclose(entry, 102_500.0) for entry in entries[5])
    assert all(order.target < order.entry for order in selected)
    assert len(selected) == 15


def test_staged_campaign_waits_for_market_to_reach_entry():
    wallet = Wallet("long")
    orders = stage_three_rungs_after_three_spaces(make_campaign(
        1, "S000001", "long", "liquidity_sweep", "BTC-USDT", "long",
        0, 100_000.0,
    ))

    accepted = place_campaign(
        wallet, orders, 0, {"BTC-USDT": 100_000.0}, [],
        fill_initial=False,
    )

    assert accepted
    assert open_positions(wallet) == []
    assert len(pending_orders(wallet)) == 15


def test_pre_entry_long_hedge_pairs_at_rung_four_then_trails_two_rungs():
    state = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
    )
    assert pre_entry_hedge_exit(
        state, [0, 100.0, 100.2, 98.4, 98.8, 1.0], unpaired=False,
    ) is None
    assert state.deepest_favorable_step == 3
    trail_exit = pre_entry_hedge_exit(
        state, [0, 98.8, 99.6, 98.7, 99.5, 1.0], unpaired=False,
    )
    assert isclose(trail_exit[0], 99.5)
    assert trail_exit[1] == "pre_entry_hedge_trail_step_1"


def test_pre_entry_long_hedge_ratchets_deeper_without_moving_backwards():
    state = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
    )
    assert pre_entry_hedge_exit(
        state, [0, 100.0, 100.1, 97.4, 97.5, 1.0], unpaired=False,
    ) is None
    assert state.deepest_favorable_step == 5
    trail_exit = pre_entry_hedge_exit(
        state, [0, 97.5, 98.6, 97.4, 98.5, 1.0], unpaired=False,
    )
    assert isclose(trail_exit[0], 98.5)
    assert trail_exit[1] == "pre_entry_hedge_trail_step_3"


def test_unpaired_hedge_requests_resize_instead_of_selling_at_a_loss():
    state = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
    )
    assert pre_entry_hedge_exit(
        state, [0, 100.0, 100.6, 99.9, 100.5, 1.0],
    ) is None
    assert state.unpaired_resize_needed
    assert state.max_unpaired_adverse_step == 1


def test_pre_entry_short_hedge_mirrors_long_geometry():
    state = PreEntryHedgeState(
        "BTC-USDT", "CORE", "short", "HEDGE", 100.0,
    )
    assert pre_entry_hedge_exit(
        state, [0, 100.0, 101.6, 99.9, 101.5, 1.0],
        unpaired=False,
    ) is None
    assert state.deepest_favorable_step == 3
    trail_exit = pre_entry_hedge_exit(
        state, [0, 101.5, 101.6, 100.4, 100.5, 1.0], unpaired=False,
    )
    assert isclose(trail_exit[0], 100.5)
    assert trail_exit[1] == "pre_entry_hedge_trail_step_1"


def test_eight_rung_core_stages_five_at_step_five_and_covers_four_percent():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "BTC-USDT", "long",
        0, 100.0, rung_count=8,
    )
    stage_five_rungs_after_five_steps(orders)

    entries = {
        rung: {order.entry for order in orders if order.rung == rung}
        for rung in range(1, 9)
    }
    assert all(entries[rung] == {97.5} for rung in range(1, 6))
    assert entries[6] == {97.0}
    assert entries[7] == {96.5}
    assert entries[8] == {96.0}


def test_five_percent_campaign_is_five_equal_twenty_five_dollar_rungs():
    orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "ETH-USDT", "long",
        0, 100.0, rung_count=5, margin_per_rung=25.0,
    )
    stage_five_rungs_after_five_steps(orders)

    assert isclose(sum(order.initial_margin for order in orders), 125.0)
    assert {order.entry for order in orders} == {97.5}


def test_dynamic_hedge_trails_two_steps_after_five_and_seven_steps():
    at_five = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
        dynamic_trailing=True,
    )
    assert pre_entry_hedge_exit(
        at_five, [0, 100.0, 100.1, 97.4, 97.5, 1.0], unpaired=False,
    ) is None
    assert at_five.deepest_favorable_step == 5
    assert pre_entry_hedge_exit(
        at_five, [0, 97.5, 98.6, 97.4, 98.5, 1.0], unpaired=False,
    )[1] == "pre_entry_hedge_trail_step_3"

    at_seven = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
        dynamic_trailing=True,
    )
    assert pre_entry_hedge_exit(
        at_seven, [0, 100.0, 100.1, 96.4, 96.5, 1.0], unpaired=False,
    ) is None
    assert at_seven.deepest_favorable_step == 7
    assert pre_entry_hedge_exit(
        at_seven, [0, 96.5, 97.6, 96.4, 97.5, 1.0], unpaired=False,
    )[1] == "pre_entry_hedge_trail_step_5"


def test_unpaired_dynamic_hedge_stays_open_and_marks_resize_needed():
    wallets = {name: Wallet(name) for name in ("long", "short", "hedge", "strategy")}
    core_orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "ETH-USDT", "long",
        0, 100.0, rung_count=5, margin_per_rung=25.0,
    )
    stage_five_rungs_after_five_steps(core_orders)
    assert place_campaign(
        wallets["long"], core_orders, 0, {"ETH-USDT": 100.0}, [],
        fill_initial=False,
    )
    hedge_order = Order(
        order_id="HEDGE-O01", campaign_id="HEDGE", signal_id="S000001",
        wallet="hedge", strategy="pre_entry_ladder_hedge",
        symbol="ETH-USDT", side="short", rung=1, slice_fraction=1.0,
        target_roi=0.0, created_ts=0, entry=100.0, target=float("nan"),
        notional=12_500.0, qty=125.0, initial_margin=125.0,
    )
    assert place_campaign(
        wallets["hedge"], [hedge_order], 0, {"ETH-USDT": 100.0}, [],
    )
    states = {
        "ETH-USDT": PreEntryHedgeState(
            "ETH-USDT", core_orders[0].campaign_id, "long", "HEDGE", 100.0,
            dynamic_trailing=True,
        )
    }

    events = []
    manage_pre_entry_hedges(
        states, wallets, {}, 900_000,
        {"ETH-USDT": [900_000, 100.0, 100.6, 99.9, 100.5, 1.0]},
        {"ETH-USDT": 100.5}, events,
    )

    assert len(pending_orders(wallets["long"])) == 15
    assert len(open_positions(wallets["hedge"])) == 1
    assert states["ETH-USDT"].unpaired_resize_needed
    assert [event["event"] for event in events].count(
        "pre_entry_hedge_resize_requested"
    ) == 1


def test_pre_entry_unpaired_rung_two_exit_turns_off_after_core_fill():
    state = PreEntryHedgeState(
        "BTC-USDT", "CORE", "long", "HEDGE", 100.0,
    )
    assert pre_entry_hedge_exit(
        state, [0, 100.0, 100.6, 99.9, 100.5, 1.0], unpaired=False,
    ) is None


def _adaptive_unpaired_fixture():
    wallets = {
        name: Wallet(name) for name in ("long", "short", "hedge", "strategy")
    }
    core_orders = make_campaign(
        1, "S000001", "long", "liquidity_sweep", "ETH-USDT", "long",
        0, 100.0, rung_count=5, margin_per_rung=25.0,
    )
    stage_five_rungs_after_five_steps(core_orders)
    assert place_campaign(
        wallets["long"], core_orders, 0, {"ETH-USDT": 100.0}, [],
        fill_initial=False,
    )
    hedge_order = Order(
        order_id="HEDGE-O01", campaign_id="HEDGE", signal_id="S000001",
        wallet="hedge", strategy="pre_entry_ladder_hedge",
        symbol="ETH-USDT", side="short", rung=1, slice_fraction=1.0,
        target_roi=0.0, created_ts=0, entry=100.0, target=float("nan"),
        notional=2_500.0, qty=25.0, initial_margin=25.0,
    )
    assert place_campaign(
        wallets["hedge"], [hedge_order], 0, {"ETH-USDT": 100.0}, [],
    )
    states = {
        "ETH-USDT": PreEntryHedgeState(
            "ETH-USDT", core_orders[0].campaign_id, "long", "HEDGE", 100.0,
        )
    }
    return wallets, states


def test_adaptive_unpaired_hedge_resizes_once_then_exits_against_environment():
    wallets, states = _adaptive_unpaired_fixture()
    events = []
    bullish = {"ETH-USDT": ("bullish_bos", "bullish_bos", "bullish_bos")}
    manage_pre_entry_hedges(
        states, wallets, {}, 900_000,
        {"ETH-USDT": [900_000, 100.0, 100.6, 99.9, 100.5, 1.0]},
        {"ETH-USDT": 100.5}, events, environment_by_symbol=bullish,
        adaptive_unpaired_hedge=True, recovery_bars=1,
    )
    assert len(open_positions(wallets["hedge"])) == 2
    assert states["ETH-USDT"].resize_count == 1
    assert sum(
        position.order.initial_margin
        for position in open_positions(wallets["hedge"])
    ) == 37.5

    manage_pre_entry_hedges(
        states, wallets, {}, 1_800_000,
        {"ETH-USDT": [1_800_000, 100.5, 101.1, 100.4, 101.0, 1.0]},
        {"ETH-USDT": 101.0}, events, environment_by_symbol=bullish,
        adaptive_unpaired_hedge=True, recovery_bars=1,
    )
    assert open_positions(wallets["hedge"]) == []
    assert "ETH-USDT" not in states
    assert any(
        event.get("reason") == "pre_entry_hedge_unpaired_environment_exit"
        for event in events
    )


def test_adaptive_unpaired_hedge_is_not_forced_out_when_environment_favors_it():
    wallets, states = _adaptive_unpaired_fixture()
    events = []
    neutral = {"ETH-USDT": ("none", "none", "none")}
    manage_pre_entry_hedges(
        states, wallets, {}, 900_000,
        {"ETH-USDT": [900_000, 100.0, 100.6, 99.9, 100.5, 1.0]},
        {"ETH-USDT": 100.5}, events, environment_by_symbol=neutral,
        adaptive_unpaired_hedge=True, recovery_bars=1,
    )
    bearish = {"ETH-USDT": ("bearish_bos", "bearish_bos", "bearish_bos")}
    manage_pre_entry_hedges(
        states, wallets, {}, 1_800_000,
        {"ETH-USDT": [1_800_000, 100.5, 100.6, 99.3, 99.5, 1.0]},
        {"ETH-USDT": 99.5}, events, environment_by_symbol=bearish,
        adaptive_unpaired_hedge=True, recovery_bars=1,
    )
    assert len(open_positions(wallets["hedge"])) == 2
    assert "ETH-USDT" in states


def test_long_quality_gate_keeps_landmarks_and_requires_payoff_for_swings():
    assert long_entry_quality_rejection("session", 0.4, eligible_rungs=3) is None
    assert long_entry_quality_rejection("prior_day", 0.4, eligible_rungs=3) is None
    assert long_entry_quality_rejection(
        "confirmed_structure_zone", 0.4, "break_retest", 1.0, 3,
    ) is None
    assert long_entry_quality_rejection("swing", 1.0, eligible_rungs=3) is None
    assert long_entry_quality_rejection("swing", 0.99) == "long_entry_quality_gate"
    assert long_entry_quality_rejection("equal", 2.0) == "long_entry_quality_gate"


def test_long_quality_gate_requires_displacement_for_rejections_only():
    assert long_entry_quality_rejection(
        "session", 0.4, "rejection", 1.049,
    ) == "long_rejection_without_displacement"
    assert long_entry_quality_rejection(
        "session", 0.4, "rejection", 1.05, 3,
    ) is None
    assert long_entry_quality_rejection(
        "swing", 1.0, "retest", 1.0, 3,
    ) is None


def test_long_quality_gate_requires_space_for_three_rungs():
    assert long_entry_quality_rejection(
        "swing", 1.0, "retest", 1.0, 2,
    ) == "long_insufficient_ladder_space"
    assert long_entry_quality_rejection(
        "swing", 1.0, "retest", 1.0, 3,
    ) is None


def test_entry_boundary_detects_failed_hunter_trigger_bar():
    candle = [0, 100.0, 101.0, 98.0, 98.5, 1.0]

    assert entry_boundary_broken("long", candle, 99.0, reject_touch=True)
    assert entry_boundary_broken("long", candle, 99.0)


def test_cross_margin_guard_closes_losing_campaign_before_liquidation():
    order = Order(
        order_id="C000001-O01",
        campaign_id="C000001",
        signal_id="S000001",
        wallet="strategy",
        strategy="hunter",
        symbol="BTC-USDT",
        side="long",
        rung=1,
        slice_fraction=1.0,
        target_roi=1.0,
        created_ts=0,
        entry=100_000.0,
        target=101_000.0,
        notional=4_000.0,
        qty=0.04,
        initial_margin=40.0,
        state="filled",
    )
    wallet = Wallet("strategy", cash=2_498.0, fees=2.0)
    wallet.orders.append(order)
    wallet.positions.append(
        Position(
            order=order,
            entry=100_000.0,
            qty=0.04,
            opened_ts=0,
            entry_fee=2.0,
        )
    )
    events = []

    actions = cross_margin_deleverage(
        wallet,
        timestamp=300_000,
        candles={"BTC-USDT": [300_000, 100_000.0, 100_100.0, 38_000.0, 50_000.0, 1.0]},
        events=events,
    )

    assert actions == 1
    assert open_positions(wallet) == []
    assert wallet.liquidations == 0
    assert any(event["event"] == "cross_margin_deleverage" for event in events)
    assert any(
        event["event"] == "close"
        and event["reason"] == "cross_margin_deleverage"
        for event in events
    )
