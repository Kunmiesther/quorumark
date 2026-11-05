"""Aster's private route cannot inherit ApeX credentials or feature flags."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient

os.environ["SIGNER_SHARED_SECRET"] = "0" * 64

import app.main as main  # noqa: E402


def signed_post(body):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = uuid.uuid4().hex
    path = "/v1/orders"
    signature = hmac.new(
        ("0" * 64).encode(),
        b"\n".join([ts.encode(), nonce.encode(), path.encode(), raw]),
        hashlib.sha256,
    ).hexdigest()
    return TestClient(main.app).post(path, content=raw, headers={
        "content-type": "application/json",
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": signature,
    })


def order():
    return {
        "user_id": "user", "exchange_connection_id": "conn",
        "client_order_id": "decision-12345678", "symbol": "BTC-USDT",
        "side": "BUY", "order_type": "MARKET", "leverage": 10,
        "environment": "mainnet", "purpose": "AUTOMATED_ENTRY",
        "venue": "aster", "campaign_rung_count": 5,
    }


def test_health_reports_actual_aster_entry_switch(monkeypatch):
    monkeypatch.setenv("ASTER_MAINNET_AUTOMATION_ENABLED", "true")
    monkeypatch.setattr(main, "is_enabled", lambda _: True)
    client = TestClient(main.app)
    assert client.get("/healthz").json()["aster_automation_enabled"] is True
    monkeypatch.setattr(main, "is_enabled", lambda _: False)
    assert client.get("/healthz").json()["aster_automation_enabled"] is False
    monkeypatch.setattr(main, "is_enabled", lambda _: True)
    monkeypatch.setenv("ASTER_MAINNET_AUTOMATION_ENABLED", "false")
    assert client.get("/healthz").json()["aster_automation_enabled"] is False


def test_aster_route_defaults_off_without_touching_credentials(monkeypatch):
    monkeypatch.delenv("ASTER_MAINNET_AUTOMATION_ENABLED", raising=False)
    reader = Mock(side_effect=AssertionError("credentials read while disabled"))
    monkeypatch.setattr(main, "_fetch_owned_rest_row", reader)
    response = signed_post(order())
    assert response.status_code == 403
    assert response.json()["detail"] == "ASTER_AUTOMATION_DISABLED"
    reader.assert_not_called()


def test_aster_route_refuses_unverified_trade_permission(monkeypatch):
    monkeypatch.setenv("ASTER_MAINNET_AUTOMATION_ENABLED", "true")
    monkeypatch.setattr(main, "_fetch_owned_rest_row", lambda *_a: {
        "exchange": "aster", "environment": "mainnet", "connection_status": "verified",
        "permission_trade": False, "permissions_verified": True,
    })
    decrypt = Mock(side_effect=AssertionError("unverified connection decrypted"))
    monkeypatch.setattr(main, "_decrypt_or_400", decrypt)
    response = signed_post(order())
    assert response.status_code == 409
    assert response.json()["detail"] == "ASTER_TRADE_PERMISSION_UNVERIFIED"
    decrypt.assert_not_called()


def test_aster_route_uses_own_connection_and_executor(monkeypatch):
    monkeypatch.setenv("ASTER_MAINNET_AUTOMATION_ENABLED", "true")
    monkeypatch.setattr(main, "_fetch_owned_rest_row", lambda *_a: {
        "exchange": "aster", "environment": "mainnet", "connection_status": "verified",
        "permission_trade": True, "permissions_verified": True,
    })
    credentials = SimpleNamespace(scrub=Mock())
    monkeypatch.setattr(main, "_decrypt_or_400", lambda *_a: credentials)
    monkeypatch.setattr(main, "_aster_credentials", lambda *_a: object())
    store = object()
    monkeypatch.setattr(main, "_db", lambda: store)
    executor = Mock(return_value={
        "status": "submitted", "exchange_order_id": "strategy-1",
        "exchange_status": "accepted", "campaign_rung_count": 5,
    })
    monkeypatch.setattr(main, "submit_aster_campaign", executor)
    response = signed_post({**order(), "leverage": 125})
    assert response.status_code == 200
    assert response.json()["exchange_order_id"] == "strategy-1"
    assert executor.call_args.kwargs["db"] is store
    assert executor.call_args.kwargs["symbol"] == "BTCUSDT"
    assert executor.call_args.kwargs["connection_id"] == "conn"
    assert executor.call_args.kwargs["leverage"] == 125
    credentials.scrub.assert_called_once()


def test_reduce_only_route_works_with_entries_paused(monkeypatch):
    monkeypatch.delenv("ASTER_MAINNET_AUTOMATION_ENABLED", raising=False)
    monkeypatch.setattr(main, "is_enabled", lambda op: op == "CLOSE_POSITION")
    monkeypatch.setattr(main, "_fetch_owned_rest_row", lambda *_: {
        "exchange": "aster", "environment": "production", "connection_status": "verified",
        "permission_trade": True, "permissions_verified": True})
    creds = SimpleNamespace(scrub=Mock())
    monkeypatch.setattr(main, "_decrypt_or_400", lambda *_: creds)
    monkeypatch.setattr(main, "_aster_credentials", lambda *_: object())
    monkeypatch.setattr(main, "_db", lambda: object())
    close = Mock(return_value={"status": "submitted", "exchange_status": "filled"})
    monkeypatch.setattr(main, "close_aster_position", close)
    entry = Mock(side_effect=AssertionError("exit must never submit an entry"))
    monkeypatch.setattr(main, "submit_aster_campaign", entry)
    payload = {**order(), "reduce_only": True, "purpose": "CLOSE_POSITION", "side": "SELL", "size": 0.01}
    payload.pop("leverage")
    payload.pop("campaign_rung_count")
    assert signed_post(payload).status_code == 200
    assert close.call_args.kwargs["connection_id"] == "conn"
    assert close.call_args.kwargs["quantity"] == 0.01
    creds.scrub.assert_called_once()
    assert signed_post({**payload, "leverage": 125}).status_code == 400
    entry.assert_not_called()
