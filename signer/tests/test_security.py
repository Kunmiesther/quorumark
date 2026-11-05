"""HMAC middleware + nonce replay + timestamp window tests."""
from __future__ import annotations

import hashlib
import hmac
import os
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.security import enforce_signed_request, sanitize_response

SHARED = "test-shared-secret-32-bytes-min-length!"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SIGNER_SHARED_SECRET", SHARED)
    monkeypatch.setenv("SIGNER_ALLOWED_SKEW_SECONDS", "10")


def _sign(ts: str, nonce: str, path: str, body: bytes) -> str:
    msg = b"\n".join([ts.encode(), nonce.encode(), path.encode(), body])
    return hmac.new(SHARED.encode(), msg, hashlib.sha256).hexdigest()


def _app() -> TestClient:
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request):
        body = await enforce_signed_request(request)
        return {"len": len(body)}

    return TestClient(app)


def _headers(path: str, body: bytes, ts_override: int | None = None, nonce: str = None):
    ts = str(ts_override if ts_override is not None else int(time.time()))
    n = nonce or os.urandom(16).hex()
    return {
        "x-signer-timestamp": ts,
        "x-signer-nonce": n,
        "x-signer-signature": _sign(ts, n, path, body),
    }, n


def test_valid_request_passes():
    c = _app()
    body = b'{"hello":"world"}'
    h, _ = _headers("/echo", body)
    r = c.post("/echo", content=body, headers=h)
    assert r.status_code == 200 and r.json() == {"len": len(body)}


def test_bad_signature_is_rejected():
    c = _app()
    body = b"{}"
    h, _ = _headers("/echo", body)
    h["x-signer-signature"] = "0" * 64
    r = c.post("/echo", content=body, headers=h)
    assert r.status_code == 401
    assert r.json()["detail"] == "INVALID_HMAC_SIGNATURE"


def test_stale_timestamp_is_rejected():
    c = _app()
    body = b"{}"
    h, _ = _headers("/echo", body, ts_override=int(time.time()) - 999)
    r = c.post("/echo", content=body, headers=h)
    assert r.status_code == 401 and r.json()["detail"] == "TIMESTAMP_SKEW"


def test_future_timestamp_is_rejected():
    c = _app()
    body = b"{}"
    h, _ = _headers("/echo", body, ts_override=int(time.time()) + 999)
    assert c.post("/echo", content=body, headers=h).status_code == 401


def test_missing_headers_rejected():
    c = _app()
    r = c.post("/echo", content=b"{}")
    assert r.status_code == 401 and r.json()["detail"] == "MISSING_AUTH_HEADERS"


def test_nonce_replay_is_rejected():
    c = _app()
    body = b"{}"
    h, _ = _headers("/echo", body)
    assert c.post("/echo", content=body, headers=h).status_code == 200
    assert c.post("/echo", content=body, headers=h).status_code == 401


def test_body_tampering_is_rejected():
    """Signature is computed over the body; changing the body breaks it."""
    c = _app()
    body = b'{"a":1}'
    h, _ = _headers("/echo", body)
    tampered = b'{"a":2}'
    r = c.post("/echo", content=tampered, headers=h)
    assert r.status_code == 401
    assert r.json()["detail"] == "INVALID_HMAC_SIGNATURE"


def test_path_binding_is_rejected():
    """Signature is bound to the path; replaying to a different path fails."""
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request):
        await enforce_signed_request(request)
        return {"ok": True}

    @app.post("/other")
    async def other(request: Request):
        await enforce_signed_request(request)
        return {"ok": True}

    c = TestClient(app)
    body = b"{}"
    h, _ = _headers("/echo", body)
    r = c.post("/other", content=body, headers=h)
    assert r.status_code == 401
    assert r.json()["detail"] == "INVALID_HMAC_SIGNATURE"


def test_sanitize_response_drops_unlisted_fields():
    out = sanitize_response({
        "status": "submitted",
        "exchange_order_id": "abc",
        "seeds": "SECRET_LEAK",
        "l2Key": "SECRET_LEAK",
        "api_secret": "SECRET_LEAK",
        "passphrase": "SECRET_LEAK",
        "traceback": "SECRET_LEAK",
    })
    assert "seeds" not in out and "l2Key" not in out
    assert "api_secret" not in out and "passphrase" not in out
    assert out == {"status": "submitted", "exchange_order_id": "abc"}


def test_sanitize_response_keeps_shaped_internal_capital_fields_only():
    balances = {
        "funding": {"available": "12.5", "total": "14", "asset": "USDT"},
        "perps": {"available": "7", "total": "9.25", "asset": "USDT"},
    }
    receipt = {
        "accepted": True,
        "id": "transfer-1",
        "status": "submitted",
        "direction": "funding_to_perps",
    }
    out = sanitize_response({
        "status": "submitted",
        "balances": balances,
        "before": balances,
        "receipt": receipt,
        "destination_address": "MUST_NOT_LEAK",
        "chain_id": "MUST_NOT_LEAK",
        "seeds": "MUST_NOT_LEAK",
    })
    assert out == {
        "status": "submitted",
        "balances": balances,
        "before": balances,
        "receipt": receipt,
    }
