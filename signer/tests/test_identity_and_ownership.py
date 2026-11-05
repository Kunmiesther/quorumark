"""F2: IDENTITY_MISMATCH when caller_jwt.sub != body.user_id.

F3: close-position and create-order derive REST creds from the credential
owner, never from body.user_id. A body.user_id that disagrees with the
credential owner is rejected with USER_MISMATCH (close-position);
create-order's body has no user_id field at all.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

import app.main as main
from tests.test_onboard import FakeDb, _body, _signed_post


@pytest.fixture(autouse=True)
def _identity_env(monkeypatch):
    monkeypatch.setenv("SIGNER_SHARED_SECRET", "test-shared-secret")
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)
    main._IDEM = type(main._IDEM)()
    from app import security
    security._nonce_cache.clear()


def _jwt_with_sub(sub: str) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": sub, "iss": "test"}).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.sig"


# -- F2 --------------------------------------------------------------------

def test_onboard_refuses_when_jwt_sub_does_not_match_user_id():
    db = FakeDb()
    main._DB = db
    client = TestClient(main.app)
    res = _signed_post(
        client, "/v1/onboard",
        _body(user_id="user-42", caller_jwt=_jwt_with_sub("attacker-1")),
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "IDENTITY_MISMATCH"
    assert db.inserted == []


def test_onboard_proceeds_when_jwt_sub_matches_user_id():
    db = FakeDb()
    main._DB = db
    client = TestClient(main.app)
    res = _signed_post(
        client, "/v1/onboard",
        _body(user_id="user-42", caller_jwt=_jwt_with_sub("user-42")),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "onboarded"


def test_onboard_refuses_malformed_jwt():
    db = FakeDb()
    main._DB = db
    client = TestClient(main.app)
    res = _signed_post(
        client, "/v1/onboard",
        _body(caller_jwt="not-a-jwt-at-all"),
    )
    # This value is shorter than the request model's minimum JWT length, so
    # the signer rejects the malformed request before identity inspection.
    assert res.status_code == 400
    assert res.json()["detail"] == "BAD_REQUEST"


# -- F3 --------------------------------------------------------------------

def test_create_order_body_has_no_user_id_field():
    """Contract test: only `cred['user_id']` can determine REST-cred owner."""
    from app.main import CreateOrderBody
    assert "user_id" not in CreateOrderBody.model_fields, (
        "CreateOrderBody must NOT accept user_id — the credential is the "
        "single source of truth for identity in the STARK signing path."
    )


def test_close_position_rejects_user_id_mismatch(monkeypatch):
    """A body.user_id != cred.user_id must be refused with USER_MISMATCH."""
    from app.main import ClosePositionBody
    assert "user_id" in ClosePositionBody.model_fields  # legacy shape

    class _CredDb:
        def fetch_active_credential(self, _cid):
            return {
                "id": "cred-1", "user_id": "owner-A",
                "environment": "mainnet",
                "wallet_address": "0x" + "a" * 40,
                "encrypted_credentials": "v1:x:y",
                "encryption_key_version": 1,
                "credential_fingerprint": "fp",
            }

    main._DB = _CredDb()
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)
    monkeypatch.setattr(main, "_canary_enabled", lambda: True)
    client = TestClient(main.app)

    body = {
        "credential_id": "cred-1",
        "exchange_connection_id": "conn-1",
        "user_id": "attacker-B",   # <-- disagrees with cred owner
        "client_order_id": "coid-close-1",
        "symbol": "BTC-USDT", "l2_pair_id": 1, "decimals": 8,
        "taker_fee_rate": "0.0005", "maker_fee_rate": "0.0002",
        "account_id": 1, "sub_account_id": 0, "slot_id": 0, "nonce": 1,
        "protected_price": "60000",
    }
    res = _signed_post(client, "/v1/close-position", body)
    assert res.status_code == 403
    assert res.json()["detail"] == "USER_MISMATCH"
