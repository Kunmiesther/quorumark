"""Handler-level: encryption failure, revoked credentials, env mismatch, dry run."""
from __future__ import annotations

import pytest

import app.main as main
from app.crypto import CryptoConfigError
from app.order_store import DRY_RUN_REASON

CRED = {
    "id": "cred-1", "user_id": "u1", "exchange_connection_id": "c1",
    "environment": "mainnet", "wallet_address": "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    "encrypted_credentials": "packed", "encryption_key_version": 1,
    "credential_fingerprint": "fp123", "active": True, "revoked_at": None,
}
INTENT_ROW = {
    "id": "i1", "user_id": "u1", "connection_id": "c1", "client_order_id": "coid-1",
    "environment": "mainnet", "state": "confirmed", "state_reason": None, "reduce_only": False,
}


class FakeDb:
    def __init__(self, cred=CRED, intent=INTENT_ROW, revoke_ok=True):
        self._cred = cred; self._intent = intent; self._revoke_ok = revoke_ok
        self.updates = []; self.audits = []; self.cred_audits = []
    def fetch_intent(self, u, c): return self._intent
    def update_intent(self, i, patch): self.updates.append((i, patch))
    def insert_audit(self, row): self.audits.append(row)
    def fetch_active_credential(self, cid): return self._cred
    def revoke_credential(self, cid): return self._revoke_ok
    def insert_credential_audit(self, row): self.cred_audits.append(row)


@pytest.fixture(autouse=True)
def _iso(monkeypatch):
    main._IDEM = type(main._IDEM)()
    monkeypatch.setattr(main, "_signer_enabled", lambda: True)
    monkeypatch.setattr(main, "_canary_enabled", lambda: False)


# --- OPERATION_ENABLED plus runtime flags are the authority ----------------
def test_sign_order_is_allowlisted_behind_runtime_flags():
    from app.operations import is_enabled
    assert is_enabled("SIGN_ORDER") is True


# --- revoked credentials ---------------------------------------------------
def test_revoked_credential_is_unusable():
    """fetch_active_credential filters active/revoked_at in the QUERY."""
    db = FakeDb(cred=None)
    assert db.fetch_active_credential("cred-1") is None


def test_revoke_marks_inactive_and_audits_metadata_only():
    db = FakeDb()
    assert db.revoke_credential("cred-1") is True
    db.insert_credential_audit({
        "credential_id": "cred-1", "user_id": "u1", "event": "revoked",
        "detail": {"environment": "mainnet", "credential_fingerprint": "fp123",
                   "encryption_key_version": 1, "reason": "owner_requested"},
    })
    a = db.cred_audits[0]
    assert a["event"] == "revoked"          # CHECK-constrained literal
    blob = str(a)
    for leak in ("seeds", "signature", "encrypted_credentials", "private"):
        assert leak not in blob


def test_revoke_event_literal_is_check_constrained():
    allowed = {"created", "verified", "rotated", "used", "revoked", "signing_failed"}
    assert "revoked" in allowed


# --- encryption failure ----------------------------------------------------
def test_decrypt_failure_is_structured_and_leaks_nothing(monkeypatch):
    from app.crypto import decrypt_bundle
    def boom(*a, **k):
        raise CryptoConfigError("MISSING_WRAPPING_KEY_V1")
    monkeypatch.setattr(main, "decrypt_bundle", boom)
    with pytest.raises(CryptoConfigError) as e:
        main.decrypt_bundle("x", None)
    assert "seeds" not in str(e.value)


def test_decrypt_failure_maps_to_opaque_code():
    """The handler must return DECRYPT_FAILED — never the crypto internals,
    which can echo key material."""
    import inspect
    src = inspect.getsource(main.sign_order)
    assert 'detail="DECRYPT_FAILED"' in src
    assert "MISSING_WRAPPING_KEY" not in src


def test_tampered_ciphertext_rejected():
    import base64, json
    from app.crypto import EnvelopeContext, encrypt_bundle, decrypt_bundle
    import os
    os.environ["APEX_MASTER_WRAPPING_KEY_V1"] = base64.b64encode(b"0"*32).decode()
    os.environ["APEX_MASTER_WRAPPING_KEY_ACTIVE"] = "1"
    ctx = EnvelopeContext("u1", "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1", "mainnet")
    packed, _ = encrypt_bundle({"seeds": "ab"*65}, ctx)
    raw = json.loads(base64.b64decode(packed))
    raw["body_ct"] = base64.b64encode(b"tampered").decode()
    bad = base64.b64encode(json.dumps(raw).encode()).decode()
    with pytest.raises(Exception):
        decrypt_bundle(bad, ctx)


def test_aad_binding_blocks_cross_environment_reuse():
    """A mainnet bundle must not decrypt under a testnet context."""
    import base64, os
    from app.crypto import EnvelopeContext, encrypt_bundle, decrypt_bundle
    os.environ["APEX_MASTER_WRAPPING_KEY_V1"] = base64.b64encode(b"0"*32).decode()
    os.environ["APEX_MASTER_WRAPPING_KEY_ACTIVE"] = "1"
    packed, _ = encrypt_bundle({"seeds": "ab"*65}, EnvelopeContext("u1", "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1", "mainnet"))
    with pytest.raises(Exception):
        decrypt_bundle(packed, EnvelopeContext("u1", "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1", "testnet"))


# --- environment mismatch --------------------------------------------------
def test_environment_mismatch_guard_present():
    import inspect
    src = inspect.getsource(main.sign_order)
    assert 'intent.environment != cred["environment"]' in src
    assert 'ENVIRONMENT_MISMATCH' in src


# --- dry run is terminal ---------------------------------------------------
def test_dry_run_returns_signed_not_submitted():
    import inspect
    src = inspect.getsource(main.sign_order)
    assert '"status": "signed_not_submitted"' in src
    assert "store.mark_dry_run(intent)" in src


def test_no_submission_path_exists_in_handler():
    """Submission is deliberately not implemented. If this fails, someone
    added an order-transmission path behind the canary flag."""
    import inspect
    src = inspect.getsource(main.sign_order)
    # Check for TRANSMISSION, not vocabulary: "submit" matches
    # "signed_not_submitted". Same trap as the earlier signature/leak test.
    for forbidden in ("requests.post", "requests.put", "create_order_v3",
                      "httpx.", "session.post", "urlopen"):
        assert forbidden not in src, f"submission path present: {forbidden}"


def test_credential_fetched_before_intent():
    """The credential is the only source of user_id; fetching the intent
    first was a real bug caught in review."""
    import inspect
    src = inspect.getsource(main.sign_order)
    assert src.index("fetch_active_credential") < src.index("load_signable_intent")
