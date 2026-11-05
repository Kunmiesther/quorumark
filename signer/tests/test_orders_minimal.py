"""POST /v1/orders — minimal-body live-forwarding endpoint.

Verifies the contract the Supabase edge broker (`execution-broker` +
`supabase/functions/_shared/signer-client.ts`) forwards under. Every path
is exercised through the FastAPI TestClient with a fake DB, fake REST
credentials reader, fake ApeX metadata fetches, and a fake signer that
records but never touches the network.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import apex_omni_rest, orders_v3
from app.crypto import EnvelopeContext, encrypt_bundle


SHARED = "test-shared-secret"

CRED = {
    "id": "cred-1", "user_id": "u1", "exchange_connection_id": "conn-1",
    "environment": "mainnet",
    "wallet_address": "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    "apex_account_id": "101",
    "encrypted_credentials": "packed", "encryption_key_version": 1,
    "credential_fingerprint": "fp", "active": True, "revoked_at": None,
}


class FakeDb:
    def __init__(self, cred=CRED):
        self._cred = cred
        self.halted = False
        self.intents = {}
    def find_active_credential_for_connection(self, **kw):
        return self._cred
    def fetch_active_credential(self, cid):
        return self._cred
    def is_execution_halted(self, user_id, connection_id):
        return self.halted
    def insert_order_intent(self, row):
        key = (row["user_id"], row["client_order_id"])
        if key in self.intents:
            raise RuntimeError("INTENT_DUPLICATE")
        intent_id = f"intent-{len(self.intents) + 1}"
        self.intents[key] = {**dict(row), "id": intent_id}
        return intent_id
    def transition_order_intent(self, *, intent_id, user_id, state,
                                exchange_order_id=None, state_reason=None):
        row = next(v for (u, _), v in self.intents.items()
                   if u == user_id and v["id"] == intent_id)
        assert row["state"] == "signing"
        row.update(state=state, exchange_order_id=exchange_order_id,
                   state_reason=state_reason)
    def fetch_intent(self, u, c): return None
    def update_intent(self, i, patch): pass
    def insert_audit(self, row): pass


class FakeCredsReader:
    def fetch_rest_credentials_owned(self, user_id, connection_id):
        return {
            "id": "rc-1", "user_id": user_id, "connection_id": connection_id,
            "encrypted_api_key": "v1:AAAA:BBBB", "encrypted_api_secret": "v1:AAAA:CCCC",
            "encrypted_passphrase": None, "encryption_version": 1,
            "exchange": "apex_omni", "environment": "mainnet",
            "connection_status": "active",
        }


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


def _sym_cfg():
    return apex_omni_rest.SymbolConfig(
        symbol="BTC-USDT", l2_pair_id=1, decimals=8,
        tick_size="0.1", step_size="0.001",
        taker_fee_rate="0.0005", maker_fee_rate="0.0002",
        min_order_size="0.001", max_order_size="50", max_leverage=100,
    )


def _user_ctx():
    return apex_omni_rest.UserStarkContext(account_id=101, sub_account_id=201, slot_id=1)


def _account(equity=1000.0):
    return apex_omni_rest.AccountSnapshot(
        account_id=101,
        total_equity=equity, available_balance=equity, currency="USDT",
        permission_read=True, permission_trade=True, permission_withdraw=False,
    )


@pytest.fixture(autouse=True)
def _wire(monkeypatch):
    # Fresh idempotency cache per test.
    main._IDEM = type(main._IDEM)()
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_V1", base64.b64encode(b"x" * 32).decode())
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_ACTIVE", "1")
    monkeypatch.setenv("TURTLE_CREDENTIAL_ENCRYPTION_KEY", "z" * 40)
    monkeypatch.setenv("SIGNER_SHARED_SECRET", SHARED)
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)
    monkeypatch.setattr(main, "_canary_enabled", lambda: True)
    monkeypatch.setattr(main, "is_enabled", lambda op: True)
    monkeypatch.setattr(main, "decrypt_bundle", lambda _pkg, _ctx: {"seeds": "ff" * 32})
    # exchange_creds decrypt path (called via decrypt_rest_credentials)
    monkeypatch.setattr(main, "decrypt_rest_credentials", lambda row: SimpleNamespace(
        api_key="k", api_secret="s", passphrase="",
        omni_seed=None,
        scrub=lambda: None,
    ))
    # ApeX metadata + preflight fakes.
    monkeypatch.setattr(apex_omni_rest, "get_symbol_config", lambda env, sym: _sym_cfg())
    monkeypatch.setattr(apex_omni_rest, "get_user_stark_context",
                        lambda env, k, s, p, **_kw: _user_ctx())
    monkeypatch.setattr(apex_omni_rest, "get_mark_price", lambda env, sym: "60000")
    monkeypatch.setattr(apex_omni_rest, "read_account", lambda **kw: _account())
    monkeypatch.setattr(apex_omni_rest, "read_account_balance", lambda **kw: _account())
    monkeypatch.setattr(orders_v3, "get_positions", lambda env, c: [])
    monkeypatch.setattr(orders_v3, "get_open_orders", lambda env, c, symbol=None: [])
    # SDK-backed create-order fake for the pipeline. The pipeline delegates
    # signing/submission to SdkOrderClient and never constructs STARK payloads.
    call_count = {"n": 0}
    class FakeSdkOrderClient:
        def __init__(self, *a, **k): pass
        def create_order(self, params):
            call_count["n"] += 1
            result = {"venue_order_id": f"V{call_count['n']}",
                      "client_order_id": params.get("clientId"), "status": "accepted"}
            if params.get("attached_sl"):
                result["sl_venue_order_id"] = f"V{call_count['n']}-SL"
            return result
    monkeypatch.setattr(main, "SdkOrderClient", FakeSdkOrderClient)


def _client():
    main._DB = FakeDb()
    main._CREDS = FakeCredsReader()
    return TestClient(main.app)


def _body(**over):
    b = {
        "user_id": "u1", "exchange_connection_id": "conn-1",
        "client_order_id": "coid-abc", "symbol": "BTC-USDT",
        "side": "BUY", "order_type": "MARKET", "size": 0.01, "price": 60000,
        "leverage": 100, "reduce_only": False, "environment": "mainnet",
        "purpose": "entry", "venue": "apex_omni",
    }
    b.update(over)
    return b


# --- Happy path ------------------------------------------------------------
def test_minimal_body_stages_signs_and_submits():
    res = _signed_post(_client(), "/v1/orders", _body())
    assert res.status_code == 200, res.text
    j = res.json()
    assert j["status"] == "submitted"
    assert j["exchange_order_id"].startswith("V")
    assert j["exchange_status"] == "accepted"


@pytest.mark.parametrize("environment", ["mainnet", "production", "live"])
@pytest.mark.parametrize("campaign", [False, True])
def test_live_connection_alias_reserves_canonical_order_environment(environment, campaign):
    class AliasReader(FakeCredsReader):
        def fetch_rest_credentials_owned(self, user_id, connection_id):
            return {**super().fetch_rest_credentials_owned(user_id, connection_id),
                    "environment": environment}

    client = _client()
    main._CREDS = AliasReader()
    response = _signed_post(client, "/v1/orders", _body(
        **({"campaign_rung_count": 5} if campaign else {}),
    ))
    assert response.status_code == 200, response.text
    rows = list(main._DB.intents.values())
    assert len(rows) == (5 if campaign else 1)
    assert {row["environment"] for row in rows} == {"mainnet"}


def test_connection_environment_mismatch_never_reserves_or_submits():
    class TestnetReader(FakeCredsReader):
        def fetch_rest_credentials_owned(self, user_id, connection_id):
            return {**super().fetch_rest_credentials_owned(user_id, connection_id),
                    "environment": "testnet"}

    client = _client()
    main._CREDS = TestnetReader()
    response = _signed_post(client, "/v1/orders", _body())
    assert response.status_code == 409
    assert response.json()["detail"] == "CONNECTION_ENVIRONMENT_MISMATCH"
    assert main._DB.intents == {}


def test_five_rung_campaign_uses_live_equity_and_submits_five_protected_limits():
    db = FakeDb()
    main._DB = db
    main._CREDS = FakeCredsReader()
    res = _signed_post(TestClient(main.app), "/v1/orders", _body(
        client_order_id="campaign-abc", campaign_rung_count=5,
        campaign_margin_usd=1, campaign_margin_per_rung_usd=0.2,
    ))
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["status"] == "submitted"
    assert payload["campaign_rung_count"] == 5
    assert payload["wallet_equity_at_plan_usd"] == "1000.0"
    assert len(payload["campaign_orders"]) == 5
    assert payload["protections_attached"] is True
    rows = list(db.intents.values())
    assert len(rows) == 5
    assert all(row["state"] == "submitted" for row in rows)
    assert all(row["order_type"] == "LIMIT" for row in rows)


# --- Missing credential ----------------------------------------------------
def test_failed_campaign_does_not_mark_unattempted_rungs_as_venue_orders(monkeypatch):
    from app.execution import PipelineError
    client = _client()
    def failed_campaign(requests, *_a, **_kw):
        raise PipelineError("CAMPAIGN_PARTIAL_FAILURE:PROTECTION_UNCONFIRMED:STOP",
            accepted_orders=((requests[0].client_order_id,"venue-first"),),
            unattempted_client_ids=tuple(r.client_order_id for r in requests[2:]))
    monkeypatch.setattr(main,"create_campaign_pipeline",failed_campaign)
    response=_signed_post(client,"/v1/orders",_body(campaign_rung_count=5))
    assert response.status_code==200
    rows=list(main._DB.intents.values())
    assert [r['state'] for r in rows]==['reconciliation_required']*2+['rejected']*3
    assert rows[0]['exchange_order_id']=='venue-first'
    assert rows[1]['exchange_order_id'] is None
    assert all(r['state_reason']=='CAMPAIGN_NOT_SUBMITTED' for r in rows[2:])


def test_missing_credential_rejects_403():
    main._DB = FakeDb(cred=None)
    main._CREDS = FakeCredsReader()
    res = _signed_post(TestClient(main.app), "/v1/orders", _body())
    assert res.status_code == 403
    assert res.json()["detail"] == "CREDENTIAL_REVOKED_OR_MISSING"


# --- Canary off ------------------------------------------------------------
def test_canary_off_blocks_live_submit(monkeypatch):
    monkeypatch.setattr(main, "_canary_enabled", lambda: False)
    res = _signed_post(_client(), "/v1/orders", _body())
    assert res.status_code == 403
    assert res.json()["detail"] == "CANARY_DISABLED"


def test_internal_owner_canary_restricts_symbol_and_leverage():
    bad_symbol = _signed_post(
        _client(),
        "/v1/orders",
        _body(purpose="internal_owner_canary", symbol="DOGE-USDT", leverage=5),
    )
    assert bad_symbol.status_code == 400
    assert bad_symbol.json()["detail"] == "CANARY_SYMBOL_NOT_ALLOWED"

    bad_leverage = _signed_post(
        _client(),
        "/v1/orders",
        _body(
            purpose="internal_owner_canary",
            client_order_id="coid-canary-lev",
            leverage=6,
        ),
    )
    assert bad_leverage.status_code == 400
    assert bad_leverage.json()["detail"] == "CANARY_LEVERAGE_ABOVE_LIMIT"


def test_internal_owner_canary_enforces_authoritative_mark_notional():
    # BTC's 0.002 size at the fixture's $60k mark builds to $120. The caller
    # cannot hide that behind a smaller browser estimate because the signer
    # checks its own built notional.
    res = _signed_post(
        _client(),
        "/v1/orders",
        _body(
            purpose="internal_owner_canary",
            client_order_id="coid-canary-cap",
            size=0.002,
            leverage=5,
        ),
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "CANARY_NOTIONAL_ABOVE_LIMIT"


def test_internal_owner_canary_keeps_protection_in_live_test_mode(monkeypatch):
    monkeypatch.setattr(apex_omni_rest, "get_mark_price", lambda env, sym: "10000")
    monkeypatch.setattr(main, "entry_without_protections", lambda **_kw: True)
    res = _signed_post(
        _client(),
        "/v1/orders",
        _body(
            purpose="internal_owner_canary",
            client_order_id="coid-canary-stop",
            size=0.001,
            leverage=5,
        ),
    )
    assert res.status_code == 200, res.text
    assert res.json()["protections_attached"] is True


# --- Free collateral: caller cannot inflate size ----------------------------
def test_caller_size_above_available_collateral_is_rejected():
    res = _signed_post(_client(), "/v1/orders", _body(size=100.0))  # absurd
    assert res.status_code == 409
    assert res.json()["detail"] == "INSUFFICIENT_FREE_COLLATERAL"


# --- Replay is refused; only a venue reconciliation can return its outcome ---
def test_idempotent_replay_is_refused():
    c = _client()
    r1 = _signed_post(c, "/v1/orders", _body())
    r2 = _signed_post(c, "/v1/orders", _body())  # different nonce, same coid+fp
    assert r1.status_code == 200 and r2.status_code == 409
    assert r2.json()["detail"] == "INTENT_ALREADY_RESERVED"


def test_database_reservation_blocks_replay_after_signer_restart():
    c = _client()
    first = _signed_post(c, "/v1/orders", _body())
    assert first.status_code == 200
    main._IDEM = type(main._IDEM)()
    second = _signed_post(c, "/v1/orders", _body())
    assert second.status_code == 409
    assert second.json()["detail"] == "INTENT_ALREADY_RESERVED"


# --- Idempotency conflict: same coid, different fingerprint ----------------
def test_idempotency_conflict_when_coid_reused_with_different_body():
    c = _client()
    r1 = _signed_post(c, "/v1/orders", _body())
    assert r1.status_code == 200
    r2 = _signed_post(c, "/v1/orders", _body(side="SELL"))
    assert r2.status_code == 409
    assert r2.json()["detail"] == "IDEMPOTENCY_CONFLICT"


# --- Response never carries seeds / signatures / raw REST bodies -----------
def test_response_never_leaks_secret_material():
    res = _signed_post(_client(), "/v1/orders", _body())
    blob = res.text
    for leak in ("SIG", "seeds", "encrypted_credentials", "api_key", "api_secret"):
        assert leak not in blob, f"response leaked {leak}"


def test_minimal_order_does_not_require_user_stark_context(monkeypatch):
    captured = {}

    def _capture_ctx(env, k, s, p, **kw):
        captured.update(kw)
        raise apex_omni_rest.RestError("STARK_CONTEXT_MISSING")

    monkeypatch.setattr(apex_omni_rest, "get_user_stark_context", _capture_ctx)

    res = _signed_post(_client(), "/v1/orders", _body(client_order_id="coid-no-cache"))

    assert res.status_code == 200, res.text
    assert captured == {}


def test_order_decrypt_aad_comes_from_canonical_credential_row(monkeypatch):
    captured = {}

    def _capture_decrypt(_pkg, ctx):
        captured["ctx"] = ctx
        return {"seeds": "ff" * 32}

    lower_cred = dict(CRED, wallet_address=CRED["wallet_address"].lower(), environment="production")
    main._DB = FakeDb(cred=lower_cred)
    main._CREDS = FakeCredsReader()
    monkeypatch.setattr(main, "decrypt_bundle", _capture_decrypt)

    res = _signed_post(TestClient(main.app), "/v1/orders", _body(environment="mainnet"))

    assert res.status_code == 200, res.text
    assert captured["ctx"].user_id == lower_cred["user_id"]
    assert captured["ctx"].environment == "mainnet"
    assert lower_cred["environment"] == "production"  # original row stays untouched
    assert captured["ctx"].wallet_address == CRED["wallet_address"]


def test_decrypt_selftest_returns_sanitized_diagnostic():
    packed, version = encrypt_bundle({"seeds": "ff" * 32}, EnvelopeContext.from_row(CRED))
    main._DB = FakeDb(cred=dict(CRED, encrypted_credentials=packed, encryption_key_version=version))

    res = _signed_post(TestClient(main.app), "/v1/decrypt-selftest", {
        "user_id": "u1",
        "exchange_connection_id": "conn-1",
        "environment": "mainnet",
    })

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "ok"
    assert body["credential"]["wallet_address"] == CRED["wallet_address"]
    diag = body["diagnostic"]
    assert diag["ok"] is True
    assert diag["key_version"] == 1
    assert diag["aad_components"] == {
        "user_id": "u1",
        "wallet_address": CRED["wallet_address"],
        "environment": "mainnet",
    }
    assert diag["envelope_shape"]["dek_iv_decoded_len"] == 12
    assert diag["envelope_shape"]["body_iv_decoded_len"] == 12
    blob = res.text
    assert "seeds" not in blob
    assert "ff" * 32 not in blob
