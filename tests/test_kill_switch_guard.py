"""Kill-switch hardening: EXECUTION_GUARD_READ fail-closed contract.

These tests exercise the *client-side* enforcement in `bot_worker.halted()`
and the guard method on `WorkerIngestClient`. The edge function is proxied
via `patch.object(wic.requests, "post", ...)` — nothing hits the network.

Every non-happy path MUST resolve to `halted=True` with no promotion to
demo mode.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
import requests

import bot_worker as bw
import worker_ingest_client as wic


URL = "https://sthdmulczzebfcmihhca.supabase.co"
PUB_KEY = "sb_publishable_test"
SECRET = "test-worker-ingest-shared-secret-32b"
WID = "railway-turtlebot-primary"
USER = "11111111-1111-1111-1111-111111111111"
CONN = "22222222-2222-2222-2222-222222222222"


def _http(status: int, body: dict | None = None) -> MagicMock:
    r = MagicMock()
    r.status_code = int(status)
    r.json.return_value = body if body is not None else {}
    return r


def _fresh_guard_body(*, halted: bool, reason: str | None = None, age_sec: float = 0.0) -> dict:
    evaluated = datetime.now(timezone.utc) - timedelta(seconds=age_sec)
    return {
        "ok": True,
        "halted": halted,
        "reason_code": reason if halted else None,
        "guard_version": "v1",
        "evaluated_at": evaluated.isoformat().replace("+00:00", "Z"),
        "environment": "testnet",
        "worker_id": WID,
        "correlation_id": "cid-1",
    }


def _bot(monkeypatch) -> bw.RailwayTurtleBot:
    # test_live_trading_flag reloads the shared bot_worker module while
    # exercising both flag values. Pin the process-level constant here so
    # this suite cannot inherit that module-global state from collection
    # order; these guard tests intentionally exercise the paper worker.
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", False)
    monkeypatch.setenv("SUPABASE_URL", URL)
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        monkeypatch.delenv(name, raising=False)
    for name in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BROKER_SIGNING_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", PUB_KEY)
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", SECRET)
    monkeypatch.setenv("WORKER_INGEST_WORKER_ID", WID)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(wic.requests, "post", return_value=_http(200, {"ok": True})):
        bot = bw.RailwayTurtleBot()
    # Sanity: readiness gate promoted us to paper.
    assert bot.mode == "paper"
    assert bot.ingest is not None
    return bot



# --- 1. halted=false when permitted -----------------------------------------
def test_guard_returns_halted_false_when_permitted(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(200, _fresh_guard_body(halted=False))):
        assert bot.halted(USER, CONN) is False


# --- 2. halted=true when kill switch enabled --------------------------------
@pytest.mark.parametrize("reason", ["GLOBAL_HALT", "USER_HALT", "CONNECTION_HALT"])
def test_guard_returns_halted_true(monkeypatch, reason):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(200, _fresh_guard_body(halted=True, reason=reason))):
        assert bot.halted(USER, CONN) is True


# --- 3. missing guard record fails closed -----------------------------------
def test_missing_guard_record_fails_closed(monkeypatch):
    bot = _bot(monkeypatch)
    body = _fresh_guard_body(halted=True, reason="NO_GUARD_RECORD")
    with patch.object(wic.requests, "post", return_value=_http(200, body)):
        assert bot.halted(USER, CONN) is True


# --- 4. timeout fails closed -------------------------------------------------
def test_timeout_fails_closed(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", side_effect=requests.exceptions.Timeout()), \
         patch.object(wic.time, "sleep", lambda _s: None):
        assert bot.halted(USER, CONN) is True
    assert bot.mode == "paper"  # NOT demoted — guard failures don't demote


# --- 5. 401/403 fail closed --------------------------------------------------
@pytest.mark.parametrize("status", [401, 403])
def test_auth_failure_fails_closed(monkeypatch, status):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(status, {"error": "INVALID_SIGNATURE"})):
        assert bot.halted(USER, CONN) is True
    assert bot.mode == "paper"


# --- 6. 429/5xx fail closed --------------------------------------------------
@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_transient_fails_closed(monkeypatch, status):
    bot = _bot(monkeypatch)
    # read_execution_guard is called with idempotent=False → no retries.
    with patch.object(wic.requests, "post", return_value=_http(status, {"error": "X"})), \
         patch.object(wic.time, "sleep", lambda _s: None):
        assert bot.halted(USER, CONN) is True
    assert bot.mode == "paper"


# --- 7. malformed response fails closed --------------------------------------
@pytest.mark.parametrize("body", [
    {"halted": False},                                              # no guard_version
    {"halted": False, "guard_version": "v99", "evaluated_at": "z"}, # wrong version
    {"halted": False, "guard_version": "v1"},                       # no evaluated_at
    {"halted": "false", "guard_version": "v1", "evaluated_at": "z"},# wrong types
    {"halted": None, "guard_version": "v1", "evaluated_at": datetime.now(timezone.utc).isoformat()},
])
def test_malformed_response_fails_closed(monkeypatch, body):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(200, body)):
        assert bot.halted(USER, CONN) is True


# --- 8. stale response (>30s) fails closed -----------------------------------
def test_stale_response_fails_closed(monkeypatch):
    bot = _bot(monkeypatch)
    body = _fresh_guard_body(halted=False, age_sec=bw.EXECUTION_GUARD_MAX_AGE_SEC + 5)
    with patch.object(wic.requests, "post", return_value=_http(200, body)):
        assert bot.halted(USER, CONN) is True


def test_fresh_response_within_window_is_accepted(monkeypatch):
    bot = _bot(monkeypatch)
    body = _fresh_guard_body(halted=False, age_sec=5)
    with patch.object(wic.requests, "post", return_value=_http(200, body)):
        assert bot.halted(USER, CONN) is False


# --- 9. revoked worker fails closed ------------------------------------------
def test_revoked_worker_fails_closed(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(403, {"error": "WORKER_NOT_REGISTERED"})):
        assert bot.halted(USER, CONN) is True


# --- 10. replayed nonce rejected (server returns 401 REPLAYED_NONCE) ---------
def test_replayed_nonce_fails_closed(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(401, {"error": "REPLAYED_NONCE"})):
        assert bot.halted(USER, CONN) is True


# --- 11. worker exposes NO order-transmission method (Stage 0.5) -------------
def test_guard_on_blocks_the_order_submission_path(monkeypatch):
    """NARROWED — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: `test_worker_has_no_order_submission_path` — asserted
    `submit_order_intent` did not exist. Its EXISTENCE is no longer forbidden.

    NOT weakened: the safety property was never "the method is absent", it was
    "a halted config cannot submit". That is now asserted behaviorally, which
    is strictly stronger — the old test passed trivially because the method
    did not exist and would have said nothing once it did.

    `prove_testnet_order` stays absent: mainnet-only pilot, no consumer.
    """
    assert not hasattr(bw.RailwayTurtleBot, "prove_testnet_order")
    bot = _bot(monkeypatch)
    bot.submit_order_intent = MagicMock()
    with patch.object(wic.requests, "post",
                      return_value=_http(200, _fresh_guard_body(halted=True, reason="GLOBAL_HALT"))):
        assert bot.halted(USER, CONN) is True
    bot.submit_order_intent.assert_not_called()


def test_uncertain_guard_state_fails_closed_before_any_submission(monkeypatch):
    """An unreadable guard must halt AND must not submit. Fail closed."""
    bot = _bot(monkeypatch)
    bot.submit_order_intent = MagicMock()
    with patch.object(wic.requests, "post", side_effect=Exception("boom")):
        assert bot.halted(USER, CONN) is True
    bot.submit_order_intent.assert_not_called()


def test_execution_flags_remain_disabled():
    """The transport cannot override the process-level opt-in flag."""
    import inspect
    src = inspect.getsource(bw.RailwayTurtleBot.submit_order_intent)
    assert 'body["is_live"] = LIVE_TRADING_ENABLED' in src
    assert 'os.environ.get("LIVE_TRADING_ENABLED", "false")' in open(
        "bot_worker.py", encoding="utf-8"
    ).read()


# --- 12. broker independently rejects while halted (contract) ---------------
def test_railway_automation_path_has_independent_kill_switch():
    """The Railway worker route must delegate to the private signer, whose
    order endpoint independently reads the kill switch before submission.

    The worker's own guard result is defense in depth; it is never treated as
    the authority that permits an order.
    """
    with open("broker/src/server.ts", encoding="utf-8") as f:
        broker = f.read()
    automation = broker[broker.index('app.post("/v1/automation/orders"'):]
    assert 'const path = "/v1/orders"' in automation
    assert "x-signer-signature" in automation

    with open("signer/app/main.py", encoding="utf-8") as f:
        signer = f.read()
    order_endpoint = signer[signer.index('@app.post("/v1/orders")'):]
    idx_guard = order_endpoint.index("_db().is_execution_halted(")
    idx_submit = order_endpoint.index("create_order_pipeline(")
    assert idx_guard < idx_submit, "signer must read the kill switch before venue submission"

    with open("signer/app/db.py", encoding="utf-8") as f:
        db = f.read()
    guard_method = db[db.index("def is_execution_halted("):db.index("def insert_credential_audit(")]
    assert "except Exception:" in guard_method
    assert "return True" in guard_method, "an unreadable kill switch must fail closed"


# --- 13. guard OFF does not replay halted work (no worker queue) -------------
def test_guard_off_does_not_auto_replay(monkeypatch):
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", return_value=_http(200, _fresh_guard_body(halted=True, reason="GLOBAL_HALT"))):
        assert bot.halted(USER, CONN) is True
    # A4 REMAINS FULLY IN FORCE (owner re-affirmed 2026-07-17). Guard OFF must
    # never automatically replay, resubmit, or revive an intent that was
    # halted, blocked, rejected, or pending before the halt. Restoring Stage
    # 0.5 applies ONLY to a NEW eligible signal after the guard is OFF.
    #
    # These two assertions ARE A4 and are UNCHANGED: no queue exists, so there
    # is nothing to replay. That is the structural guarantee.
    assert not hasattr(bot, "_pending_intent_queue")
    assert not hasattr(bot, "queued_intents")
    # NARROWED: `submit_order_intent` may now exist (owner-authorized). Its
    # existence was never the A4 property — the absence of a replay queue is.
    assert not hasattr(bot, "_replay_intents")
    assert not hasattr(bot, "resubmit_halted_intents")



# --- 15. no path transitions to live -----------------------------------------
def test_no_path_transitions_to_live(monkeypatch):
    bot = _bot(monkeypatch)
    assert bot.mode == "paper"
    # Even after many guard reads, mode stays paper.
    with patch.object(wic.requests, "post", return_value=_http(200, _fresh_guard_body(halted=False))):
        for _ in range(3):
            bot.halted(USER, CONN)
    assert bot.mode == "paper"


# --- 16. no mainnet flags change ---------------------------------------------
def test_no_mainnet_flags_change():
    """None of the mainnet flags are toggled on in-repo config."""
    with open("supabase/config.toml", encoding="utf-8") as f:
        toml = f.read()
    for line in toml.lower().splitlines():
        assert "apex_execution_moved_to_railway = true" not in line
        assert "mainnet_enabled = true" not in line
        assert "live_trading = true" not in line


# --- 17. no secret values in logs -------------------------------------------
def test_no_secret_values_in_captured_logs(monkeypatch, caplog):
    """halted() must never log the shared secret, publishable key, or Auth
    headers on ANY failure path. Assert on captured records, not by hand.
    """
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", "MYSECRET_SHARED_SENTINEL_ABC123")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_SENTINEL_LEAK_XYZ")
    bot = _bot(monkeypatch)
    caplog.set_level(logging.DEBUG, logger="")

    # Force each fail path
    with patch.object(wic.requests, "post", side_effect=requests.exceptions.Timeout()), \
         patch.object(wic.time, "sleep", lambda _s: None):
        bot.halted(USER, CONN)
    with patch.object(wic.requests, "post", return_value=_http(401, {"error": "INVALID_SIGNATURE"})):
        bot.halted(USER, CONN)
    with patch.object(wic.requests, "post", return_value=_http(200, {"garbage": True})):
        bot.halted(USER, CONN)

    combined = "\n".join(r.getMessage() for r in caplog.records)
    assert "MYSECRET_SHARED_SENTINEL_ABC123" not in combined
    assert "sb_publishable_SENTINEL_LEAK_XYZ" not in combined
    # Also assert that no signature-header value appears verbatim in logs.
    for r in caplog.records:
        msg = r.getMessage()
        assert "x-worker-signature" not in msg.lower()
        assert "authorization:" not in msg.lower()


# --- extra: guard failures do NOT count toward ingest demotion --------------
def test_guard_failure_does_not_demote(monkeypatch):
    bot = _bot(monkeypatch)
    prior_failed = bot._failed_ingest_calls
    with patch.object(wic.requests, "post", return_value=_http(500, {"error": "boom"})), \
         patch.object(wic.time, "sleep", lambda _s: None):
        for _ in range(10):
            bot.halted(USER, CONN)
    assert bot.mode == "paper"
    assert bot.credentials_ok is True
    assert bot._failed_ingest_calls == prior_failed


# --- fail-closed integrity: the guard must halt even when audit is broken ----
def test_guard_fails_closed_when_the_ingest_client_itself_raises(monkeypatch):
    """REGRESSION. `halted()` calls `log_event()` from inside its exception
    handlers. Before the 2026-07-17 fix, an unanticipated exception from the
    ingest client escaped `log_event`, escaped `halted()`'s `except Exception`,
    and propagated into the worker loop — so the guard RAISED instead of
    halting, precisely when the transport was already broken.

    A failed audit write must never defeat a halt."""
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", side_effect=Exception("boom")):
        assert bot.halted(USER, CONN) is True   # must NOT raise


def test_guard_fails_closed_on_unexpected_error_types(monkeypatch):
    for exc in (MemoryError("oom"), RuntimeError("weird"), TypeError("bad")):
        bot = _bot(monkeypatch)
        with patch.object(wic.requests, "post", side_effect=exc):
            assert bot.halted(USER, CONN) is True


def test_log_event_never_propagates(monkeypatch):
    """Nothing calling log_event may be broken by it."""
    bot = _bot(monkeypatch)
    with patch.object(wic.requests, "post", side_effect=Exception("boom")):
        bot.log_event(USER, "HEARTBEAT", "x", {})   # must not raise
