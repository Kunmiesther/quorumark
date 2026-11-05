from __future__ import annotations

from unittest.mock import Mock

import pytest

from app import aster_executor, aster_v3
from app.aster_campaign import build_aster_campaign
from app.aster_executor import AsterExecutionError, _strategy_id, submit_aster_campaign


RULES = {
    "symbol": "BTCUSDT", "step_size": "0.001", "min_quantity": "0.001",
    "max_quantity": "1000", "tick_size": "0.1", "min_notional": "5",
}


def campaign():
    return build_aster_campaign(
        symbol="BTCUSDT", side="BUY", wallet_balance_usd="2500",
        available_collateral_usd="2400", mark_price="80000",
        leverage=100, venue_max_leverage=100, rules=RULES,
    )


def db():
    store = Mock()
    store.is_execution_halted.return_value = False
    store.insert_order_intent.side_effect = [f"intent-{n}" for n in range(1, 6)]
    return store


@pytest.fixture(autouse=True)
def confirmed_leverage(monkeypatch):
    update = Mock(return_value={"symbol": "BTCUSDT", "leverage": 100})
    monkeypatch.setattr(aster_v3, "set_leverage", update)
    return update


def submit(store):
    return submit_aster_campaign(
        db=store, credentials=object(), user_id="user", connection_id="conn-A",
        client_order_id="decision-1", symbol="BTCUSDT", side="BUY", leverage=100,
    )


def confirmed_strategy(client_id, strategy_id, rung):
    opposite = "SELL"
    return {
        "strategyId": strategy_id,
        "clientStrategyId": client_id,
        "strategyType": "OTO",
        "strategyStatus": "WORKING",
        "subOrders": [
            {
                "strategySubId": 1,
                "clientOrderId": f"{client_id[:32]}-e",
                "symbol": "BTCUSDT", "side": "BUY", "positionSide": "BOTH",
                "type": "LIMIT", "timeInForce": "GTC", "quantity": rung.quantity,
                "price": rung.price, "closePosition": False, "status": "NEW",
            },
            {
                "strategySubId": 2,
                "clientOrderId": f"{client_id[:32]}-s",
                "symbol": "BTCUSDT", "side": opposite, "positionSide": "BOTH",
                "type": "STOP_MARKET", "quantity": rung.quantity,
                "reduceOnly": True, "closePosition": False,
                "workingType": "MARK_PRICE", "stopPrice": campaign().hard_stop_price,
                "firstDrivenId": 1,
                "firstDrivenOn": "PARTIALLY_FILLED_OR_FILLED",
                "firstTrigger": "PLACE_ORDER", "status": "PENDING",
            },
        ],
    }


def test_five_rungs_are_reserved_then_confirmed_under_one_connection(monkeypatch, confirmed_leverage):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    events = []

    def place(_creds, **kwargs):
        events.append(("place", kwargs["client_strategy_id"]))
        return {"strategyId": len(events) // 2 + 1}

    def read(_creds, strategy_id):
        events.append(("read", strategy_id))
        rung = campaign().rungs[(len(events) // 2) - 1]
        return confirmed_strategy(strategy_id, len(events) // 2, rung)

    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    monkeypatch.setattr(aster_v3, "read_strategy_order", read)
    result = submit(store)
    assert result["status"] == "submitted"
    assert len(result["campaign_orders"]) == 5
    assert store.insert_order_intent.call_count == 5
    assert confirmed_leverage.call_count == 1
    assert confirmed_leverage.call_args.args[1:] == ("BTCUSDT", 100)
    assert store.transition_order_intent.call_count == 5
    assert [call.kwargs["state"] for call in store.transition_order_intent.call_args_list] == ["submitted"] * 5
    assert all(event[0] == "place" for event in events[::2])
    assert _strategy_id("user", "conn-A", "decision-1", 1) != _strategy_id("user", "conn-B", "decision-1", 1)


def test_duplicate_reservation_never_places_order(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    store.insert_order_intent.side_effect = ValueError("INTENT_DUPLICATE")
    place = Mock()
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    with pytest.raises(AsterExecutionError, match="INTENT_ALREADY_RESERVED"):
        submit(store)
    place.assert_not_called()


def test_unconfirmed_leverage_rejects_all_reserved_rungs_without_placing_orders(monkeypatch, confirmed_leverage):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    confirmed_leverage.side_effect = aster_v3.AsterV3Error("ASTER_LEVERAGE_UNCONFIRMED", ambiguous=True)
    place = Mock()
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)

    result = submit(store)

    assert result["status"] == "rejected"
    assert result["reject_reason"] == "ASTER_LEVERAGE_UNCONFIRMED"
    assert result["submitted_rungs"] == 0
    assert [call.kwargs["state"] for call in store.transition_order_intent.call_args_list] == ["rejected"] * 5
    place.assert_not_called()


def test_uncertain_second_rung_stops_campaign_without_retry(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    calls = 0

    def place(_creds, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise aster_v3.AsterV3Error("ASTER_EXECUTION_UNKNOWN", ambiguous=True)
        return {"strategyId": 100}

    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    monkeypatch.setattr(aster_v3, "read_strategy_order", lambda _creds, strategy_id: confirmed_strategy(
        strategy_id, 100, campaign().rungs[0],
    ))
    result = submit(store)
    assert result["status"] == "ambiguous"
    assert result["submitted_rungs"] == 1
    assert result["reconciliation_required"] is True
    assert calls == 2
    assert [call.kwargs["state"] for call in store.transition_order_intent.call_args_list] == [
        "submitted", "reconciliation_required", "rejected", "rejected", "rejected",
    ]


def test_halt_refuses_before_any_reservation(monkeypatch):
    store = db()
    store.is_execution_halted.return_value = True
    place = Mock()
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    with pytest.raises(AsterExecutionError, match="EXECUTION_HALTED"):
        submit(store)
    store.insert_order_intent.assert_not_called()
    place.assert_not_called()
    store.is_execution_halted.assert_called_once_with("user", "conn-A", require_live=True)


def test_owner_pause_after_first_rung_stops_remaining_entries(monkeypatch):
    store = db()
    store.is_execution_halted.side_effect = [False, False, False, True]
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    place = Mock(return_value={"strategyId": 100})
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    monkeypatch.setattr(aster_v3, "read_strategy_order", lambda _creds, strategy_id: confirmed_strategy(
        strategy_id, 100, campaign().rungs[0],
    ))
    result = submit(store)
    assert result["submitted_rungs"] == 1
    assert result["reject_reason"] == "EXECUTION_HALTED"
    assert place.call_count == 1
    assert all(call.kwargs == {"require_live": True} for call in store.is_execution_halted.call_args_list)


def test_working_strategy_without_proven_stop_stops_before_next_rung(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    place = Mock(return_value={"strategyId": 100})
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    monkeypatch.setattr(aster_v3, "read_strategy_order", lambda _creds, strategy_id: {
        "strategyId": 100, "clientStrategyId": strategy_id,
        "strategyType": "OTO", "strategyStatus": "WORKING", "subOrders": [],
    })
    result = submit(store)
    assert result["status"] == "ambiguous"
    assert result["reject_reason"] == "ASTER_LINKED_STOP_UNCONFIRMED"
    assert result["submitted_rungs"] == 0
    assert result["reconciliation_required"] is True
    place.assert_called_once()
    assert [call.kwargs["state"] for call in store.transition_order_intent.call_args_list] == [
        "reconciliation_required", "rejected", "rejected", "rejected", "rejected",
    ]
    assert store.transition_order_intent.call_args_list[0].kwargs["exchange_order_id"] == "100"


def test_unexpected_submit_failure_is_uncertain_not_safe_to_retry(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    place = Mock(side_effect=RuntimeError("unexpected transport failure"))
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    result = submit(store)
    assert result["status"] == "ambiguous"
    assert result["reject_reason"] == "ASTER_SUBMISSION_UNEXPECTED"
    assert result["reconciliation_required"] is True
    assert result["submitted_rungs"] == 0
    assert store.transition_order_intent.call_args_list[0].kwargs["state"] == "reconciliation_required"
    assert "exchange_order_id" not in store.transition_order_intent.call_args_list[0].kwargs
    place.assert_called_once()


def test_confirmed_venue_rejection_remains_rejected(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    place = Mock(side_effect=aster_v3.AsterV3Error("ASTER_MAIN_WALLET_DEPOSIT_REQUIRED"))
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    result = submit(store)
    assert result["status"] == "rejected"
    assert result["reconciliation_required"] is False
    assert result["submitted_rungs"] == 0
    assert all(call.kwargs["state"] == "rejected" for call in store.transition_order_intent.call_args_list)
    place.assert_called_once()


@pytest.mark.parametrize("failure_stage", ["read", "persist"])
def test_known_venue_id_survives_post_submit_failure(monkeypatch, failure_stage):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    place = Mock(return_value={"strategyId": 12345})
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", place)
    read = Mock(return_value=confirmed_strategy(
        _strategy_id("user", "conn-A", "decision-1", 1), 12345, campaign().rungs[0],
    ))
    monkeypatch.setattr(aster_v3, "read_strategy_order", read)
    if failure_stage == "read":
        read.side_effect = aster_v3.AsterV3Error("ASTER_TIMEOUT")
    else:
        store.transition_order_intent.side_effect = [RuntimeError("write failed"), None, None, None, None, None]
    result = submit(store)
    assert result["status"] == "ambiguous"
    assert result["campaign_orders"] == []
    pending = [call.kwargs for call in store.transition_order_intent.call_args_list
               if call.kwargs["state"] == "reconciliation_required"]
    assert len(pending) == 1
    assert pending[0]["exchange_order_id"] == "12345"
    assert pending[0]["intent_id"] == "intent-1"
    place.assert_called_once()


def test_wrong_close_side_is_not_confirmed(monkeypatch):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", lambda *_a, **_k: {"strategyId": 100})

    def wrong_stop(_creds, strategy_id):
        row = confirmed_strategy(strategy_id, 100, campaign().rungs[0])
        row["subOrders"][1]["side"] = "BUY"
        return row

    monkeypatch.setattr(aster_v3, "read_strategy_order", wrong_stop)
    result = submit(store)
    assert result["reject_reason"] == "ASTER_LINKED_STOP_UNCONFIRMED"
    assert result["status"] == "ambiguous"


@pytest.mark.parametrize("mutate", [
    lambda stop: stop.update(closePosition=True),
    lambda stop: stop.update(reduceOnly=False),
    lambda stop: stop.update(quantity="0.002"),
])
def test_stop_that_can_close_other_rungs_is_not_confirmed(monkeypatch, mutate):
    store = db()
    monkeypatch.setattr(aster_executor, "prepare_aster_campaign", lambda *_a, **_k: campaign())
    monkeypatch.setattr(aster_v3, "place_oto_entry_with_stop", lambda *_a, **_k: {"strategyId": 100})

    def unsafe_stop(_creds, strategy_id):
        row = confirmed_strategy(strategy_id, 100, campaign().rungs[0])
        mutate(row["subOrders"][1])
        return row

    monkeypatch.setattr(aster_v3, "read_strategy_order", unsafe_stop)
    result = submit(store)
    assert result["reject_reason"] == "ASTER_LINKED_STOP_UNCONFIRMED"
    assert result["status"] == "ambiguous"
