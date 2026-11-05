import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import aster_snapshot as snapshot, aster_v3, main
from tests.test_aster_lifecycle import post


def position(**changes):
    return {"symbol": "BTCUSDT", "positionAmt": "-0.01", "positionSide": "BOTH",
            "entryPrice": "80000", "markPrice": "79000", "unRealizedProfit": "10",
            "liquidationPrice": "81000", "leverage": "125", "isolatedMargin": "7",
            "marginType": "isolated", "private_key": "DO_NOT_ECHO", **changes}


def fill(**changes):
    return {"id": 12, "orderId": 34, "symbol": "BTCUSDT", "side": "SELL",
            "price": "80000", "qty": "0.01", "commission": "-0.2", "commissionAsset": "USDT",
            "maker": False, "time": 100, "positionSide": "BOTH", **changes}


@pytest.fixture(autouse=True)
def no_venue_writes(monkeypatch):
    for name in ("place_order", "cancel_order", "cancel_all", "set_leverage"):
        monkeypatch.setattr(aster_v3, name, Mock(side_effect=AssertionError("read attempted mutation")))


def test_positions_keep_side_and_sanitize(monkeypatch):
    monkeypatch.setattr(aster_v3, "read_positions", lambda *_: [position()])
    orders = Mock(return_value=[])
    monkeypatch.setattr(aster_v3, "read_open_orders", orders)
    result = snapshot.positions("wallet")
    assert result["positions"][0]["side"] == "SHORT"
    assert result["positions"][0]["size"] == "0.01"
    assert result["positions"][0]["symbol"] == "BTC-USDT"
    assert "DO_NOT_ECHO" not in json.dumps(result)
    orders.assert_called_once_with("wallet")


@pytest.mark.parametrize("field,value", [("positionAmt", None), ("markPrice", "NaN"),
    ("leverage", "Infinity"), ("positionSide", "LONG"), ("entryPrice", "0")])
def test_bad_position_never_becomes_flat(monkeypatch, field, value):
    monkeypatch.setattr(aster_v3, "read_positions", lambda *_: [position(**{field: value})])
    monkeypatch.setattr(aster_v3, "read_open_orders", lambda *_: [])
    with pytest.raises(aster_v3.AsterV3Error):
        snapshot.positions("wallet")


@pytest.mark.parametrize("other_symbol", ["BTCUSDC", "非ASCIIUSDT"])
def test_flat_unmapped_contract_does_not_hide_supported_exposure(monkeypatch, other_symbol):
    monkeypatch.setattr(aster_v3, "read_positions", lambda *_: [
        position(symbol=other_symbol, positionAmt="0"), position(),
    ])
    monkeypatch.setattr(aster_v3, "read_open_orders", lambda *_: [])
    assert snapshot.positions("wallet")["positions"][0]["symbol"] == "BTC-USDT"


def test_nonzero_unmapped_contract_is_not_silently_dropped(monkeypatch):
    monkeypatch.setattr(aster_v3, "read_positions", lambda *_: [position(symbol="BTCUSDC")])
    monkeypatch.setattr(aster_v3, "read_open_orders", lambda *_: [])
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_SNAPSHOT_INVALID_SYMBOL"):
        snapshot.positions("wallet")


def test_failed_open_order_read_aborts_entire_snapshot(monkeypatch):
    monkeypatch.setattr(aster_v3, "read_positions", lambda *_: [])
    monkeypatch.setattr(aster_v3, "read_open_orders", Mock(side_effect=aster_v3.AsterV3Error("OFFLINE")))
    with pytest.raises(aster_v3.AsterV3Error, match="OFFLINE"):
        snapshot.positions("wallet")


def test_missing_equity_is_not_zero(monkeypatch):
    monkeypatch.setattr(aster_v3, "read_account", lambda *_: {"totalWalletBalance": "5"})
    with pytest.raises(aster_v3.AsterV3Error):
        snapshot.equity("wallet")


def test_zero_equity_is_valid_observation(monkeypatch):
    monkeypatch.setattr(aster_v3, "read_account", lambda *_: {
        "totalWalletBalance": "0", "availableBalance": "0", "totalMarginBalance": "0"})
    assert snapshot.equity("wallet")["available_balance"] == "0"


def test_fills_read_all_four_symbols_and_namespace_ids(monkeypatch):
    def request(method, path, creds, params):
        assert method == "GET" and path == "/fapi/v3/userTrades" and creds == "wallet"
        return [fill(symbol=dict(params)["symbol"])]
    monkeypatch.setattr(aster_v3, "request", request)
    result = snapshot.fills("wallet", since_ts_ms=0, until_ts_ms=200)
    assert len(result["fills"]) == 4
    assert len({f["venue_fill_id"] for f in result["fills"]}) == 4
    assert all(f["fee"] == "0.2" for f in result["fills"])
    assert result["complete_through_ms"] == 200


def test_saturated_window_is_split_without_dropping_boundary_fills(monkeypatch):
    def request(_method, _path, _creds, params):
        p = dict(params)
        if p["symbol"] != "BTCUSDT": return []
        if p["startTime"] == 0 and p["endTime"] == 200: return [fill()] * 1000
        return [fill(id=p["startTime"], time=p["startTime"])]
    monkeypatch.setattr(aster_v3, "request", request)
    result = snapshot.fills("wallet", since_ts_ms=0, until_ts_ms=200)
    assert [f["fill_ts_ms"] for f in result["fills"]] == [0, 101]


def test_saturated_millisecond_refuses_cursor_advance(monkeypatch):
    monkeypatch.setattr(aster_v3, "request", lambda *_: [fill()] * 1000)
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_FILL_WINDOW_INCOMPLETE"):
        snapshot.fills("wallet", since_ts_ms=100, until_ts_ms=100)


def test_one_failed_symbol_aborts_full_fills_window(monkeypatch):
    def request(_m, _p, _c, params):
        if dict(params)["symbol"] == "ETHUSDT": raise aster_v3.AsterV3Error("OFFLINE")
        return [fill()]
    monkeypatch.setattr(aster_v3, "request", request)
    with pytest.raises(aster_v3.AsterV3Error, match="OFFLINE"):
        snapshot.fills("wallet", since_ts_ms=0, until_ts_ms=200)


@pytest.mark.parametrize("action", ["positions", "equity", "fills"])
def test_snapshot_route_auth_ownership_and_scrub(monkeypatch, action):
    monkeypatch.setenv("SIGNER_SHARED_SECRET", "0" * 64)
    monkeypatch.setattr(main, "is_enabled", lambda _: True)
    owned = Mock(return_value={"exchange": "aster", "environment": "production"})
    monkeypatch.setattr(main, "_fetch_owned_rest_row", owned)
    creds = SimpleNamespace(scrub=Mock())
    monkeypatch.setattr(main, "_decrypt_or_400", lambda _: creds)
    monkeypatch.setattr(main, "_aster_credentials", lambda _: "wallet")
    snapshots = {
        "positions": {"positions": [], "open_orders": []},
        "equity": {"total_equity": "12", "available_balance": "10", "wallet_balance": "11", "currency": "USDT"},
        "fills": {"fills": [{"venue_fill_id": "BTCUSDT:12", "fee": "0.2"}], "complete_through_ms": 200},
    }
    reader = Mock(return_value={**snapshots[action], "private_key": "DO_NOT_ECHO"})
    monkeypatch.setattr(snapshot, action, reader)
    body = {"user_id": "owner", "exchange_connection_id": "wallet-A"}
    path = f"/v1/aster/{action}"
    assert post(path, body, signed=False).status_code in (401, 403)
    owned.assert_not_called()
    response = post(path, body)
    assert response.status_code == 200
    assert response.json()["connection_id"] == "wallet-A"
    for key, value in snapshots[action].items():
        assert response.json()[key] == value
    assert "DO_NOT_ECHO" not in response.text
    assert owned.call_args.args[0].user_id == "owner"
    creds.scrub.assert_called_once()
    owned.return_value["exchange"] = "apex_omni"
    assert post(path, body).status_code == 409


def test_reconcile_route_auth_scope_and_unknown_state(monkeypatch):
    from app import aster_reconciliation
    monkeypatch.setenv("SIGNER_SHARED_SECRET", "0" * 64)
    monkeypatch.setattr(main, "is_enabled", lambda _: True)
    owned = Mock(return_value={"exchange": "aster", "environment": "production"})
    monkeypatch.setattr(main, "_fetch_owned_rest_row", owned)
    creds = SimpleNamespace(scrub=Mock())
    monkeypatch.setattr(main, "_decrypt_or_400", lambda _: creds)
    monkeypatch.setattr(main, "_aster_credentials", lambda _: "wallet")
    db = Mock()
    monkeypatch.setattr(main, "_db", lambda: db)
    reconcile = Mock(return_value={"reconciliation_required": True})
    monkeypatch.setattr(aster_reconciliation, "reconcile_connection", reconcile)
    body = {"user_id": "owner", "exchange_connection_id": "wallet-A"}
    path = "/v1/aster/reconcile-orders"
    assert post(path, body, signed=False).status_code in (401, 403)
    owned.assert_not_called()
    response = post(path, body)
    assert response.status_code == 200
    assert response.json()["reconciliation_required"] is True
    assert reconcile.call_args.kwargs["connection_id"] == "wallet-A"
    assert reconcile.call_args.kwargs["db"] is db
    creds.scrub.assert_called_once()
    owned.return_value["exchange"] = "apex_omni"
    assert post(path, body).status_code == 409
