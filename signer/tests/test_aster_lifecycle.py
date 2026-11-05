from types import SimpleNamespace
from unittest.mock import Mock
import hashlib
import hmac
import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app import aster_lifecycle as lifecycle, aster_v3
from app import main


TARGET = dict(user_id="owner", connection_id="wallet-A", client_order_id="decision-1234",
              symbol="BTCUSDT", rung=1)


def entry(status="NEW", filled="0"):
    _, entry_id = lifecycle.entry_identity(**TARGET)
    return {"symbol": "BTCUSDT", "clientOrderId": entry_id, "orderId": 123,
            "type": "LIMIT", "positionSide": "BOTH", "side": "BUY",
            "reduceOnly": False, "closePosition": False, "status": status,
            "origQty": "0.01", "executedQty": filled, "private_key": "MUST_NOT_LEAK"}


@pytest.fixture
def venue(monkeypatch):
    reader = Mock(return_value=entry())
    cancel = Mock(return_value={"status": "CANCELED"})
    monkeypatch.setattr(aster_v3, "read_order", reader)
    monkeypatch.setattr(aster_v3, "cancel_order", cancel)
    monkeypatch.setattr(aster_v3, "cancel_all", Mock(side_effect=AssertionError("broad cancel")))
    monkeypatch.setattr(aster_v3, "place_order", Mock(side_effect=AssertionError("new order")))
    return reader, cancel


def test_read_is_read_only_and_sanitized(venue):
    reader, cancel = venue
    result = lifecycle.observe_entry(object(), **TARGET)
    assert result["status"] == "observed"
    assert result["campaign_orders"][0]["remaining_quantity"] == "0.01"
    assert "MUST_NOT_LEAK" not in json.dumps(result)
    assert reader.call_args.args[1:] == ("BTCUSDT", lifecycle.entry_identity(**TARGET)[1])
    cancel.assert_not_called()


@pytest.mark.parametrize("field,value", [("user_id", "other"), ("connection_id", "wallet-B"),
                                         ("rung", 2), ("client_order_id", "another-decision")])
def test_each_execution_identity_has_distinct_ids(field, value):
    assert lifecycle.entry_identity(**TARGET) != lifecycle.entry_identity(**{**TARGET, field: value})


@pytest.mark.parametrize("field,value", [
    ("symbol", "ETHUSDT"), ("clientOrderId", "external-order"), ("type", "STOP_MARKET"),
    ("reduceOnly", True), ("closePosition", True), ("reduceOnly", 0), ("positionSide", "LONG"),
    ("status", "UNKNOWN"), ("executedQty", "NaN"), ("origQty", "Infinity"),
    ("executedQty", "0.02"), ("origQty", "0"), ("side", "OTHER"),
])
def test_mismatched_or_malformed_entry_never_cancels(venue, field, value):
    reader, cancel = venue
    reader.return_value = {**entry(), field: value}
    with pytest.raises(lifecycle.AsterLifecycleError):
        lifecycle.cancel_entry(object(), **TARGET)
    cancel.assert_not_called()


def test_cancel_only_targets_entry_and_reports_racing_fill(venue):
    reader, cancel = venue
    reader.side_effect = [entry(), entry("CANCELED", "0.003")]
    result = lifecycle.cancel_entry(object(), **TARGET)
    assert result["status"] == "cancelled"
    assert result["campaign_orders"][0]["executed_quantity"] == "0.003"
    assert result["campaign_orders"][0]["remaining_quantity"] == "0"
    cancel.assert_called_once()
    assert cancel.call_args.kwargs == {
        "symbol": "BTCUSDT", "client_order_id": lifecycle.entry_identity(**TARGET)[1],
    }
    assert cancel.call_args.kwargs["client_order_id"].endswith("-e")


def test_partial_entry_cancellation_does_not_close_filled_position(venue):
    reader, cancel = venue
    reader.side_effect = [entry("PARTIALLY_FILLED", "0.003"), entry("CANCELED", "0.005")]
    result = lifecycle.cancel_entry(object(), **TARGET)
    assert result["campaign_orders"][0]["executed_quantity"] == "0.005"
    cancel.assert_called_once()
    aster_v3.place_order.assert_not_called()
    aster_v3.cancel_all.assert_not_called()


@pytest.mark.parametrize("status,filled", [("FILLED", "0.01"), ("CANCELED", "0"), ("EXPIRED", "0")])
def test_terminal_order_never_repeats_cancel(venue, status, filled):
    reader, cancel = venue
    reader.return_value = entry(status, filled)
    assert lifecycle.cancel_entry(object(), **TARGET)["status"] == "noop"
    cancel.assert_not_called()


def test_unknown_order_cancel_race_is_read_again_without_retry(venue):
    reader, cancel = venue
    reader.side_effect = [entry(), entry("FILLED", "0.01")]
    cancel.side_effect = aster_v3.AsterV3Error("ASTER_2011")
    result = lifecycle.cancel_entry(object(), **TARGET)
    assert result["status"] == "observed"
    assert result["campaign_orders"][0]["exchange_status"] == "FILLED"
    cancel.assert_called_once()


@pytest.mark.parametrize("after", [entry(), aster_v3.AsterV3Error("ASTER_TIMEOUT"),
                                  {**entry("CANCELED"), "orderId": 999}])
def test_failed_cancel_verification_is_ambiguous(venue, after):
    reader, cancel = venue
    reader.side_effect = [entry(), after]
    with pytest.raises(lifecycle.AsterLifecycleError) as error:
        lifecycle.cancel_entry(object(), **TARGET)
    assert error.value.ambiguous is True
    cancel.assert_called_once()


def test_missing_entry_does_not_mean_safe_to_resubmit(venue):
    reader, cancel = venue
    reader.side_effect = aster_v3.AsterV3Error("ASTER_2013")
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_2013"):
        lifecycle.observe_entry(object(), **TARGET)
    cancel.assert_not_called()


def post(path, body, *, signed=True):
    raw = json.dumps(body).encode()
    ts, nonce = str(int(time.time())), uuid.uuid4().hex
    signature = hmac.new(("0" * 64).encode(), b"\n".join([
        ts.encode(), nonce.encode(), path.encode(), raw,
    ]), hashlib.sha256).hexdigest()
    return TestClient(main.app).post(path, content=raw, headers={
        "content-type": "application/json", "x-signer-timestamp": ts,
        "x-signer-nonce": nonce, "x-signer-signature": signature if signed else "wrong",
    })


@pytest.fixture
def route(monkeypatch, venue):
    monkeypatch.setenv("SIGNER_SHARED_SECRET", "0" * 64)
    monkeypatch.delenv("ASTER_MAINNET_AUTOMATION_ENABLED", raising=False)
    row = {"exchange": "aster", "environment": "mainnet", "connection_status": "verified",
           "permission_trade": True, "permissions_verified": True}
    owned = Mock(return_value=row)
    creds = SimpleNamespace(scrub=Mock())
    decrypt = Mock(return_value=creds)
    monkeypatch.setattr(main, "_fetch_owned_rest_row", owned)
    monkeypatch.setattr(main, "_decrypt_or_400", decrypt)
    monkeypatch.setattr(main, "_aster_credentials", lambda _: object())
    body = {"user_id": TARGET["user_id"], "exchange_connection_id": TARGET["connection_id"],
            "client_order_id": TARGET["client_order_id"], "symbol": "BTC-USDT", "rung": 1}
    return row, owned, creds, decrypt, body


def test_signed_read_works_when_new_entries_are_disabled(route):
    row, owned, creds, decrypt, body = route
    response = post("/v1/aster/entry-status", body)
    assert response.status_code == 200
    assert response.json()["status"] == "observed"
    assert owned.call_args.args[0].user_id == TARGET["user_id"]
    assert owned.call_args.args[0].exchange_connection_id == TARGET["connection_id"]
    creds.scrub.assert_called_once()


@pytest.mark.parametrize("path", ["/v1/aster/entry-status", "/v1/aster/cancel-entry"])
def test_lifecycle_requires_hmac_before_credentials(route, path):
    _, owned, _, decrypt, body = route
    assert post(path, body, signed=False).status_code in (401, 403)
    owned.assert_not_called()
    decrypt.assert_not_called()


def test_aster_lifecycle_cannot_use_apex_wallet(route):
    row, _, _, decrypt, body = route
    row["exchange"] = "apex_omni"
    assert post("/v1/aster/cancel-entry", body).status_code == 409
    decrypt.assert_not_called()


def test_cancel_requires_verified_permission(route):
    row, _, _, decrypt, body = route
    row["permission_trade"] = False
    assert post("/v1/aster/cancel-entry", body).status_code == 409
    decrypt.assert_not_called()


def test_route_rejects_arbitrary_order_ids_and_extra_fields(route):
    _, owned, _, _, body = route
    assert post("/v1/aster/cancel-entry", {**body, "order_id": "manual-btc-short"}).status_code == 400
    owned.assert_not_called()


def test_post_cancel_read_failure_returns_uncertainty_and_scrubs(route, venue):
    _, _, creds, _, body = route
    reader, _ = venue
    reader.side_effect = [entry(), aster_v3.AsterV3Error("ASTER_TIMEOUT")]
    response = post("/v1/aster/cancel-entry", body)
    assert response.status_code == 200
    assert response.json() == {"status": "ambiguous", "reject_reason": "ASTER_CANCEL_RECONCILIATION_REQUIRED"}
    creds.scrub.assert_called_once()
