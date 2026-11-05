"""Signer-side tests for the worker-ingest-backed service-role DB client.

Guarantees:
  * Client boots WITHOUT SUPABASE_SERVICE_ROLE_KEY.
  * find_active_credential_for_connection returns the credential row.
  * is_execution_halted maps the halted flag and fails CLOSED on transport.
  * insert_audit / insert_credential_audit / insert_order_intent shell
    correctly onto the underlying WorkerIngestClient methods.
  * /v1/orders reaches the builder using the worker-ingest-backed client
    (no service-role construction).
  * A credential-lookup miss returns 403 CREDENTIAL_REVOKED_OR_MISSING
    instead of MISSING_SUPABASE_SERVICE_CREDENTIALS.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import db as db_mod


CRED = {
    "id": "cred-1", "user_id": "u1", "exchange_connection_id": "conn-1",
    "environment": "mainnet",
    "wallet_address": "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    "apex_account_id": "101",
    "encrypted_credentials": "packed", "encryption_key_version": 1,
    "credential_fingerprint": "fp", "active": True, "revoked_at": None,
}


class FakeWIC:
    def __init__(self):
        self.calls = []
        self.next_cred = CRED
        self.next_halted = False
        self.raise_on_halted = None
        self.audit_rows = []
        self.cred_audit_rows = []
        self.intent_rows = []
        self.intent_transitions = []

    def find_active_apex_credential(self, *, user_id, exchange_connection_id, environment):
        self.calls.append(("find", user_id, exchange_connection_id, environment))
        return self.next_cred

    def check_execution_halted(self, *, user_id, connection_id):
        self.calls.append(("halted", user_id, connection_id))
        if self.raise_on_halted:
            raise self.raise_on_halted
        return self.next_halted

    def insert_order_audit_row(self, row):
        self.audit_rows.append(row)

    def insert_apex_credential_audit_row(self, row):
        self.cred_audit_rows.append(row)

    def insert_order_intent_row(self, row):
        self.intent_rows.append(row)
        return "intent-1"

    def transition_order_intent(self, **kw):
        self.intent_transitions.append(kw)


def test_client_boots_without_service_role_key(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", "s" * 32)
    c = db_mod.WorkerIngestBackedDbClient()
    assert c is not None


def test_find_active_credential_for_connection_shells_to_wic():
    fake = FakeWIC()
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    row = c.find_active_credential_for_connection(
        user_id="u1", exchange_connection_id="conn-1", environment="mainnet",
    )
    assert row == CRED
    assert fake.calls == [("find", "u1", "conn-1", "mainnet")]


def test_find_active_credential_missing_returns_none():
    fake = FakeWIC(); fake.next_cred = None
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    assert c.find_active_credential_for_connection(
        user_id="u1", exchange_connection_id="conn-1", environment="mainnet",
    ) is None


def test_is_execution_halted_false():
    fake = FakeWIC(); fake.next_halted = False
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    assert c.is_execution_halted("u1", "conn-1") is False


def test_is_execution_halted_true():
    fake = FakeWIC(); fake.next_halted = True
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    assert c.is_execution_halted("u1", "conn-1") is True


def test_is_execution_halted_fail_closed_on_transport_error():
    fake = FakeWIC(); fake.raise_on_halted = RuntimeError("boom")
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    assert c.is_execution_halted("u1", "conn-1") is True


def test_insert_audit_forwards_row():
    fake = FakeWIC()
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    c.insert_audit({"phase": "submitted", "user_id": "u1"})
    assert fake.audit_rows == [{"phase": "submitted", "user_id": "u1"}]


def test_insert_credential_audit_forwards_row():
    fake = FakeWIC()
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    c.insert_credential_audit({"event": "used", "user_id": "u1", "credential_id": "cred-1"})
    assert fake.cred_audit_rows == [
        {"event": "used", "user_id": "u1", "credential_id": "cred-1"}
    ]


def test_insert_order_intent_forwards_row_and_returns_id():
    fake = FakeWIC()
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    got = c.insert_order_intent({"client_order_id": "coid"})
    assert got == "intent-1"
    assert fake.intent_rows == [{"client_order_id": "coid"}]


def test_transition_order_intent_forwards_scoped_compare_and_swap():
    fake = FakeWIC()
    c = db_mod.WorkerIngestBackedDbClient(client=fake)
    c.transition_order_intent(intent_id="intent-1", user_id="u1",
                              state="submitted", exchange_order_id="venue-1")
    assert fake.intent_transitions == [{
        "intent_id": "intent-1", "user_id": "u1", "state": "submitted",
        "exchange_order_id": "venue-1", "state_reason": None,
    }]


def test_unsupported_methods_raise():
    c = db_mod.WorkerIngestBackedDbClient(client=FakeWIC())
    with pytest.raises(NotImplementedError):
        c.fetch_intent("u", "c")
    with pytest.raises(NotImplementedError):
        c.update_intent("i", {})
    with pytest.raises(NotImplementedError):
        c.fetch_active_credential("cred-1")
    with pytest.raises(NotImplementedError):
        c.revoke_credential("cred-1")
    with pytest.raises(NotImplementedError):
        c.insert_credential({"user_id": "u"})


# --- /v1/orders integration with the new backend ---------------------------

import base64
import hashlib
import hmac
import json
import time
import uuid
try:
    from fastapi.testclient import TestClient  # noqa: E402
    import app.main as main  # noqa: E402
    from app import apex_omni_rest, orders_v3  # noqa: E402
    _FASTAPI = True
except Exception:
    _FASTAPI = False

requires_fastapi = pytest.mark.skipif(not _FASTAPI, reason="fastapi not installed")


SHARED = "test-shared-secret"


def _signed_post(client: TestClient, path: str, body: dict):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = uuid.uuid4().hex
    sig = hmac.new(
        SHARED.encode(),
        b"\n".join([ts.encode(), nonce.encode(), path.encode(), raw]),
        hashlib.sha256,
    ).hexdigest()
    return client.post(path, content=raw, headers={
        "content-type": "application/json",
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": sig,
    })


def _body(**over):
    b = {
        "user_id": "u1", "exchange_connection_id": "conn-1",
        "client_order_id": "coid-abc-worker-ingest", "symbol": "BTC-USDT",
        "side": "BUY", "order_type": "MARKET", "size": 0.01, "price": 60000,
        "leverage": 100, "reduce_only": False, "environment": "mainnet",
        "purpose": "entry", "venue": "apex_omni",
    }
    b.update(over)
    return b


@pytest.fixture
def orders_env(monkeypatch):
    if not _FASTAPI:
        pytest.skip("fastapi not installed")
    main._IDEM = type(main._IDEM)()
    main._DB = None
    main._CREDS = None
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_V1", base64.b64encode(b"x" * 32).decode())
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_ACTIVE", "1")
    monkeypatch.setenv("TURTLE_CREDENTIAL_ENCRYPTION_KEY", "z" * 40)
    monkeypatch.setenv("SIGNER_SHARED_SECRET", SHARED)
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)
    monkeypatch.setattr(main, "_canary_enabled", lambda: True)
    monkeypatch.setattr(main, "is_enabled", lambda op: True)
    monkeypatch.setattr(main, "decrypt_bundle", lambda _pkg, _ctx: {"seeds": "ff" * 32})
    monkeypatch.setattr(main, "decrypt_rest_credentials", lambda row: SimpleNamespace(
        api_key="k", api_secret="s", passphrase="",
        scrub=lambda: None,
    ))
    monkeypatch.setattr(apex_omni_rest, "get_symbol_config", lambda env, sym: apex_omni_rest.SymbolConfig(
        symbol="BTC-USDT", l2_pair_id=1, decimals=8,
        tick_size="0.1", step_size="0.001",
        taker_fee_rate="0.0005", maker_fee_rate="0.0002",
        min_order_size="0.001", max_order_size="50", max_leverage=100,
    ))
    monkeypatch.setattr(apex_omni_rest, "get_user_stark_context",
                        lambda env, k, s, p, **_kw: apex_omni_rest.UserStarkContext(
                            account_id=101, sub_account_id=201, slot_id=1))
    monkeypatch.setattr(apex_omni_rest, "get_mark_price", lambda env, sym: "60000")
    monkeypatch.setattr(apex_omni_rest, "read_account", lambda **kw: apex_omni_rest.AccountSnapshot(
        account_id=101,
        total_equity=1000.0, available_balance=1000.0, currency="USDT",
        permission_read=True, permission_trade=True, permission_withdraw=False,
    ))
    monkeypatch.setattr(apex_omni_rest, "read_account_balance", lambda **kw: apex_omni_rest.AccountSnapshot(
        account_id=None,
        total_equity=1000.0, available_balance=1000.0, currency="USDT",
        permission_read=True, permission_trade=True, permission_withdraw=False,
    ))
    monkeypatch.setattr(orders_v3, "get_positions", lambda env, c: [])
    monkeypatch.setattr(orders_v3, "get_open_orders", lambda env, c, symbol=None: [])
    monkeypatch.setattr(main, "zk_sign_order", lambda **kw: SimpleNamespace(
        signature="SIG", client_order_id=kw["client_order_id"], l2_key="0x" + "a" * 64,
    ))
    n = {"i": 0}
    def _create(env, creds, params):
        n["i"] += 1
        result = {"venue_order_id": f"V{n['i']}",
                  "client_order_id": params.get("clientOrderId"), "status": "accepted"}
        if params.get("attached_sl"):
            result["sl_venue_order_id"] = f"V{n['i']}-SL"
        return result
    monkeypatch.setattr(orders_v3, "create_order", _create)

    class _SdkOrderClient:
        def __init__(self, *args, **kwargs):
            pass

        def create_order(self, params):
            return _create("mainnet", None, params)

    monkeypatch.setattr(main, "SdkOrderClient", _SdkOrderClient)
    yield
    main._DB = None
    main._CREDS = None


@requires_fastapi
def test_orders_uses_worker_ingest_backed_db_and_submits(orders_env):
    """/v1/orders with the DEFAULT backend (no service-role env) must reach
    the submit path — proves the MISSING_SUPABASE_SERVICE_CREDENTIALS
    regression is gone.
    """
    fake_wic = FakeWIC()
    main._DB = db_mod.WorkerIngestBackedDbClient(client=fake_wic)

    class _CredsReader:
        def fetch_rest_credentials_owned(self, user_id, connection_id):
            return {
                "id": "rc-1", "user_id": user_id, "connection_id": connection_id,
                "encrypted_api_key": "v1:AAAA:BBBB", "encrypted_api_secret": "v1:AAAA:CCCC",
                "encrypted_passphrase": None, "encryption_version": 1,
                "exchange": "apex_omni", "environment": "mainnet",
                "connection_status": "active",
            }
    main._CREDS = _CredsReader()

    res = _signed_post(TestClient(main.app), "/v1/orders", _body())
    assert res.status_code == 200, res.text
    j = res.json()
    assert j["status"] == "submitted", j
    # The credential lookup and halted check MUST have gone through the
    # worker-ingest client, not any direct Data API path.
    kinds = [c[0] for c in fake_wic.calls]
    assert "find" in kinds
    assert "halted" in kinds


@requires_fastapi
def test_orders_missing_credential_returns_403_not_500(orders_env):
    fake_wic = FakeWIC(); fake_wic.next_cred = None
    main._DB = db_mod.WorkerIngestBackedDbClient(client=fake_wic)

    class _CredsReader:
        def fetch_rest_credentials_owned(self, u, c): return None
    main._CREDS = _CredsReader()

    res = _signed_post(TestClient(main.app), "/v1/orders",
                       _body(client_order_id="coid-missing"))
    assert res.status_code == 403
    # The subcode is the /v1/orders-shaped one, NOT MISSING_SUPABASE_SERVICE_CREDENTIALS.
    detail = res.json().get("detail", "")
    assert detail == "CREDENTIAL_REVOKED_OR_MISSING"
    assert "SERVICE_CREDENTIALS" not in detail
