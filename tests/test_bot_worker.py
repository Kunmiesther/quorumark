"""Tests for bot_worker DNS retry + connectivity recovery.

The worker never accepts SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY.
Its order path uses a dedicated machine HMAC and no database administrator
credential.

These tests inject fake resolvers/sleepers so nothing hits the real network.
"""
import socket
from unittest.mock import patch, MagicMock

import bot_worker as bw


def test_dns_success_first_attempt():
    calls = []
    def fake_resolver(host, port):
        calls.append(host)
        return [("dummy",)]
    slept = []
    ok, err = bw.resolve_dns_with_retry(
        "example.com", resolver=fake_resolver, sleep=slept.append, delays=[0, 2, 4],
    )
    assert ok is True and err is None
    assert len(calls) == 1
    assert slept == []


def test_dns_failure_then_success():
    attempts = {"n": 0}
    def flaky_resolver(host, port):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise socket.gaierror(-2, "Name or service not known")
        return [("dummy",)]
    slept = []
    ok, err = bw.resolve_dns_with_retry(
        "sthdmulczzebfcmihhca.supabase.co",
        resolver=flaky_resolver, sleep=slept.append, delays=[0, 1, 1, 1],
    )
    assert ok is True and err is None
    assert attempts["n"] == 3
    assert slept == [1, 1]


def test_dns_all_attempts_fail():
    def bad_resolver(host, port):
        raise socket.gaierror(-2, "Name or service not known")
    ok, err = bw.resolve_dns_with_retry(
        "nope.invalid", resolver=bad_resolver, sleep=lambda _s: None,
        delays=[0, 0, 0],
    )
    assert ok is False
    assert err and err.startswith("DNS_GAIERROR")


def test_classify_errors():
    import requests
    assert bw.classify_supabase_error(socket.gaierror(-2)) == "DNS_FAILURE"
    assert bw.classify_supabase_error(socket.timeout()) == "TIMEOUT"
    assert bw.classify_supabase_error(requests.exceptions.Timeout()) == "TIMEOUT"
    assert bw.classify_supabase_error(requests.exceptions.ConnectionError()) == "CONNECTION_ERROR"
    import ssl
    assert bw.classify_supabase_error(ssl.SSLError("boom")) == "TLS_FAILURE"
    r = MagicMock(); r.status_code = 401
    err = requests.exceptions.HTTPError(response=r)
    assert bw.classify_supabase_error(err) == "AUTH_FAILURE"


def test_url_syntax_rejects_placeholder(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://${SUPABASE_PROJECT_ID}.supabase.co")
    try:
        bw.validate_supabase_url_syntax("SUPABASE_URL")
        assert False, "should have raised"
    except bw.ConfigValidationError as e:
        assert "SUPABASE_URL" in str(e)


def test_url_syntax_accepts_valid(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    got = bw.validate_supabase_url_syntax("SUPABASE_URL")
    assert got.endswith(".supabase.co")


def _clear_all_key_vars(monkeypatch):
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        monkeypatch.delenv(name, raising=False)
    for name in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BROKER_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("TURTLE_BROKER_BASE_URL", raising=False)


def test_recovery_from_demo(monkeypatch):
    """DNS fails at init → try_recover succeeds → paper mode via worker-ingest.
    Uses PUBLISHABLE key only (no service-role, no BROKER_SIGNING_SECRET)."""
    import worker_ingest_client as wic
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", False)
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_key")
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", "test-worker-ingest-shared-secret-32b")
    monkeypatch.setenv("WORKER_INGEST_WORKER_ID", "railway-turtlebot-primary")

    with patch.object(bw.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "fail")), \
         patch.object(bw.time, "sleep", lambda _s: None):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.credentials_ok is False

    fake_resp = MagicMock(); fake_resp.status_code = 200; fake_resp.json.return_value = {"ok": True}
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, None)), \
         patch.object(wic.requests, "post", return_value=fake_resp):
        bot._last_connectivity_check = -1e9
        recovered = bot.try_recover()

    assert recovered is True
    assert bot.mode == "paper"
    assert bot.credentials_ok is True
    assert bot.ingest is not None


def test_recovery_still_failing_stays_demo(monkeypatch):
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_key")

    with patch.object(bw.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "fail")), \
         patch.object(bw.time, "sleep", lambda _s: None):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"

    with patch.object(bw, "resolve_dns_with_retry", return_value=(False, "DNS_GAIERROR_-2")):
        bot._last_connectivity_check = -1e9
        assert bot.try_recover() is False
    assert bot.mode == "demo"


# ---------------------------------------------------------------------------
# Stage 0.5 invariants
# ---------------------------------------------------------------------------
def _build_bot_offline(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    with patch.object(bw.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "fail")), \
         patch.object(bw.time, "sleep", lambda _s: None):
        return bw.RailwayTurtleBot()


def test_worker_starts_without_service_role_key(monkeypatch):
    """Worker must compile and start with NO server-only credential set."""
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    bot = _build_bot_offline(monkeypatch)
    # Constructor completed, key selection landed on publishable slot.
    assert bot._key_var == "SUPABASE_PUBLISHABLE_KEY"
    assert bot.key_kind == "sb_publishable"


def test_worker_starts_without_broker_signing_secret(monkeypatch):
    """Absence of BROKER_SIGNING_SECRET is required, not a fault."""
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    assert "BROKER_SIGNING_SECRET" not in __import__("os").environ
    bot = _build_bot_offline(monkeypatch)
    assert bot.api_key == "sb_publishable_abc"


def test_service_role_env_present_refuses_to_activate(monkeypatch, caplog):
    """If SUPABASE_SERVICE_ROLE_KEY is present, worker stays in demo mode
    with a sanitized error — never uses it."""
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_leaked_value")
    with caplog.at_level("ERROR"):
        bot = _build_bot_offline(monkeypatch)
    assert bot.mode == "demo"
    assert bot.api_key == ""
    # Sanitized log lists the variable name but not the value.
    msgs = "\n".join(r.getMessage() for r in caplog.records)
    assert "SUPABASE_SERVICE_ROLE_KEY" in msgs
    assert "sb_secret_leaked_value" not in msgs


def test_secret_key_env_present_refuses_to_activate(monkeypatch, caplog):
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_another")
    with caplog.at_level("ERROR"):
        bot = _build_bot_offline(monkeypatch)
    assert bot.mode == "demo"
    msgs = "\n".join(r.getMessage() for r in caplog.records)
    assert "SUPABASE_SECRET_KEY" in msgs
    assert "sb_secret_another" not in msgs


def test_broker_signing_secret_present_is_now_accepted(monkeypatch):
    """REWRITTEN — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: `test_broker_signing_secret_env_present_refuses_to_activate` — the
    worker refused to boot if BROKER_SIGNING_SECRET was present, because it
    had no order path and the secret had no legitimate consumer.

    NOW: the owner explicitly reinstated worker->broker order intents, so the
    secret is REQUIRED for that path. Refusing to boot on it would be the bug.

    NOT relaxed: SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEY remain hard
    rejects (see the two tests below, untouched). The broker authenticates by
    HMAC alone and holds service-role in its own env, so restoring order
    transmission needs exactly one signing secret and no admin credential.
    """
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    monkeypatch.setenv("BROKER_SIGNING_SECRET", "broker-secret-32-bytes-min-length-!")
    monkeypatch.setenv("TURTLE_BROKER_BASE_URL", "https://broker.example")
    bot = _build_bot_offline(monkeypatch)
    assert bot.api_key == "sb_publishable_abc"      # boot proceeded
    assert bot._broker_secret() is not None          # and the path is available


def test_worker_without_broker_secret_degrades_not_crashes(monkeypatch):
    """KEPT, NARROWED. Absence must disable the order path cleanly — never
    crash, never silently send unsigned."""
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    bot = _build_bot_offline(monkeypatch)
    assert bot._broker_secret() is None
    r = bot.submit_order_intent({"symbol": "BTC-USDT"})
    assert r["ok"] is False
    assert r["reject_reason"] == "BROKER_SIGNING_SECRET_NOT_CONFIGURED"


def test_order_intent_path_restored_and_proof_path_still_gone():
    """REWRITTEN — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: asserted `submit_order_intent` did not exist. That assertion was the
    teeth of the Stage 0.5 hardening; it is removed only because the owner
    ruled, not because it eroded.

    `prove_testnet_order` stays deleted: the pilot is mainnet-only and a
    testnet proof path has no consumer.
    """
    assert hasattr(bw.RailwayTurtleBot, "submit_order_intent")
    assert not hasattr(bw.RailwayTurtleBot, "prove_testnet_order")


def test_broker_call_is_hmac_only_never_service_role(monkeypatch):
    """REWRITTEN — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: forbade any `execution-broker` reference. Broker calls are now legal.

    THE ASSERTION WORTH KEEPING: the worker must never send an Authorization/
    Bearer header or any service-role key. The broker verifies
    `x-broker-signature` (HMAC over the raw body) and reads service-role from
    its OWN env; a caller-supplied admin credential would re-open exactly what
    Stage 0.5 closed.

    Inspects the ACTUAL headers dict. An earlier version grepped the source for
    "Authorization" and tripped on a docstring — the third time a text grep
    asserted vocabulary instead of behavior.
    """
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", False)
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc")
    monkeypatch.setenv("BROKER_SIGNING_SECRET", "broker-secret-32-bytes-min-length-!")
    monkeypatch.setenv("TURTLE_BROKER_BASE_URL", "https://broker.example")
    bot = _build_bot_offline(monkeypatch)

    captured = {}
    def fake_post(url, data=None, headers=None, timeout=None):
        captured.update(url=url, data=data, headers=headers)
        r = MagicMock(); r.status_code = 200; r.json.return_value = {"ok": True}
        return r
    with patch.object(bw.requests, "post", side_effect=fake_post):
        bot.submit_order_intent({"symbol": "BTC-USDT", "side": "BUY"})

    h = captured["headers"]
    assert "x-worker-signature" in h and h["x-worker-signature"]
    assert "x-worker-timestamp" in h and h["x-worker-timestamp"]
    assert "x-worker-nonce" in h and h["x-worker-nonce"]
    # The invariant that did NOT change — asserted on the real dict:
    assert not any(k.lower() == "authorization" for k in h)
    assert not any("bearer" in str(v).lower() for v in h.values())
    assert not any("sb_secret_" in str(v) or "service_role" in str(v).lower() for v in h.values())
    assert captured["url"] == "https://broker.example/v1/automation/orders"
    # is_live is forced false on the wire, not merely in the caller's dict.
    import json as _j
    assert _j.loads(captured["data"])["is_live"] is False


def test_submitted_intents_use_only_the_owner_controlled_live_flag():
    """`is_live` is not caller-controlled; it comes from the process-level
    owner flag, while broker and signer gates remain independent."""
    import inspect
    src = inspect.getsource(bw.RailwayTurtleBot.submit_order_intent)
    assert 'body["is_live"] = LIVE_TRADING_ENABLED' in src


def test_broker_server_failure_retains_safe_reason_but_never_authorizes_retry(monkeypatch):
    monkeypatch.setattr(bw.RailwayTurtleBot, "_broker_secret", lambda self: "test-secret")
    monkeypatch.setattr(bw.RailwayTurtleBot, "_broker_base_url", lambda self: "https://broker.example")
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    for code, expected in [
        ("INTENT_RESERVATION_FAILED", "INTENT_RESERVATION_FAILED"),
        ("SIGNER_UNREACHABLE", "SIGNER_UNREACHABLE"),
        ("secret=value provider response", "BROKER_EXECUTION_UNKNOWN"),
        (None, "BROKER_EXECUTION_UNKNOWN"),
        ("X" * 97, "BROKER_EXECUTION_UNKNOWN"),
    ]:
        response = MagicMock(status_code=503)
        response.json.return_value = {"status": "rejected", "reject_reason": code}
        with patch.object(bw.requests, "post", return_value=response) as post:
            result = bot.submit_order_intent({"symbol": "BTC-USDT"})
        assert result == {"ok": False, "status": "ambiguous", "reject_reason": expected}
        post.assert_called_once()


def test_forbidden_key_vars_declared():
    assert "SUPABASE_SERVICE_ROLE_KEY" in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS
    assert "SUPABASE_SECRET_KEY" in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS


def test_key_candidates_publishable_only():
    """The candidate list must not include any server-only slot."""
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        assert name not in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS


def test_publishable_key_selected_from_publishable_var(monkeypatch, caplog):
    _clear_all_key_vars(monkeypatch)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc123")
    with caplog.at_level("INFO"):
        bot = _build_bot_offline(monkeypatch)
    assert bot._key_var == "SUPABASE_PUBLISHABLE_KEY"
    assert bot.key_kind == "sb_publishable"
    msgs = [r.getMessage() for r in caplog.records]
    assert any(
        "Supabase key source var=SUPABASE_PUBLISHABLE_KEY kind=sb_publishable" in m
        for m in msgs
    )
    for m in msgs:
        assert "sb_publishable_abc123" not in m
