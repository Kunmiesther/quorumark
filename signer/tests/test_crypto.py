"""Envelope-encryption tests for the ApeX signing-material store."""
from __future__ import annotations

import base64
import os

import pytest

from app.crypto import EnvelopeContext, decrypt_bundle, decrypt_selftest, encrypt_bundle


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APEX_MASTER_WRAPPING_KEY_ACTIVE", "1")
    monkeypatch.setenv(
        "APEX_MASTER_WRAPPING_KEY_V1",
        base64.b64encode(os.urandom(32)).decode(),
    )


CTX = EnvelopeContext(
    user_id="00000000-0000-0000-0000-000000000001",
    wallet_address="0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    environment="mainnet",
)
BUNDLE = {"apiKey": "k", "apiSecret": "s", "passphrase": "p", "zk_seed": "deadbeef" * 8}


def test_roundtrip_preserves_bundle():
    ct, version = encrypt_bundle(BUNDLE, CTX)
    assert version == 1
    assert decrypt_bundle(ct, CTX) == BUNDLE


def test_ciphertext_tampering_is_rejected():
    ct, _ = encrypt_bundle(BUNDLE, CTX)
    # Flip a byte in the base64-encoded envelope.
    raw = bytearray(base64.b64decode(ct))
    raw[100] ^= 0x01
    tampered = base64.b64encode(bytes(raw)).decode()
    with pytest.raises(Exception):
        decrypt_bundle(tampered, CTX)


def test_wrong_user_context_is_rejected():
    ct, _ = encrypt_bundle(BUNDLE, CTX)
    other = EnvelopeContext(user_id="ffffffff-ffff-ffff-ffff-ffffffffffff",
                            wallet_address=CTX.wallet_address, environment=CTX.environment)
    with pytest.raises(Exception):
        decrypt_bundle(ct, other)


def test_wrong_wallet_context_is_rejected():
    ct, _ = encrypt_bundle(BUNDLE, CTX)
    other = EnvelopeContext(user_id=CTX.user_id,
                            wallet_address="0x0000000000000000000000000000000000000000",
                            environment=CTX.environment)
    with pytest.raises(Exception):
        decrypt_bundle(ct, other)


def test_wrong_environment_context_is_rejected():
    ct, _ = encrypt_bundle(BUNDLE, CTX)
    other = EnvelopeContext(user_id=CTX.user_id,
                            wallet_address=CTX.wallet_address, environment="testnet")
    with pytest.raises(Exception):
        decrypt_bundle(ct, other)


def test_ciphertext_is_opaque_bytes():
    ct, _ = encrypt_bundle(BUNDLE, CTX)
    # No plaintext leakage — check no key/secret substring appears in the packed value.
    for needle in ("apiKey", "apiSecret", "passphrase", "deadbeef"):
        assert needle not in ct


def test_aad_canonicalizes_wallet_case_and_environment_aliases():
    lower_wallet_ctx = EnvelopeContext(
        user_id=CTX.user_id,
        wallet_address=CTX.wallet_address.lower(),
        environment="mainnet",
    )
    ct, _ = encrypt_bundle(BUNDLE, lower_wallet_ctx)

    production_row_ctx = EnvelopeContext.from_row({
        "user_id": CTX.user_id,
        "wallet_address": CTX.wallet_address,
        "environment": "production",
    })

    assert decrypt_bundle(ct, production_row_ctx) == BUNDLE
    assert production_row_ctx.environment == "mainnet"
    assert production_row_ctx.wallet_address == CTX.wallet_address


def test_legacy_lowercase_aad_decrypts_from_checksum_row():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import json

    version = 1
    wrap = AESGCM(base64.b64decode(os.environ["APEX_MASTER_WRAPPING_KEY_V1"]))
    dek = AESGCM.generate_key(bit_length=256)
    body = AESGCM(dek)
    body_iv = os.urandom(12)
    dek_iv = os.urandom(12)
    legacy_aad = f"{CTX.user_id}|{CTX.wallet_address.lower()}|mainnet".encode()
    packed = {
        "v": 1,
        "kv": version,
        "dek_iv": base64.b64encode(dek_iv).decode(),
        "dek_ct": base64.b64encode(wrap.encrypt(dek_iv, dek, legacy_aad)).decode(),
        "body_iv": base64.b64encode(body_iv).decode(),
        "body_ct": base64.b64encode(body.encrypt(body_iv, json.dumps(BUNDLE, sort_keys=True).encode(), legacy_aad)).decode(),
    }
    ct = base64.b64encode(json.dumps(packed).encode()).decode()

    assert decrypt_bundle(ct, EnvelopeContext.from_row({
        "user_id": CTX.user_id,
        "wallet_address": CTX.wallet_address,
        "environment": "mainnet",
    })) == BUNDLE


def test_decrypt_selftest_reports_key_mismatch_without_plaintext(monkeypatch):
    ct, _ = encrypt_bundle(BUNDLE, CTX)

    # Same key version, different deployed key bytes: the exact production
    # failure mode the endpoint must distinguish from AAD drift.
    monkeypatch.setenv(
        "APEX_MASTER_WRAPPING_KEY_V1",
        base64.b64encode(os.urandom(32)).decode(),
    )

    diag = decrypt_selftest(ct, CTX)

    assert diag["ok"] is False
    assert diag["key_version"] == 1
    assert diag["active_key_version"] == 1
    assert isinstance(diag["wrapping_key_fingerprint_prefix"], str)
    assert diag["failure_stage"] == "dek_unwrap"
    assert diag["exception_type"] in {"InvalidTag", "ValueError"}
    assert diag["aad_components"] == CTX.diagnostic_components()
    assert diag["envelope_shape"]["dek_iv_decoded_len"] == 12
    assert diag["envelope_shape"]["body_iv_decoded_len"] == 12
    blob = str(diag)
    assert "deadbeef" not in blob
    assert "apiSecret" not in blob
