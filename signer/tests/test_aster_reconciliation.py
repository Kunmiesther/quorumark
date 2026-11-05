from unittest.mock import Mock
import pytest
from app import aster_v3
from app.aster_executor import _strategy_id
from app import aster_reconciliation as r


def intent(**changes):
    return {"id": "intent", "user_id": "u", "connection_id": "c", "symbol": "ETHUSDT",
            "client_order_id": _strategy_id("u", "c", "campaign", 1), "size": "0.01",
            "side": "BUY", "order_type": "LIMIT", "reduce_only": False, "filled_size": "0",
            **changes}


def entry(i, **changes):
    return {"orderId": "entry-1", "clientOrderId": r.venue_client_id(i), "symbol": "ETHUSDT",
            "side": "BUY", "type": "LIMIT", "positionSide": "BOTH", "reduceOnly": False,
            "closePosition": False, "origQty": "0.01", "executedQty": "0", "status": "NEW", **changes}


@pytest.fixture
def env(monkeypatch):
    i = intent()
    db = Mock()
    db.list_aster_intents.return_value = [i]
    monkeypatch.setattr(aster_v3, "read_order", Mock(return_value=entry(i)))
    monkeypatch.setattr(aster_v3, "read_open_orders", Mock(return_value=[]))
    monkeypatch.setattr(aster_v3, "cancel_order", Mock())
    monkeypatch.setattr(aster_v3, "place_order", Mock(side_effect=AssertionError("reconcile must not trade")))
    return db, i


def cancel(db):
    return r.cancel_pending_entries(db=db, credentials=object(), user_id="u", connection_id="c", symbol="ETHUSDT")


def test_cancel_owned_entry_preserves_stops_and_records_fill_race(env):
    db, i = env
    stop = {"symbol": "ETHUSDT", "reduceOnly": True, "clientOrderId": "stop-1"}
    aster_v3.read_open_orders.side_effect = [[entry(i), stop], [stop]]
    aster_v3.read_order.side_effect = [entry(i), entry(i, status="CANCELED", executedQty="0.004")]
    cancel(db)
    assert aster_v3.cancel_order.call_args.kwargs["client_order_id"] == r.venue_client_id(i)
    assert db.reconcile_aster_order.call_args.kwargs["filled"] == "0.004"
    assert db.reconcile_aster_order.call_args.kwargs["status"] == "CANCELED"
    aster_v3.place_order.assert_not_called()


def test_unknown_manual_entry_prevents_entire_cancel_set(env):
    db, i = env
    aster_v3.read_open_orders.return_value = [entry(i), entry(i, clientOrderId="manual")]
    with pytest.raises(r.AsterReconciliationError, match="ENTRY_ORDERS_PENDING"): cancel(db)
    aster_v3.cancel_order.assert_not_called()


def test_other_connection_not_cancelled(env):
    db, i = env
    db.list_aster_intents.return_value = [{**i, "connection_id": "other"}]
    aster_v3.read_open_orders.return_value = [entry(i)]
    with pytest.raises(r.AsterReconciliationError): cancel(db)
    aster_v3.cancel_order.assert_not_called()


def test_cancel_unknown_not_retried(env):
    db, i = env
    aster_v3.read_open_orders.return_value = [entry(i)]
    aster_v3.cancel_order.side_effect = aster_v3.AsterV3Error("ASTER_TIMEOUT", ambiguous=True)
    with pytest.raises(aster_v3.AsterV3Error): cancel(db)
    aster_v3.cancel_order.assert_called_once()


def test_cancel_races_full_fill(env):
    db, i = env
    aster_v3.read_open_orders.side_effect = [[entry(i)], []]
    aster_v3.cancel_order.side_effect = aster_v3.AsterV3Error("ASTER_2011")
    aster_v3.read_order.side_effect = [entry(i), entry(i, status="FILLED", executedQty="0.01")]
    cancel(db)
    assert db.reconcile_aster_order.call_args.kwargs["status"] == "FILLED"


def test_lost_cancel_confirmation_never_claims_success(env):
    db, i = env
    aster_v3.read_open_orders.return_value = [entry(i)]
    with pytest.raises(r.AsterReconciliationError, match="RECONCILIATION_REQUIRED"): cancel(db)


def test_restart_recovers_persisted_intent_without_reposting(env):
    db, i = env
    aster_v3.read_order.return_value = entry(i, status="FILLED", executedQty="0.01")
    result = r.reconcile_connection(db=db, credentials=object(), user_id="u", connection_id="c")
    assert result == {"status": "reconciled", "reconciliation_required": False, "observed": 1, "unknown": 0}
    assert db.reconcile_aster_order.call_args.kwargs["status"] == "FILLED"
    aster_v3.place_order.assert_not_called()
    aster_v3.cancel_order.assert_not_called()


def test_missing_order_stays_unknown_not_flat(env):
    db, _ = env
    aster_v3.read_order.side_effect = aster_v3.AsterV3Error("ASTER_2013")
    result = r.reconcile_connection(db=db, credentials=object(), user_id="u", connection_id="c")
    assert result["reconciliation_required"] is True
    assert db.reconcile_aster_order.call_args.kwargs["status"] == "UNKNOWN"


@pytest.mark.parametrize("changes", [{"side": "SELL"}, {"origQty": "0.02"}, {"reduceOnly": True}, {"clientOrderId": "other"}])
def test_mismatched_venue_observation_never_persisted_as_success(env, changes):
    db, i = env
    aster_v3.read_order.return_value = entry(i, **changes)
    assert r.reconcile_connection(db=db, credentials=object(), user_id="u", connection_id="c")["unknown"] == 1
    assert db.reconcile_aster_order.call_args.kwargs["status"] == "UNKNOWN"


def test_durable_write_failure_not_reported_success(env):
    db, i = env
    db.reconcile_aster_order.side_effect = RuntimeError("database unavailable")
    with pytest.raises(RuntimeError):
        r.reconcile_connection(db=db, credentials=object(), user_id="u", connection_id="c")


def test_inflight_campaign_cannot_race_cancellation(env):
    db, i = env
    db.list_aster_intents.return_value = [{**i, "state": "signing"}]
    aster_v3.read_open_orders.return_value = [entry(i)]
    with pytest.raises(r.AsterReconciliationError, match="SUBMISSION_IN_PROGRESS"): cancel(db)
    aster_v3.cancel_order.assert_not_called()


def test_cancel_disabled_does_not_mutate(env):
    db, i = env
    aster_v3.read_open_orders.return_value = [entry(i)]
    with pytest.raises(r.AsterReconciliationError, match="CANCEL_ORDER_DISABLED"):
        r.cancel_pending_entries(db=db, credentials=object(), user_id="u", connection_id="c", symbol="ETHUSDT", allow_cancel=False)
    aster_v3.cancel_order.assert_not_called()
