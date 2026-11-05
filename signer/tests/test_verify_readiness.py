"""Tests for signer/scripts/verify_readiness.py.

These tests never spawn a real HTTP server; they patch
`urllib.request.urlopen` (or the module-level helpers) to feed canned
responses. The goal is to prove:
  * preconditions block execution when any write op is enabled or when
    a mainnet env flag is on;
  * HMAC headers are generated per `app.security` scheme;
  * the printed payload contains only allowlisted fields;
  * exit codes are correct.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest import mock

import pytest

from scripts import verify_readiness as vr


VALID_USER = "11111111-1111-1111-1111-111111111111"
VALID_CONN = "22222222-2222-2222-2222-222222222222"
SECRET = b"unit-test-secret"


def _fake_env(**overrides):
    env = {"SIGNER_SHARED_SECRET": SECRET.decode()}
    env.update(overrides)
    return env


def _all_ops_off():
    ops = mock.MagicMock()
    ops.OPERATION_ENABLED = {name: False for name in vr._WRITE_OPS}
    ops.OPERATION_ENABLED.update(
        {"VERIFY_CREDENTIALS": True, "READ_ACCOUNT": True}
    )
    return ops


# ---- precondition tests ----------------------------------------------------


def test_write_operation_enabled_refuses(monkeypatch):
    ops = _all_ops_off()
    ops.OPERATION_ENABLED["SIGN_ORDER"] = True
    monkeypatch.setattr(vr, "_load_operations_module", lambda: ops)
    with pytest.raises(vr.PreconditionError) as exc:
        vr.run_verification(VALID_USER, VALID_CONN, env=_fake_env())
    assert exc.value.code == "WRITE_OPERATION_ENABLED"


def test_mainnet_signer_flag_refuses(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    with pytest.raises(vr.PreconditionError) as exc:
        vr.run_verification(
            VALID_USER, VALID_CONN,
            env=_fake_env(APEX_MAINNET_SIGNER_ENABLED="true"),
        )
    assert exc.value.code == "MAINNET_FLAG_ENABLED"


def test_mainnet_canary_flag_refuses(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    with pytest.raises(vr.PreconditionError) as exc:
        vr.run_verification(
            VALID_USER, VALID_CONN,
            env=_fake_env(APEX_MAINNET_CANARY_ENABLED="TRUE"),
        )
    assert exc.value.code == "MAINNET_FLAG_ENABLED"


def test_missing_secret_refuses(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    with pytest.raises(vr.PreconditionError) as exc:
        vr.run_verification(VALID_USER, VALID_CONN, env={})
    assert exc.value.code == "MISSING_SIGNER_SHARED_SECRET"


def test_bad_uuid_refuses(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    with pytest.raises(vr.PreconditionError) as exc:
        vr.run_verification("not-a-uuid", VALID_CONN, env=_fake_env())
    assert exc.value.code == "BAD_USER_ID"


# ---- HMAC + sanitization ---------------------------------------------------


def test_sign_headers_matches_security_scheme():
    body = b'{"a":1}'
    headers = vr._sign_headers("/v1/x", body, SECRET, now=1_700_000_000)
    ts = headers["x-signer-timestamp"]
    nonce = headers["x-signer-nonce"]
    msg = b"\n".join([ts.encode(), nonce.encode(), b"/v1/x", body])
    expected = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()
    assert headers["x-signer-signature"] == expected


def test_sanitize_drops_unknown_and_secret_looking_keys():
    payload = {
        "status": "ok",
        "connection_id": VALID_CONN,
        "api_key": "SHOULD_BE_DROPPED",
        "api_secret": "SHOULD_BE_DROPPED",
        "signature": "0xdeadbeef",
        "encrypted_credentials": {"seed": "x"},
        "account": {
            "equity": "500.0",
            "available_balance": "500.0",
            "private_key": "LEAK",
        },
    }
    cleaned = vr._sanitize(payload)
    assert "api_key" not in cleaned
    assert "api_secret" not in cleaned
    assert "signature" not in cleaned
    assert "encrypted_credentials" not in cleaned
    assert "private_key" not in cleaned["account"]
    assert cleaned["account"]["equity"] == "500.0"


# ---- end-to-end orchestration ---------------------------------------------


def _mock_http(seq):
    """Return a fake `_http_call` iterating through (status, body) tuples."""
    it = iter(seq)

    def fake(method, url, headers, body=None):
        return next(it)

    return fake


def test_run_verification_happy_path(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    seq = [
        (200, {"ok": True}),
        (200, {
            "status": "verified", "verified": True,
            "connection_id": VALID_CONN, "environment": "mainnet",
            "exchange": "apex_omni",
            "api_key": "LEAK",  # must be stripped
        }),
        (200, {
            "status": "ok",
            "connection_id": VALID_CONN, "environment": "mainnet",
            "exchange": "apex_omni",
            "account": {"equity": "500.0", "available_balance": "500.0"},
        }),
    ]
    monkeypatch.setattr(vr, "_http_call", _mock_http(seq))
    result = vr.run_verification(VALID_USER, VALID_CONN, env=_fake_env())
    assert result["overall"] == "ready"
    assert result["verify_credentials"]["verified"] is True
    assert "api_key" not in result["verify_credentials"]
    assert result["read_account"]["account"]["equity"] == "500.0"


def test_run_verification_unverified_skips_read(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    seq = [
        (200, {"ok": True}),
        (200, {"status": "unverified", "verified": False,
                "reject_reason": "UPSTREAM_ERROR"}),
    ]
    monkeypatch.setattr(vr, "_http_call", _mock_http(seq))
    result = vr.run_verification(VALID_USER, VALID_CONN, env=_fake_env())
    assert result["overall"] == "unverified"
    assert result["read_account"]["status"] == "skipped"


def test_healthz_failure_raises(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    monkeypatch.setattr(vr, "_http_call", _mock_http([(500, {})]))
    with pytest.raises(vr.SignerCallError) as exc:
        vr.run_verification(VALID_USER, VALID_CONN, env=_fake_env())
    assert exc.value.code == "HEALTHZ_FAILED"


# ---- CLI entry point ------------------------------------------------------


def test_main_returns_1_on_precondition(monkeypatch, capsys):
    ops = _all_ops_off()
    ops.OPERATION_ENABLED["CREATE_ORDER"] = True
    monkeypatch.setattr(vr, "_load_operations_module", lambda: ops)
    monkeypatch.setattr(vr.os, "environ", _fake_env())
    rc = vr.main(["--user-id", VALID_USER, "--connection-id", VALID_CONN])
    assert rc == 1
    err = capsys.readouterr().err
    assert "WRITE_OPERATION_ENABLED" in err


def test_main_returns_0_on_ready(monkeypatch, capsys):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    monkeypatch.setattr(vr.os, "environ", _fake_env())
    seq = [
        (200, {"ok": True}),
        (200, {"status": "verified", "verified": True,
                "connection_id": VALID_CONN, "environment": "mainnet",
                "exchange": "apex_omni"}),
        (200, {"status": "ok", "connection_id": VALID_CONN,
                "environment": "mainnet", "exchange": "apex_omni",
                "account": {"equity": "500.0"}}),
    ]
    monkeypatch.setattr(vr, "_http_call", _mock_http(seq))
    rc = vr.main(["--user-id", VALID_USER, "--connection-id", VALID_CONN])
    assert rc == 0
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["overall"] == "ready"


def test_main_returns_2_on_signer_error(monkeypatch, capsys):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    monkeypatch.setattr(vr.os, "environ", _fake_env())
    monkeypatch.setattr(vr, "_http_call", _mock_http([(500, {})]))
    rc = vr.main(["--user-id", VALID_USER, "--connection-id", VALID_CONN])
    assert rc == 2
    err = capsys.readouterr().err
    assert "HEALTHZ_FAILED" in err


def test_main_rejects_unknown_args(monkeypatch):
    monkeypatch.setattr(vr, "_load_operations_module", _all_ops_off)
    monkeypatch.setattr(vr.os, "environ", _fake_env())
    rc = vr.main([
        "--user-id", VALID_USER,
        "--connection-id", VALID_CONN,
        "--base-url", "http://evil",
    ])
    assert rc == 1
