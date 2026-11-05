from unittest.mock import Mock
import pytest
from app import aster_exit as exit, aster_v3


@pytest.fixture
def setup(monkeypatch):
    db = Mock()
    db.insert_order_intent.return_value = "intent"
    db.list_aster_intents.return_value = []
    monkeypatch.setattr(aster_v3, "read_position_mode", Mock(return_value="one_way"))
    monkeypatch.setattr(aster_v3, "read_positions", Mock(return_value=[{
        "symbol": "ETHUSDT", "positionSide": "BOTH", "positionAmt": "0.01"}]))
    monkeypatch.setattr(aster_v3, "read_open_orders", Mock(return_value=[]))
    place = Mock(return_value={"orderId": "close-1"})
    monkeypatch.setattr(aster_v3, "place_order", place)
    def read(_cred, symbol, client_id):
        return {"symbol": symbol, "clientOrderId": client_id, "orderId": "close-1",
                "side": "SELL", "positionSide": "BOTH", "reduceOnly": True,
                "type": "MARKET", "origQty": "0.01", "executedQty": "0.01", "status": "FILLED"}
    monkeypatch.setattr(aster_v3, "read_order", Mock(side_effect=read))
    return db, place


def close(db, **kw):
    return exit.close_position(db=db, credentials=object(), user_id="owner", connection_id="wallet-aster",
        client_order_id="close-request-1", symbol="ETHUSDT", **{"side": "SELL", "quantity": "0.01", "allow_cancel": True, **kw})


def test_exact_reduce_only_close_is_reserved_and_confirmed(setup):
    db, place = setup
    result = close(db)
    assert result["exchange_status"] == "filled"
    assert result["reconciliation_required"] is False
    args = place.call_args.kwargs
    assert args["symbol"] == "ETHUSDT" and args["side"] == "SELL"
    assert args["quantity"] == "0.01" and args["reduce_only"] is True
    assert db.insert_order_intent.call_args.args[0]["connection_id"] == "wallet-aster"
    assert db.insert_order_intent.call_args.args[0]["reduce_only"] is True


@pytest.mark.parametrize("kw", [{"side": "BUY"}, {"quantity": "0.02"}, {"quantity": "NaN"}, {"quantity": 0}])
def test_wrong_side_or_stale_quantity_never_submits(setup, kw):
    db, place = setup
    with pytest.raises(exit.AsterExitError): close(db, **kw)
    place.assert_not_called()


def test_remaining_entries_require_cancel_and_reconciliation(setup):
    db, place = setup
    aster_v3.read_open_orders.return_value = [{"symbol": "ETHUSDT", "reduceOnly": False}]
    with pytest.raises(exit.AsterExitError, match="ENTRY_ORDERS_PENDING"): close(db)
    place.assert_not_called()


def test_protective_stop_is_not_cancelled(setup):
    db, _ = setup
    aster_v3.read_open_orders.return_value = [{"symbol": "ETHUSDT", "reduceOnly": True}]
    assert close(db)["exchange_status"] == "filled"


def test_reused_close_id_never_reposts(setup):
    db, place = setup
    db.insert_order_intent.side_effect = ValueError("INTENT_DUPLICATE")
    with pytest.raises(exit.AsterExitError, match="RESERVATION_FAILED"): close(db)
    place.assert_not_called()


def test_timeout_is_unknown_and_not_retried(setup):
    db, place = setup
    place.side_effect = aster_v3.AsterV3Error("ASTER_TIMEOUT", ambiguous=True)
    assert close(db)["status"] == "ambiguous"
    place.assert_called_once()
    assert db.transition_order_intent.call_args.kwargs["state"] == "reconciliation_required"


def test_receipt_without_confirming_read_preserves_venue_id(setup):
    db, _ = setup
    aster_v3.read_order.side_effect = aster_v3.AsterV3Error("ASTER_2013")
    assert close(db)["status"] == "ambiguous"
    assert db.transition_order_intent.call_args.kwargs["exchange_order_id"] == "close-1"


def test_partial_fill_is_not_reported_as_closed(setup):
    db, _ = setup
    original = aster_v3.read_order.side_effect
    aster_v3.read_order.side_effect = lambda *args: {**original(*args), "status": "PARTIALLY_FILLED", "executedQty": "0.003"}
    result = close(db)
    assert result["filled_size"] == "0.003" and result["reconciliation_required"] is True


def test_position_changes_during_cancellation_requires_fresh_close_request(setup):
    db, place = setup
    aster_v3.read_positions.side_effect = [
        [{"symbol": "ETHUSDT", "positionSide": "BOTH", "positionAmt": "0.01"}],
        [{"symbol": "ETHUSDT", "positionSide": "BOTH", "positionAmt": "0.005"}],
    ]
    with pytest.raises(exit.AsterExitError, match="EXPOSURE_CHANGED"): close(db)
    place.assert_not_called()


def test_cancel_then_exit_full_path_persists_both_orders(setup, monkeypatch):
    from tests.test_aster_reconciliation import intent, entry
    db, place = setup
    i = intent(user_id="owner", connection_id="wallet-aster")
    db.list_aster_intents.return_value = [i]
    before = entry(i)
    aster_v3.read_open_orders.side_effect = [[before], []]
    exit_read = aster_v3.read_order.side_effect
    responses = [before, {**before, "status": "CANCELED"}]
    def read(*args):
        return responses.pop(0) if responses else exit_read(*args)
    aster_v3.read_order.side_effect = read
    cancel = Mock()
    monkeypatch.setattr(aster_v3, "cancel_order", cancel)
    assert close(db)["exchange_status"] == "filled"
    cancel.assert_called_once()
    place.assert_called_once()
    statuses = [call.kwargs["status"] for call in db.reconcile_aster_order.call_args_list]
    assert statuses == ["NEW", "CANCELED", "FILLED"]
