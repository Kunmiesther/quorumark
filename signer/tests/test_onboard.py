"""End-to-end onboarding handler tests.

Covers happy path, environment mismatch, invalid signature, signer-disabled,
idempotent re-onboard, and the invariant that no derived secrets ever leak
into the response.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main


FIX = json.loads((Path(__file__).parent / "fixtures" / "onboarding_fixture.json").read_text())
CASE = FIX["cases"]["mainnet_checksummed"]
WALLET = CASE["address_input"]
SIGNATURE = CASE["signature_hex"]
ZK_SEED = CASE["zk_seed_hex"]
ZK_L2 = CASE["zk_l2_public_key"]


def _jwt_for(sub="user-42"):
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": sub, "iss": "test"}).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.sig"


class FakeDb:
    def __init__(self, existing=None):
        self.inserted = []
        self.audits = []
        self.revoked = []
        self._existing = existing
        self._next_id = "cred-new-1"

    def find_active_credential_for_scope(self, **kw):
        return self._existing

    def revoke_credential(self, cid):
        self.revoked.append(cid)
        self._existing = None
        return True

    def insert_credential(self, row):
        self.inserted.append(row)
        return {"id": self._next_id, **row}

    def insert_credential_audit(self, row):
        self.audits.append(row)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    # Fresh wrapping key + enable flag for every test.
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_V1", base64.b64encode(b"x" * 32).decode())
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_ACTIVE", "1")
    monkeypatch.setenv("SIGNER_SHARED_SECRET", "test-shared-secret")
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)

    # The apexomni stub raises on real use; substitute a deterministic zk
    # derivation that behaves like the SDK for signature-recovered flows.
    # (Real SDK behavior is proven separately in tests/test_apex_signing.py.)
    from app import apex_signing

    def _fake_derive(sig):
        if not isinstance(sig, str) or not apex_signing._SIG_RE.match(sig):
            raise apex_signing.SigningError("BAD_SIGNATURE_FORMAT")
        seed = sig.removeprefix("0x")
        return apex_signing.ZkCredentials(
            seeds=seed,
            l2_key="0x" + "a" * 64,
            pub_key_hash="0x" + "b" * 40,
        )
    monkeypatch.setattr(main, "derive_zk_credentials", _fake_derive)
    yield



def _signed_post(client, path, body):
    import hashlib
    import hmac
    import time
    import uuid

    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = uuid.uuid4().hex
    sig = hmac.new(
        b"test-shared-secret",
        b"\n".join([ts.encode(), nonce.encode(), path.encode(), raw]),
        hashlib.sha256,
    ).hexdigest()
    return client.post(
        path, content=raw,
        headers={
            "content-type": "application/json",
            "x-signer-timestamp": ts,
            "x-signer-nonce": nonce,
            "x-signer-signature": sig,
        },
    )


def _body(**overrides):
    b = {
        "user_id": "user-42",
        "exchange_connection_id": "conn-1",
        "wallet_address": WALLET,
        "environment": "mainnet",
        "signature": SIGNATURE,
        "caller_jwt": _jwt_for("user-42"),
    }
    b.update(overrides)
    return b


def _client(db):
    main._DB = db
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------
def test_onboard_happy_path_persists_and_returns_only_sanitized_metadata():
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body())
    assert res.status_code == 200, res.text
    body = res.json()

    # Response is sanitized: metadata only, never secrets.
    assert body["status"] == "onboarded"
    assert body["credential_id"] == "cred-new-1"
    assert body["environment"] == "mainnet"
    fp = body["credential_fingerprint"]
    assert isinstance(fp, str) and len(fp) == 32
    for leak_key in ("seeds", "signature", "encrypted_credentials", "l2_key", "pub_key_hash"):
        assert leak_key not in body
    blob = json.dumps(body)
    for leak in (ZK_SEED, ZK_L2, SIGNATURE.removeprefix("0x")):
        assert leak.lower() not in blob.lower()

    # DB got the encrypted bundle plus metadata, no plaintext seed.
    assert len(db.inserted) == 1
    row = db.inserted[0]
    assert row["user_id"] == "user-42"
    assert row["exchange_connection_id"] == "conn-1"
    assert row["environment"] == "mainnet"
    assert row["wallet_address"] == WALLET
    assert row["credential_fingerprint"] == fp
    assert row["encryption_key_version"] == 1
    assert row["active"] is True
    packed = row["encrypted_credentials"]
    assert ZK_SEED not in packed and SIGNATURE.removeprefix("0x") not in packed

    # Audit row is `created` with metadata only.
    created = [a for a in db.audits if a["event"] == "created"]
    assert len(created) == 1
    assert created[0]["credential_id"] == "cred-new-1"
    detail = created[0]["detail"]
    assert detail["encryption_key_version"] == 1
    assert detail["credential_fingerprint"] == fp
    assert "seeds" not in detail


# ---------------------------------------------------------------------------
# environment mismatch (testnet signature vs mainnet header)
# ---------------------------------------------------------------------------
def test_onboard_rejects_env_mismatched_signature():
    db = FakeDb()
    testnet_sig = FIX["cases"]["testnet_checksummed"]["signature_hex"]
    res = _signed_post(_client(db), "/v1/onboard", _body(signature=testnet_sig))
    assert res.status_code == 400
    assert res.json()["detail"].startswith("SIGNATURE_ADDRESS_MISMATCH")
    assert db.inserted == []


# ---------------------------------------------------------------------------
# invalid signature
# ---------------------------------------------------------------------------
def test_onboard_rejects_invalid_signature_bytes():
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body(signature="0x" + "00" * 65))
    # eth_account may either fail to recover, or recover a different addr.
    assert res.status_code == 400
    assert res.json()["detail"] in {"INVALID_SIGNATURE", "SIGNATURE_ADDRESS_MISMATCH"}
    assert db.inserted == []


def test_onboard_rejects_malformed_signature_shape():
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body(signature="not-a-sig"))
    assert res.status_code == 400
    assert db.inserted == []


# ---------------------------------------------------------------------------
# signer disabled
# ---------------------------------------------------------------------------
def test_onboard_refused_when_signer_disabled(monkeypatch):
    monkeypatch.setattr(main, "_signer_enabled", lambda: False)
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body())
    assert res.status_code == 403
    assert res.json()["detail"] == "SIGNER_DISABLED"
    assert db.inserted == []


# ---------------------------------------------------------------------------
# idempotent re-onboard: revoke-and-replace
# ---------------------------------------------------------------------------
def test_reonboard_revokes_existing_and_inserts_new():
    existing = {
        "id": "cred-old", "user_id": "user-42",
        "environment": "mainnet", "wallet_address": WALLET,
        "credential_fingerprint": "OLDFPRINT", "encryption_key_version": 1,
    }
    db = FakeDb(existing=existing)
    res = _signed_post(_client(db), "/v1/onboard", _body())
    assert res.status_code == 200
    assert db.revoked == ["cred-old"]
    assert len(db.inserted) == 1
    events = [a["event"] for a in db.audits]
    assert "revoked" in events and "created" in events


def test_onboard_persists_checksum_wallet_for_aad_consistency():
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body(wallet_address=WALLET.lower()))
    assert res.status_code == 200, res.text
    assert db.inserted[0]["wallet_address"] == WALLET


def test_501_is_gone():
    """The scaffold's `SDK_PIN_REQUIRED` refusal must no longer be reachable."""
    db = FakeDb()
    res = _signed_post(_client(db), "/v1/onboard", _body())
    assert res.status_code != 501
    assert "SDK_PIN_REQUIRED" not in res.text


# ---------------------------------------------------------------------------
# regression: worker-ingest backend memoized on _DB by /v1/orders must NOT
# poison /v1/onboard. _caller_db must ignore production backends and build
# a real caller-scoped client (mocked here).
# ---------------------------------------------------------------------------
def test_onboard_ignores_worker_ingest_backend_memoized_on_DB(monkeypatch):
    from app import db as db_mod

    # Simulate /v1/orders having populated _DB with the production backend.
    class _Wic:
        def __init__(self): pass
    main._DB = db_mod.WorkerIngestBackedDbClient(client=_Wic())

    caller_fake = FakeDb()

    def _fake_caller(caller_jwt):
        return caller_fake

    # _caller_db should short-circuit to a real caller-scoped client, NOT
    # return the worker-ingest instance. We stub the constructor to observe.
    import app.db_caller as dbc
    monkeypatch.setattr(dbc, "CallerScopedDbClient", lambda caller_jwt: caller_fake)

    import base64, json as _json
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        _json.dumps({"sub": "user-42", "iss": "test"}).encode()
    ).rstrip(b"=").decode()
    jwt = f"{header}.{payload}.sig"
    res = _signed_post(TestClient(main.app), "/v1/onboard", _body(caller_jwt=jwt))
    assert res.status_code == 200, res.text
    assert len(caller_fake.inserted) == 1
    main._DB = None

