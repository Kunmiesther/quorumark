"""Readiness gate + reachability probe tests for RailwayTurtleBot.

Covers the fix that separates transport reachability from HMAC authorization:
`/rest/v1/` answering 401 is proof the host is UP, and only the signed
`worker-ingest` heartbeat + config read is allowed to gate paper mode.
"""
from __future__ import annotations

import socket
import ssl
from unittest.mock import MagicMock, patch

import pytest
import requests

import bot_worker as bw
import worker_ingest_client as wic


URL = "https://sthdmulczzebfcmihhca.supabase.co"
PUB_KEY = "sb_publishable_test"
SECRET = "test-worker-ingest-shared-secret-32b"
WID = "railway-turtlebot-primary"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _http_response(status: int, body: dict | None = None) -> MagicMock:
    r = MagicMock(spec=requests.Response)
    r.status_code = status
    r.json.return_value = body if body is not None else {"ok": True}
    return r


def _base_env(monkeypatch, *, secret: bool = True) -> None:
    monkeypatch.setenv("SUPABASE_URL", URL)
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        monkeypatch.delenv(name, raising=False)
    for name in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BROKER_SIGNING_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", PUB_KEY)
    if secret:
        monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", SECRET)
        monkeypatch.setenv("WORKER_INGEST_WORKER_ID", WID)
    else:
        monkeypatch.delenv("WORKER_INGEST_SHARED_SECRET", raising=False)



# ---------------------------------------------------------------------------
# 1-3. Reachability probe: pure transport check
# ---------------------------------------------------------------------------
def test_reachability_true_on_401_secret_api_key_required():
    resp = _http_response(401, {"code": "unauthorized", "message": "Secret API key required"})
    with patch.object(bw.requests, "get", return_value=resp):
        ok, advisory = bw.check_supabase_reachable(URL, PUB_KEY)
    assert ok is True
    assert advisory == "HTTP_401"


@pytest.mark.parametrize("status", [200, 403, 500])
def test_reachability_true_on_any_http_status(status):
    with patch.object(bw.requests, "get", return_value=_http_response(status)):
        ok, advisory = bw.check_supabase_reachable(URL, PUB_KEY)
    assert ok is True
    assert advisory == f"HTTP_{status}"


@pytest.mark.parametrize("exc,cat", [
    (socket.gaierror(-2, "fail"),                          "DNS_FAILURE"),
    (ssl.SSLError("bad handshake"),                        "TLS_FAILURE"),
    (requests.exceptions.Timeout(),                        "TIMEOUT"),
    (requests.exceptions.ConnectionError(),                "CONNECTION_ERROR"),
])
def test_reachability_false_only_on_transport_failure(exc, cat):
    with patch.object(bw.requests, "get", side_effect=exc):
        ok, advisory = bw.check_supabase_reachable(URL, PUB_KEY)
    assert ok is False
    assert advisory == cat


# ---------------------------------------------------------------------------
# 4. A 401 from /rest/v1/ ALONE must not force demo mode
# ---------------------------------------------------------------------------
def test_rest_v1_401_alone_does_not_force_demo(monkeypatch):
    """/rest/v1/ answers 401 (expected with publishable key), but signed
    worker-ingest succeeds → worker MUST reach paper mode."""
    _base_env(monkeypatch)
    rest_401 = _http_response(401, {"message": "Secret API key required"})
    ingest_ok = _http_response(200, {"ok": True, "configs": []})

    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw.requests, "get", return_value=rest_401), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post", return_value=ingest_ok):
        bot = bw.RailwayTurtleBot()

    assert bot.mode == "paper"
    assert bot.credentials_ok is True
    assert bot.ingest is not None


# ---------------------------------------------------------------------------
# 5. Valid signed heartbeat + config read → demo → paper
# ---------------------------------------------------------------------------
def test_valid_heartbeat_and_config_read_promotes_to_paper(monkeypatch):
    _base_env(monkeypatch)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post",
                      return_value=_http_response(200, {"ok": True, "configs": []})):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "paper"
    assert bot.credentials_ok is True


# ---------------------------------------------------------------------------
# 6. Invalid HMAC (401 from worker-ingest) → stays demo, no retry
# ---------------------------------------------------------------------------
def test_invalid_hmac_stays_demo_no_retry(monkeypatch):
    _base_env(monkeypatch)
    post = MagicMock(return_value=_http_response(401, {"error": "INVALID_SIGNATURE"}))
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(wic.requests, "post", post):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.credentials_ok is False
    assert bot.ingest is None
    # Heartbeat = 1 attempt (no retry on auth), no config read (aborted).
    assert post.call_count == 1


# ---------------------------------------------------------------------------
# 7. Missing WORKER_INGEST_SHARED_SECRET → stays demo (config error)
# ---------------------------------------------------------------------------
def test_missing_shared_secret_stays_demo(monkeypatch):
    _base_env(monkeypatch, secret=False)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.credentials_ok is False
    assert bot.ingest is None
    assert "worker-ingest not configured" in bot.status_message


# ---------------------------------------------------------------------------
# 8. Transient 5xx from worker-ingest → stays demo (but retries at transport)
# ---------------------------------------------------------------------------
def test_transient_5xx_stays_demo_with_retries(monkeypatch):
    _base_env(monkeypatch)
    post = MagicMock(return_value=_http_response(503, {"error": "SERVICE_UNAVAILABLE"}))
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(wic.time, "sleep", lambda _s: None), \
         patch.object(wic.requests, "post", post):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.credentials_ok is False
    # 5xx is transient → the client retried (3 attempts) before raising.
    assert post.call_count >= 2


# ---------------------------------------------------------------------------
# 9. try_recover() must not raise AttributeError when __init__ returned
#    early on URL validation failure.
# ---------------------------------------------------------------------------
def test_try_recover_safe_after_url_validation_failure(monkeypatch):
    """A bad SUPABASE_URL aborts __init__ before api_key is assigned.
    try_recover() must return False cleanly, not AttributeError."""
    monkeypatch.setenv("SUPABASE_URL", "https://${SUPABASE_PROJECT_ID}.supabase.co")
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        monkeypatch.delenv(name, raising=False)
    for name in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BROKER_SIGNING_SECRET", raising=False)

    bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.supabase_url == ""
    # Stage 0.5: no `service_role` attribute — `api_key` is the sole holder.
    assert hasattr(bot, "api_key")
    assert bot.api_key == ""
    assert not hasattr(bot, "service_role")

    bot._last_connectivity_check = -1e9
    assert bot.try_recover() is False



# ---------------------------------------------------------------------------
# 10. Worker never sets self.mode = "live" under any tested path
# ---------------------------------------------------------------------------
def test_worker_never_enters_live_mode(monkeypatch):
    _base_env(monkeypatch)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_200")), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post",
                      return_value=_http_response(200, {"ok": True, "configs": []})):
        bot = bw.RailwayTurtleBot()
    assert bot.mode != "live"
    assert bot.mode == "paper"


# ---------------------------------------------------------------------------
# 11. Empty ACTIVE_CONFIG_READ list is a valid success → still promotes
# ---------------------------------------------------------------------------
def test_empty_config_list_still_promotes_to_paper(monkeypatch):
    _base_env(monkeypatch)
    # Ingest response has an empty configs list — must NOT be treated as failure.
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post",
                      return_value=_http_response(200, {"ok": True, "configs": []})):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "paper"
    assert bot.credentials_ok is True


# ---------------------------------------------------------------------------
# Bonus: recovery path also uses the new probe semantics correctly
# ---------------------------------------------------------------------------
def test_recovery_from_demo_via_new_probe(monkeypatch):
    """DNS fails at init → try_recover restores host reachability +
    signed worker-ingest → promotes to paper."""
    _base_env(monkeypatch)
    with patch.object(bw.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "fail")), \
         patch.object(bw.time, "sleep", lambda _s: None):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"

    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, "HTTP_401")), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post",
                      return_value=_http_response(200, {"ok": True, "configs": []})):
        bot._last_connectivity_check = -1e9
        assert bot.try_recover() is True
    assert bot.mode == "paper"
