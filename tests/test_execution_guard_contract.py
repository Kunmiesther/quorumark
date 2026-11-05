"""Contract tests for the EXECUTION_GUARD_READ operation.

These tests inspect the edge-function source and the client-side response
handling to enforce the ratified guard semantics without spinning up Deno
or Postgres. Semantics tested here:

  effective_halt =
    global_halt
      OR user_halt
      OR user_connection_halt
      OR ownership_mismatch

  precedence: global > user > user_connection > none

They complement the HTTP-mocked worker tests in
`test_kill_switch_guard.py`, which exercise the worker's fail-closed
handling of the guard response.
"""
from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import patch, MagicMock

import bot_worker as bw
import worker_ingest_client as wic
from tests.test_kill_switch_guard import (  # reuse fixtures
    _bot, _http, _fresh_guard_body, USER, CONN,
)

EDGE_SRC = Path("supabase/functions/worker-ingest/index.ts").read_text(encoding="utf-8")


# ---------- edge-function static contract ------------------------------------

def test_guard_uses_authenticated_worker_id_not_payload():
    """`worker_id` in the payload is IGNORED — only the HMAC-authenticated
    header value (bound to `worker_registry`) is trusted."""
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1]
    handler = handler.split("\n}\n", 1)[0]
    # The handler must not read payload.worker_id.
    assert "payload.worker_id" not in handler
    # It must accept only user_id / connection_id from the payload.
    assert "payload.user_id" in handler
    assert "payload.connection_id" in handler


def test_guard_validates_uuids_and_fails_closed_on_bad_input():
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1].split("\n}\n", 1)[0]
    assert "UUID_RE.test(user_id)" in handler
    assert "UUID_RE.test(connection_id)" in handler
    assert 'jsonError(400, "BAD_GUARD_INPUT"' in handler


def test_guard_enforces_ownership_before_kill_switch_lookup():
    """Ownership check must run before the kill_switches query; a mismatch
    fails closed with reason OWNERSHIP_MISMATCH."""
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1].split("\n}\n", 1)[0]
    i_own = handler.index('.from("exchange_connections")')
    i_ks = handler.index('.from("kill_switches")')
    assert i_own < i_ks, "ownership check must precede kill_switches read"
    assert '"OWNERSHIP_MISMATCH"' in handler


def test_guard_precedence_is_deterministic_global_user_userconn():
    """Global > user > user_connection > none, in that exact source order."""
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1].split("\n}\n", 1)[0]
    i_global = handler.index('reason_code = "GLOBAL_HALT"')
    i_user   = handler.index('reason_code = "USER_HALT"')
    i_conn   = handler.index('reason_code = "CONNECTION_HALT"')
    assert i_global < i_user < i_conn


def test_guard_scope_names_include_user_connection():
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1].split("\n}\n", 1)[0]
    for token in ('"global"', '"user"', '"user_connection"', '"none"'):
        assert token in handler, f"missing scope token {token} in guard handler"


def test_guard_response_never_echoes_user_or_connection_id():
    handler = EDGE_SRC.split("async function handleExecutionGuardRead(", 1)[1].split("\n}\n", 1)[0]
    body_block = handler.split("const body = {", 1)[1].split("};", 1)[0]
    assert "user_id" not in body_block
    assert "connection_id" not in body_block


def test_guard_operation_is_hmac_authenticated_like_other_ops():
    # No special bypass — EXECUTION_GUARD_READ goes through the same
    # signature / nonce / registry validation flow as every other op.
    assert '"EXECUTION_GUARD_READ"' in EDGE_SRC
    # Must be inside ALLOWED_OPS and NOT before signature verification.
    i_allow = EDGE_SRC.index('ALLOWED_OPS')
    i_sig   = EDGE_SRC.index('INVALID_SIGNATURE')
    i_disp  = EDGE_SRC.index('handleExecutionGuardRead(')
    assert i_allow < i_sig < i_disp


# ---------- worker-side response handling with new `scope` field -------------

def _fresh_with_scope(scope: str, reason: str) -> dict:
    body = _fresh_guard_body(halted=True, reason=reason)
    body["scope"] = scope
    return body


def test_worker_honors_global_scope(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post",
                      return_value=_http(200, _fresh_with_scope("global", "GLOBAL_HALT"))):
        assert bot.halted(USER, CONN) is True


def test_worker_honors_user_scope(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post",
                      return_value=_http(200, _fresh_with_scope("user", "USER_HALT"))):
        assert bot.halted(USER, CONN) is True


def test_worker_honors_user_connection_scope(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post",
                      return_value=_http(200, _fresh_with_scope("user_connection", "CONNECTION_HALT"))):
        assert bot.halted(USER, CONN) is True


def test_worker_accepts_scope_none_when_not_halted(monkeypatch):
    bot = _bot(monkeypatch)
    body = _fresh_guard_body(halted=False)
    body["scope"] = "none"
    with patch.object(wic.requests, "post", return_value=_http(200, body)):
        assert bot.halted(USER, CONN) is False


# ---------- database-permissions contract ------------------------------------

def test_migration_revokes_execute_from_anon_and_authenticated():
    """The Part-A migration must strip anon/authenticated EXECUTE on the
    internal RPC. The signed worker-ingest path is the only authorized
    caller."""
    migrations = list(Path("supabase/migrations").glob("*.sql"))
    combined = "\n".join(p.read_text(encoding="utf-8") for p in migrations)
    assert re.search(
        r"REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.is_execution_halted\(uuid,\s*uuid\)\s+FROM\s+anon",
        combined, re.IGNORECASE), "anon EXECUTE must be revoked"
    assert re.search(
        r"REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.is_execution_halted\(uuid,\s*uuid\)\s+FROM\s+authenticated",
        combined, re.IGNORECASE), "authenticated EXECUTE must be revoked"
    assert re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.is_execution_halted\(uuid,\s*uuid\)\s+TO\s+service_role",
        combined, re.IGNORECASE), "service_role EXECUTE must be granted"
