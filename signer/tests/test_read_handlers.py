"""Handler-level tests for read-only endpoints.

Guarantees under test:
  1. HMAC authentication is enforced — missing / wrong signature = 401.
  2. Ownership: a caller can never read a connection they do not own.
  3. Response and audit paths carry NO decrypted secret material.
  4. Upstream calls have a bounded timeout — no unbounded blocking.
  5. Zero order-submission requests are made from either handler.
  6. Operation flag is the sole authority; flipping it off refuses.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

# Configure before importing the app so shared-secret / env checks pass.
os.environ["SIGNER_SHARED_SECRET"] = "0" * 64
os.environ["TURTLE_CREDENTIAL_ENCRYPTION_KEY"] = "z" * 48  # >= 32 bytes
os.environ["APEX_OMNI_BASE_URL_MAINNET"] = "https://mainnet.test.invalid"
os.environ["APEX_OMNI_BASE_URL_TESTNET"] = "https://testnet.test.invalid"

import app.main as main  # noqa: E402
from app import apex_omni_rest, exchange_creds  # noqa: E402
from app.apex_omni_rest import AccountSnapshot, RestError  # noqa: E402


# -- helpers ---------------------------------------------------------------

def _encrypt(plaintext: str) -> str:
    """Match the TS encryptField format: v1:<b64iv>:<b64ct>."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.sha256(os.environ["TURTLE_CREDENTIAL_ENCRYPTION_KEY"].encode()).digest()
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    return "v1:" + base64.b64encode(iv).decode() + ":" + base64.b64encode(ct).decode()


def _row(user_id="u1", exchange="apex_omni", environment="mainnet"):
    return {
        "id": "cred-row-1",
        "user_id": user_id,
        "connection_id": "conn-1",
        "encrypted_api_key": _encrypt("api-key-XXXX"),
        "encrypted_api_secret": _encrypt("api-secret-YYYY"),
        "encrypted_passphrase": _encrypt("phrase-ZZZZ"),
        "encryption_version": 1,
        "exchange": exchange,
        "environment": environment,
        "connection_status": "connected",
    }


class FakeDb:
    def __init__(self, row=None):
        self._row = row
        self.touches = []
    def fetch_rest_credentials_owned(self, user_id, connection_id):
        if not self._row:
            return None
        if self._row["user_id"] != user_id or self._row["connection_id"] != connection_id:
            return None
        return dict(self._row)
    def touch_connection_verified(self, connection_id, user_id):
        self.touches.append((connection_id, user_id))
    # Unused stubs (kept so main._db() surface stays satisfied).
    def fetch_intent(self, *a, **k): return None
    def update_intent(self, *a, **k): pass
    def insert_audit(self, *a, **k): pass
    def fetch_active_credential(self, *a, **k): return None
    def revoke_credential(self, *a, **k): return False
    def insert_credential_audit(self, *a, **k): pass


@pytest.fixture(autouse=True)
def _wire(monkeypatch):
    main._IDEM = type(main._IDEM)()
    fake = FakeDb(_row())
    main._DB = fake
    main._CREDS = fake
    # Block ALL outbound HTTP by default; individual tests opt in with stubs.
    def _no_client(*a, **k):
        raise AssertionError("outbound HTTP not stubbed in this test")
    monkeypatch.setattr(apex_omni_rest, "_http_client", _no_client)
    yield
    main._DB = None
    main._CREDS = None


def _post(client, path, body, *, secret=b"0" * 64, tamper=False):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = f"n-{time.time_ns()}"
    msg = b"\n".join([ts.encode(), nonce.encode(), path.encode(), raw])
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()
    if tamper:
        sig = "0" * len(sig)
    return client.post(path, content=raw, headers={
        "content-type": "application/json",
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": sig,
    })


BODY = {"user_id": "u1", "exchange_connection_id": "conn-1"}


# -- 1. HMAC authentication -----------------------------------------------

def test_missing_hmac_headers_401():
    client = TestClient(main.app)
    r = client.post("/v1/verify-credentials",
                    content=json.dumps(BODY).encode(),
                    headers={"content-type": "application/json"})
    assert r.status_code == 401


def test_bad_hmac_signature_401():
    client = TestClient(main.app)
    r = _post(client, "/v1/verify-credentials", BODY, tamper=True)
    assert r.status_code == 401


def test_wrong_shared_secret_401():
    client = TestClient(main.app)
    r = _post(client, "/v1/read-account", BODY, secret=b"1" * 64)
    assert r.status_code == 401


# -- 2. Ownership ----------------------------------------------------------

def test_ownership_mismatch_returns_404_not_403(monkeypatch):
    """Different user_id claiming the same connection must NOT succeed and
    must not leak whether the connection exists."""
    main._DB = main._CREDS = FakeDb(_row(user_id="attacker-not-owner"))
    client = TestClient(main.app)
    r = _post(client, "/v1/verify-credentials", BODY)
    assert r.status_code == 404
    assert r.json()["detail"] == "CONNECTION_NOT_FOUND"


def test_unknown_connection_returns_404():
    main._DB = main._CREDS = FakeDb(None)
    client = TestClient(main.app)
    r = _post(client, "/v1/read-account", BODY)
    assert r.status_code == 404


# -- 3. Secret-safety in responses ----------------------------------------

class _StubClient:
    """Minimal httpx.Client stand-in supporting the context-manager + .get."""
    def __init__(self, status_code=200, payload=None, exc=None):
        self._status_code = status_code
        self._payload = payload or {"code": 0, "data": {
            "totalEquityValue": "1234.56",
            "availableBalance": "1000.00",
            "currency": "USDT",
            "permissions": {"read": True, "trade": True, "withdraw": False},
        }}
        self._exc = exc
        self.calls = []
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, headers=None):
        self.calls.append({"url": url, "headers": headers})
        if self._exc:
            raise self._exc
        class R:
            status_code = self._status_code
            content = json.dumps(self._payload).encode()
        return R()


def test_verify_success_response_is_whitelisted_and_leaks_nothing(monkeypatch):
    stub = _StubClient()
    monkeypatch.setattr(apex_omni_rest, "_http_client", lambda: stub)
    client = TestClient(main.app)
    r = _post(client, "/v1/verify-credentials", BODY)
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "status": "verified",
        "connection_id": "conn-1",
        "environment": "mainnet",
        "exchange": "apex_omni",
        "verified": True,
    }
    blob = json.dumps(body)
    for leak in ("api-key-XXXX", "api-secret-YYYY", "phrase-ZZZZ",
                 "encrypted_api_key", "APEX-SIGNATURE", "APEX-API-KEY"):
        assert leak not in blob, f"leaked {leak}"
    # Verified-at was touched.
    assert main._CREDS.touches == [("conn-1", "u1")]


def test_read_account_returns_only_whitelisted_snapshot_fields(monkeypatch):
    stub = _StubClient()
    monkeypatch.setattr(apex_omni_rest, "_http_client", lambda: stub)
    client = TestClient(main.app)
    r = _post(client, "/v1/read-account", BODY)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["exchange"] == "apex_omni"
    assert body["environment"] == "mainnet"
    assert body["account"] == {
        "accountId": None,
        "totalEquity": 1234.56,
        "availableBalance": 1000.0,
        "currency": "USDT",
        "permissions": {"read": True, "trade": True, "withdraw": False},
    }
    # Ensure raw upstream fields never appear.
    blob = json.dumps(body)
    for leak in ("totalEquityValue", "api-key", "api-secret", "phrase-",
                 "APEX-SIGNATURE"):
        assert leak not in blob, f"leaked {leak}"


def test_upstream_401_maps_to_unverified_no_body_leak(monkeypatch):
    stub = _StubClient(status_code=401, payload={"secret": "should-not-appear"})
    monkeypatch.setattr(apex_omni_rest, "_http_client", lambda: stub)
    client = TestClient(main.app)
    r = _post(client, "/v1/verify-credentials", BODY)
    assert r.status_code == 200
    body = r.json()
    assert body["verified"] is False
    assert body["reject_reason"] == "INVALID_CREDENTIALS"
    assert "should-not-appear" not in json.dumps(body)


# -- 4. Bounded timeouts ---------------------------------------------------

_HTTP_CLIENT_SRC = __import__("inspect").getsource(apex_omni_rest._http_client)


def test_read_endpoints_use_bounded_timeout():
    """Static guarantee: the client factory sets an explicit finite timeout."""
    assert "Timeout" in _HTTP_CLIENT_SRC
    # The declared budget must be small and finite.
    assert apex_omni_rest._TIMEOUT_SECONDS > 0
    assert apex_omni_rest._TIMEOUT_SECONDS <= 15


def test_upstream_timeout_maps_to_structured_error(monkeypatch):
    import httpx
    stub = _StubClient(exc=httpx.TimeoutException("boom"))
    monkeypatch.setattr(apex_omni_rest, "_http_client", lambda: stub)
    client = TestClient(main.app)
    r = _post(client, "/v1/read-account", BODY)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "error"
    assert body["reject_reason"] == "UPSTREAM_TIMEOUT"


# -- 5. Zero order submission ---------------------------------------------

def test_read_handlers_never_submit_orders():
    """Static assertion: neither handler contains any order-submission call
    or POST/PUT/DELETE machinery. If someone adds one, this catches it."""
    import inspect
    for fn in (main.verify_credentials, main.read_account):
        src = inspect.getsource(fn)
        for forbidden in ("create_order", "sign_order", "requests.post",
                          "httpx.post", "client.post", ".put(", ".delete("):
            assert forbidden not in src, f"{fn.__name__}: forbidden call {forbidden}"


def test_rest_module_only_exposes_get_helpers():
    import inspect
    src = inspect.getsource(apex_omni_rest)
    # No POST/PUT/DELETE http verbs anywhere in the read-only client.
    for forbidden in (".post(", ".put(", ".delete("):
        assert forbidden not in src, f"rest module has {forbidden}"


# -- 6. Operation flag is the sole authority ------------------------------

def test_verify_refused_when_operation_disabled(monkeypatch):
    from app import operations
    monkeypatch.setitem(operations.OPERATION_ENABLED, "VERIFY_CREDENTIALS", False)
    client = TestClient(main.app)
    r = _post(client, "/v1/verify-credentials", BODY)
    assert r.status_code == 403
    assert r.json()["detail"] == "OPERATION_DISABLED"


def test_read_account_refused_when_operation_disabled(monkeypatch):
    from app import operations
    monkeypatch.setitem(operations.OPERATION_ENABLED, "READ_ACCOUNT", False)
    client = TestClient(main.app)
    r = _post(client, "/v1/read-account", BODY)
    assert r.status_code == 403


# -- 7. HMAC signing scheme parity with the TS reference ------------------

def test_signing_matches_reference_vector():
    """Same known-answer vector as src/lib/exchanges/apex-omni-sign.test.ts."""
    sig = apex_omni_rest.sign(
        method="GET",
        request_path="/api/v3/account-balance",
        ts_ms=1_700_000_000_000,
        params="",
        secret="test-secret-abcdefghijklmnop",
    )
    assert sig == "nImrH1vhnPsRLU4jGtQPlyOw2DPxZruFgO6lbm3AOGk="


# -- 8. Envelope decryption round-trip ------------------------------------

def test_decrypt_field_roundtrip():
    ct = _encrypt("hello-world")
    assert exchange_creds.decrypt_field(ct) == "hello-world"


def test_decrypt_field_rejects_tamper():
    ct = _encrypt("payload")
    tampered = ct[:-4] + "AAAA"
    with pytest.raises(exchange_creds.ExchangeCredError):
        exchange_creds.decrypt_field(tampered)


def test_short_encryption_key_refused(monkeypatch):
    monkeypatch.setenv("TURTLE_CREDENTIAL_ENCRYPTION_KEY", "short")
    with pytest.raises(exchange_creds.ExchangeCredError):
        exchange_creds.decrypt_field("v1:AAAA:AAAA")
