"""Parity test: signer-local `app.worker_ingest_client` must match the
repository-root `worker_ingest_client` used by the Railway worker.

Railway builds the signer with Root Directory `/signer`, so the repo-root
copy is not on `sys.path` in production. The signer imports its own
packaged copy under `signer/app/worker_ingest_client.py`. If the two ever
drift, HMAC signing, allowlists, or response validation could diverge —
this test fails loudly before that reaches production.

Covered surface:
  * Module-level security constants (allowlists, size/length caps, timeout).
  * `canonical_string` byte-for-byte HMAC input format.
  * Request signing: identical headers/body for the same inputs.
  * `read_exchange_credentials_owned` builds the EXCHANGE_CREDENTIALS_READ_OWNED
    op, validates required encrypted fields, and rejects any plaintext leak.
"""
from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _load_repo_root_module():
    """Load repository-root `worker_ingest_client.py` under a distinct
    module name so it doesn't collide with `app.worker_ingest_client`."""
    repo_root = Path(__file__).resolve().parents[2]
    root_path = repo_root / "worker_ingest_client.py"
    if not root_path.exists():
        pytest.skip("repo-root worker_ingest_client.py not present in this checkout")
    spec = importlib.util.spec_from_file_location(
        "worker_ingest_client_root", str(root_path)
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def root_mod():
    return _load_repo_root_module()


@pytest.fixture(scope="module")
def local_mod():
    from app import worker_ingest_client as local  # signer-packaged copy
    return local


CONSTANTS = (
    "ALLOWED_EVENT_CODES",
    "ALLOWED_LEVELS",
    "ALLOWED_MODES",
    "ALLOWED_STATUSES",
    "MAX_MESSAGE_LEN",
    "MAX_BODY_BYTES",
    "REQUEST_TIMEOUT",
)


@pytest.mark.parametrize("name", CONSTANTS)
def test_security_constants_match(root_mod, local_mod, name):
    assert getattr(local_mod, name) == getattr(root_mod, name), (
        f"{name} diverged between repo-root and signer-local worker_ingest_client"
    )


def test_canonical_string_bytes_identical(root_mod, local_mod):
    body = b'{"operation":"HEARTBEAT_UPSERT"}'
    args = ("1700000000", "abc123", "POST", "/worker-ingest", body,
            "railway-turtlebot-primary", "v1")
    assert local_mod.canonical_string(*args) == root_mod.canonical_string(*args)


def test_signed_request_headers_match(root_mod, local_mod):
    """Same inputs must produce identical HMAC signature + envelope."""
    secret = "s" * 32
    url = "https://x.supabase.co"
    fixed_ts = "1700000000"
    fixed_nonce = "deadbeef" * 4

    captured = {}

    def fake_post(endpoint, data, headers, timeout):
        captured.setdefault("calls", []).append({
            "endpoint": endpoint, "data": data, "headers": dict(headers),
        })
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"ok": True}
        return resp

    results = []
    for mod in (root_mod, local_mod):
        with patch.object(mod, "time") as t, \
             patch.object(mod, "secrets") as s, \
             patch.object(mod.requests, "post", side_effect=fake_post):
            t.time.return_value = int(fixed_ts)
            s.token_hex.return_value = fixed_nonce
            client = mod.WorkerIngestClient(
                supabase_url=url, worker_id="wkr", shared_secret=secret,
                key_version="v1",
            )
            client.heartbeat(status="healthy", mode="paper")
            results.append(captured["calls"].pop())

    root_call, local_call = results
    assert root_call["endpoint"] == local_call["endpoint"]
    assert root_call["data"] == local_call["data"]
    assert root_call["headers"] == local_call["headers"]
    # And the signature is a real HMAC, not empty.
    assert len(local_call["headers"]["x-worker-signature"]) == 64


def test_read_exchange_credentials_owned_parity(root_mod, local_mod):
    """Op name, required fields, and plaintext-leak rejection match."""
    good = {
        "encrypted_api_key": "v1:iv:ct1",
        "encrypted_api_secret": "v1:iv:ct2",
        "encryption_version": 1,
        "exchange": "apex_omni",
        "environment": "mainnet",
        "connection_status": "connected",
    }
    leak = {**good, "api_key": "PLAINTEXT_NOPE"}
    missing = {k: v for k, v in good.items() if k != "encrypted_api_secret"}

    for mod in (root_mod, local_mod):
        # 1. Happy path — op body carries EXCHANGE_CREDENTIALS_READ_OWNED.
        captured_body = {}

        def fake_post(endpoint, data, headers, timeout, _cb=captured_body):
            _cb["data"] = data
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"credential": good}
            return resp

        with patch.object(mod.requests, "post", side_effect=fake_post):
            c = mod.WorkerIngestClient(
                supabase_url="https://x.supabase.co", worker_id="wkr",
                shared_secret="s" * 32, key_version="v1",
            )
            out = c.read_exchange_credentials_owned(user_id="u", connection_id="c")
        assert out == good
        assert b'"operation":"EXCHANGE_CREDENTIALS_READ_OWNED"' in captured_body["data"]
        assert b'"user_id":"u"' in captured_body["data"]
        assert b'"connection_id":"c"' in captured_body["data"]

        # 2. Plaintext leak in server response is refused.
        def leak_post(*a, **k):
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"credential": leak}
            return resp

        with patch.object(mod.requests, "post", side_effect=leak_post):
            c = mod.WorkerIngestClient(
                supabase_url="https://x.supabase.co", worker_id="wkr",
                shared_secret="s" * 32, key_version="v1",
            )
            with pytest.raises(mod.WorkerIngestAuthError):
                c.read_exchange_credentials_owned(user_id="u", connection_id="c")

        # 3. Missing required encrypted field is refused.
        def missing_post(*a, **k):
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"credential": missing}
            return resp

        with patch.object(mod.requests, "post", side_effect=missing_post):
            c = mod.WorkerIngestClient(
                supabase_url="https://x.supabase.co", worker_id="wkr",
                shared_secret="s" * 32, key_version="v1",
            )
            with pytest.raises(mod.WorkerIngestAuthError):
                c.read_exchange_credentials_owned(user_id="u", connection_id="c")


def test_signer_db_uses_local_packaged_module(local_mod):
    """`signer.app.db._import_wic()` must resolve to the packaged copy so
    Railway deployments (Root Directory /signer) don't rely on the
    repo-root file being on sys.path."""
    from app import db as db_mod
    wic = db_mod._import_wic()
    assert wic is local_mod, (
        "signer/app/db.py must import the signer-local worker_ingest_client, "
        "not the repo-root module."
    )
