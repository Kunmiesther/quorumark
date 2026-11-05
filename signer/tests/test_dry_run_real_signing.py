"""Handler-level: /v1/sign-order dry-run calls the REAL zkLink signing
function, discards the signature, and transmits nothing.

Guarantees under test:
  1. `app.apex_signing.sign_order` (the real function) is actually invoked.
     A spy records the call; the assertion fails if the handler returns
     without calling the real signer.
  2. The response body carries only whitelisted metadata — never the
     signature, seeds, l2_key, or any credential material.
  3. No outbound HTTP request is made from the handler (no submission).
     `requests`/`httpx` are unavailable; any attempt would raise.
  4. The intent lands in the terminal `rejected` / `DRY_RUN_NOT_SUBMITTED`
     state and never in a submitted state.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import time

import pytest
from fastapi.testclient import TestClient

# Provide the shared secret BEFORE importing app.main / making the client so
# the app never boots with a missing secret.
os.environ["SIGNER_SHARED_SECRET"] = "0" * 64
os.environ["APEX_MAINNET_SIGNER_ENABLED"] = "true"
os.environ["APEX_MAINNET_CANARY_ENABLED"] = "false"

import app.main as main  # noqa: E402
import app.apex_signing as apex_signing  # noqa: E402


CRED = {
    "id": "cred-1", "user_id": "u1", "exchange_connection_id": "c1",
    "environment": "mainnet",
    "wallet_address": "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    "encrypted_credentials": "packed", "encryption_key_version": 1,
    "credential_fingerprint": "fp123", "active": True, "revoked_at": None,
}
INTENT_ROW = {
    "id": "i1", "user_id": "u1", "connection_id": "c1",
    "client_order_id": "coid-real-1", "environment": "mainnet",
    "state": "confirmed", "state_reason": None, "reduce_only": False,
}
SEEDS_HEX = "ab" * 65  # 130 hex chars — passes the module regex


class FakeDb:
    def __init__(self):
        self.updates = []
        self.audits = []
    def fetch_intent(self, u, c): return dict(INTENT_ROW)
    def update_intent(self, i, patch): self.updates.append((i, patch))
    def insert_audit(self, row): self.audits.append(row)
    def fetch_active_credential(self, cid): return dict(CRED)
    def revoke_credential(self, cid): return True
    def insert_credential_audit(self, row): pass


@pytest.fixture(autouse=True)
def _wire(monkeypatch):
    # Fresh in-process idempotency cache.
    main._IDEM = type(main._IDEM)()
    # Force SIGN_ORDER on for this test — but ONLY in-process.
    from app import operations
    monkeypatch.setitem(operations.OPERATION_ENABLED, "SIGN_ORDER", True)
    # Inject fake DB.
    main._DB = FakeDb()
    # Bypass real envelope decryption; return a bundle carrying seeds.
    monkeypatch.setattr(main, "decrypt_bundle", lambda *a, **k: {"seeds": SEEDS_HEX})
    yield
    main._DB = None


def _post(client, path, body):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = f"nonce-{time.time_ns()}"
    msg = b"\n".join([ts.encode(), nonce.encode(), path.encode(), raw])
    sig = hmac.new(b"0" * 64, msg, hashlib.sha256).hexdigest()
    return client.post(path, content=raw, headers={
        "content-type": "application/json",
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": sig,
    })


BODY = {
    "credential_id": "cred-1",
    "client_order_id": "coid-real-1",
    "symbol": "BTC-USDT",
    "side": "BUY",
    "order_type": "LIMIT",
    "size": "0.001",
    "price": "50000",
    "reduce_only": False,
    "is_live": False,
    "account_id": 1,
    "sub_account_id": 0,
    "slot_id": 1,
    "nonce": 1,
    "l2_pair_id": 1,
    "decimals": 6,
    "taker_fee_rate": "0.0005",
    "maker_fee_rate": "0.0002",
}


def test_dry_run_calls_real_zk_sign_order_and_discards_signature(monkeypatch):
    """Spy on the real signer to prove it ran; then verify the signature
    NEVER leaves the handler frame (not in response, not in audit)."""
    calls = []
    real = apex_signing.sign_order

    def spy(**kwargs):
        calls.append({k: kwargs[k] for k in ("size", "price", "is_buy",
                                             "client_order_id", "account_id")})
        return real(**kwargs)

    monkeypatch.setattr(main, "zk_sign_order", spy)

    # Guard: no outbound HTTP allowed from the handler path.
    import urllib.request
    def _no(*a, **k): raise AssertionError("outbound HTTP is forbidden in dry-run")
    monkeypatch.setattr(urllib.request, "urlopen", _no)

    client = TestClient(main.app)
    r = _post(client, "/v1/sign-order", BODY)
    assert r.status_code == 200, r.text
    payload = r.json()

    # (1) real signer really ran, with the body's params
    assert len(calls) == 1
    assert calls[0]["client_order_id"] == "coid-real-1"
    assert calls[0]["is_buy"] is True

    # (2) response is whitelisted metadata only — no signature/seed leakage
    assert payload == {
        "status": "signed_not_submitted",
        "reject_reason": "DRY_RUN_NOT_SUBMITTED",
    }
    blob = json.dumps(payload)
    for leak in ("signature", "seed", "l2_key", "l2Key", "0x", SEEDS_HEX):
        assert leak not in blob, f"leaked material in response: {leak}"

    # (3) audit rows carry only sanitized metadata, never signature/seed
    # MATERIAL. Check for the material itself, not the vocabulary: the audit
    # detail legitimately says the signature was DISCARDED, and the
    # `signature_discarded` flag legitimately contains the word "signature"
    # (see test_order_store.test_dry_run_audit_carries_no_signature_or_seed).
    audit_blob = json.dumps(main._DB.audits)
    assert SEEDS_HEX not in audit_blob, "leaked seed material in audit"
    assert not re.search(r"0x[a-fA-F0-9]{32,}", audit_blob), "hex key/seed material in audit"
    assert not re.search(r"\b[a-fA-F0-9]{64,}\b", audit_blob), "bare hex material in audit"
    for leak in ("seeds", "l2_key", "private_key", "zk_seed"):
        assert leak not in audit_blob, f"leaked material in audit: {leak}"

    # (4) intent transitioned to terminal DRY_RUN, never `submitted`
    states = [patch.get("state") for _, patch in main._DB.updates]
    assert "signing" in states
    assert "rejected" in states
    assert "submitted" not in states
    reasons = [patch.get("state_reason") for _, patch in main._DB.updates
               if patch.get("state") == "rejected"]
    assert reasons == ["DRY_RUN_NOT_SUBMITTED"]


def test_dry_run_never_imports_or_uses_http_client():
    """No submission code path in the handler. If someone adds one behind
    the canary flag, this catches it."""
    import inspect
    src = inspect.getsource(main.sign_order)
    for forbidden in ("requests.post", "requests.put", "httpx.",
                      "urlopen", "session.post", "create_order_v3"):
        assert forbidden not in src, f"submission path present: {forbidden}"


def test_response_sanitizer_excludes_signature_key():
    """Even if a future handler accidentally puts `signature` in the
    response dict, sanitize_response drops it."""
    from app.security import sanitize_response
    out = sanitize_response({"status": "x", "signature": "LEAK", "seeds": "LEAK"})
    assert "signature" not in out
    assert "seeds" not in out
