"""Contract tests for EXCHANGE_CREDENTIALS_READ_OWNED.

Cover:
  * Allowlist parity: op is present in both client + edge function.
  * Client returns only the whitelisted encrypted-columns dict.
  * Malformed server responses raise WorkerIngestAuthError (never a silent
    dict with plaintext).
  * Timeouts / 5xx / network errors classify correctly (retry-safe transient).
  * No plaintext credential key is ever accepted from the server.
  * Client-side input validation (empty user_id/connection_id).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

import worker_ingest_client as wic

SECRET = "test-worker-ingest-shared-secret-32b"
WID = "railway-turtlebot-primary"
URL = "https://sthdmulczzebfcmihhca.supabase.co"
EDGE_FN = Path(__file__).resolve().parents[1] / "supabase" / "functions" / "worker-ingest" / "index.ts"


def _resp(status=200, body=None):
    r = MagicMock(spec=requests.Response)
    r.status_code = status
    r.json.return_value = body or {}
    return r


def _c():
    return wic.WorkerIngestClient(URL, worker_id=WID, shared_secret=SECRET, key_version="v1")


VALID_CRED = {
    "encrypted_api_key": "v1:iv:ct1",
    "encrypted_api_secret": "v1:iv:ct2",
    "encrypted_passphrase": "v1:iv:ct3",
    "encryption_version": 1,
    "exchange": "apex_omni",
    "environment": "mainnet",
    "connection_status": "connected",
}


# --- allowlist parity -----------------------------------------------------

def test_op_present_in_edge_allowlist():
    src = EDGE_FN.read_text(encoding="utf-8")
    ops_block = re.search(r"const ALLOWED_OPS = new Set\(\[(.*?)\]\)", src, re.S).group(1)
    ops = set(re.findall(r'"([A-Z_]+)"', ops_block))
    assert "EXCHANGE_CREDENTIALS_READ_OWNED" in ops


def test_op_has_a_bounded_rate_limit_in_edge():
    src = EDGE_FN.read_text(encoding="utf-8")
    assert "EXCHANGE_CREDENTIALS_READ_OWNED" in src
    # Rate-limit table entry exists.
    assert re.search(
        r"EXCHANGE_CREDENTIALS_READ_OWNED:\s*{\s*perMinute:\s*\d+", src
    ), "rate limit missing"


def test_op_absent_from_execution_operations_allowlist():
    """The signer's execution allowlist must NOT contain a data-plane op."""
    from signer.app.operations import ALLOWED_OPERATIONS
    assert "EXCHANGE_CREDENTIALS_READ_OWNED" not in ALLOWED_OPERATIONS


# --- successful read shape ------------------------------------------------

def test_read_returns_only_whitelisted_encrypted_columns():
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(200, {"ok": True, "credential": VALID_CRED})):
        cred = c.read_exchange_credentials_owned(user_id="u", connection_id="c")
    assert set(cred.keys()) == set(VALID_CRED.keys())
    # No plaintext key names slipped in.
    for k in cred:
        assert not re.match(r"^(api_key|api_secret|passphrase|plaintext_)", k)


def test_signed_headers_present_and_body_canonical():
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(200, {"ok": True, "credential": VALID_CRED})) as p:
        c.read_exchange_credentials_owned(user_id="u", connection_id="c")
    kw = p.call_args.kwargs
    for h in ("x-worker-id", "x-worker-timestamp", "x-worker-nonce",
              "x-worker-signature", "x-worker-key-version"):
        assert kw["headers"][h]
    body = json.loads(kw["data"])
    assert body["operation"] == "EXCHANGE_CREDENTIALS_READ_OWNED"
    assert body["user_id"] == "u" and body["connection_id"] == "c"
    # HMAC math must verify against the exact bytes sent.
    canonical = wic.canonical_string(
        kw["headers"]["x-worker-timestamp"], kw["headers"]["x-worker-nonce"],
        "POST", "/worker-ingest", kw["data"], WID, "v1",
    )
    assert kw["headers"]["x-worker-signature"] == hmac.new(
        SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()


# --- malformed / hostile responses ---------------------------------------

def test_missing_credential_object_raises():
    c = _c()
    with patch.object(wic.requests, "post", return_value=_resp(200, {"ok": True})):
        with pytest.raises(wic.WorkerIngestAuthError):
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")


def test_missing_required_field_raises():
    partial = dict(VALID_CRED); partial.pop("encrypted_api_secret")
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(200, {"ok": True, "credential": partial})):
        with pytest.raises(wic.WorkerIngestAuthError):
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")


def test_plaintext_field_in_response_rejected():
    """Belt-and-suspenders: server must never send a plaintext key; if it
    does, client refuses rather than pass it to the signer."""
    hostile = dict(VALID_CRED, api_key="LEAKED-PLAINTEXT")
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(200, {"ok": True, "credential": hostile})):
        with pytest.raises(wic.WorkerIngestAuthError) as ei:
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")
    assert "PLAINTEXT_LEAK_REJECTED" in str(ei.value)


# --- transport failure modes ---------------------------------------------

def test_404_returns_auth_error_no_retry():
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(404, {"error": "CONNECTION_NOT_FOUND"})) as p:
        with pytest.raises(wic.WorkerIngestAuthError) as ei:
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")
    assert "HTTP_404" in str(ei.value)
    assert p.call_count == 1


def test_5xx_retries_then_transient():
    c = _c()
    with patch.object(wic.requests, "post", return_value=_resp(500)), \
         patch.object(wic.time, "sleep", lambda _: None):
        with pytest.raises(wic.WorkerIngestTransientError):
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")


def test_network_timeout_retries_then_transient():
    c = _c()
    with patch.object(wic.requests, "post", side_effect=requests.exceptions.Timeout()), \
         patch.object(wic.time, "sleep", lambda _: None):
        with pytest.raises(wic.WorkerIngestTransientError):
            c.read_exchange_credentials_owned(user_id="u", connection_id="c")


def test_request_uses_bounded_timeout():
    """Static assertion: client uses a finite, small timeout tuple."""
    assert isinstance(wic.REQUEST_TIMEOUT, tuple)
    connect, read = wic.REQUEST_TIMEOUT
    assert 0 < connect <= 15 and 0 < read <= 30


# --- input validation ----------------------------------------------------

def test_empty_ids_rejected_client_side():
    c = _c()
    with pytest.raises(ValueError):
        c.read_exchange_credentials_owned(user_id="", connection_id="c")
    with pytest.raises(ValueError):
        c.read_exchange_credentials_owned(user_id="u", connection_id="")


# --- secret-leak surface --------------------------------------------------

def test_client_does_not_log_secret_or_body(caplog):
    """Client MUST NOT log the shared secret, the signature, or the body."""
    import logging
    caplog.set_level(logging.DEBUG)
    c = _c()
    with patch.object(wic.requests, "post",
                      return_value=_resp(200, {"ok": True, "credential": VALID_CRED})):
        c.read_exchange_credentials_owned(user_id="u", connection_id="c")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert SECRET not in text
    for v in VALID_CRED.values():
        assert str(v) not in text


# --- edge function payload shape does not leak plaintext -----------------

def test_edge_handler_selects_only_encrypted_columns():
    """Static guard: the SELECT in the edge function must not include a
    plaintext column name and must include the encrypted ones."""
    src = EDGE_FN.read_text(encoding="utf-8")
    m = re.search(
        r"exchange_credentials\"\)\s*\.select\(\s*\"([^\"]+)\"", src)
    assert m, "select block for exchange_credentials not found"
    cols = {c.strip() for c in m.group(1).split(",")}
    assert cols == {
        "encrypted_api_key",
        "encrypted_api_secret",
        "encrypted_passphrase",
        "encryption_version",
    }
    for banned in ("api_key", "api_secret", "passphrase", "plaintext"):
        assert banned not in cols
