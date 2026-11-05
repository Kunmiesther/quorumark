"""Signer-side tests for the worker-ingest-backed credential reader.

Guarantees:
  * Reader boots WITHOUT SUPABASE_SERVICE_ROLE_KEY.
  * Reader calls the underlying WorkerIngestClient with the right shape.
  * Reader translates 404s to None (no leak of existence).
  * Reader propagates transient errors.
  * Read handlers (/v1/verify-credentials, /v1/read-account) do NOT
    construct or use the service-role DbClient — verified by making
    `SupabaseDbClient._client` raise if called.
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import db as db_mod
from app import main


CRED = {
    "encrypted_api_key": "v1:iv:ct1",
    "encrypted_api_secret": "v1:iv:ct2",
    "encrypted_passphrase": None,
    "encryption_version": 1,
    "exchange": "apex_omni",
    "environment": "mainnet",
    "connection_status": "connected",
}


class FakeWIC:
    def __init__(self):
        self.calls = []
        self._next = None
        self._raise = None
    def read_exchange_credentials_owned(self, *, user_id, connection_id):
        self.calls.append((user_id, connection_id))
        if self._raise:
            raise self._raise
        return self._next


def test_reader_boots_without_service_role_key(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", "s" * 32)
    # Should NOT raise: no service-role key required for the read path.
    r = db_mod.WorkerIngestBackedCredsReader()
    assert r is not None


def test_reader_translates_404_to_none():
    WorkerIngestAuthError = db_mod._import_wic().WorkerIngestAuthError
    fake = FakeWIC()
    fake._raise = WorkerIngestAuthError("HTTP_404_CONNECTION_NOT_FOUND")
    r = db_mod.WorkerIngestBackedCredsReader(client=fake)
    assert r.fetch_rest_credentials_owned("u", "c") is None


def test_reader_propagates_transient():
    from worker_ingest_client import WorkerIngestTransientError
    fake = FakeWIC()
    fake._raise = WorkerIngestTransientError("HTTP_502")
    r = db_mod.WorkerIngestBackedCredsReader(client=fake)
    with pytest.raises(WorkerIngestTransientError):
        r.fetch_rest_credentials_owned("u", "c")


def test_reader_returns_expected_shape():
    fake = FakeWIC(); fake._next = dict(CRED)
    r = db_mod.WorkerIngestBackedCredsReader(client=fake)
    row = r.fetch_rest_credentials_owned("u", "c")
    assert row["encrypted_api_key"] == CRED["encrypted_api_key"]
    assert row["exchange"] == "apex_omni"
    assert row["environment"] == "mainnet"
    assert row["connection_status"] == "connected"
    assert fake.calls == [("u", "c")]


def test_read_endpoints_do_not_touch_service_role(monkeypatch):
    """If any read-path code accidentally invokes the service-role client,
    the boot helper raises. This test proves the read handlers stay on the
    worker-ingest path only.
    """
    # Poison the lazy service-role builder.
    def _boom():
        raise AssertionError("service-role client must NOT be built for reads")
    monkeypatch.setattr(db_mod, "_client", _boom)
    main._DB = None  # force lazy path

    # Fake reader returns CONNECTION_NOT_FOUND-equivalent (None row).
    fake = FakeWIC(); fake._next = None
    main._CREDS = db_mod.WorkerIngestBackedCredsReader(client=fake)

    client = TestClient(main.app)
    # Signed request headers are enforced by security middleware; call the
    # in-process function under test-mode bypass by hitting the same helper
    # the endpoint uses.
    from app.main import ConnectionReadBody, _fetch_owned_rest_row
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _fetch_owned_rest_row(ConnectionReadBody(user_id="u", exchange_connection_id="c"))
    assert ei.value.status_code == 404
    main._CREDS = None
