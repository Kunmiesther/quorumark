"""Tests for the worker-ingest HMAC client + edge-function invariants.

These tests exercise the pure-Python client (canonical string, HMAC,
retries, auth-vs-transient classification) with a fake HTTP layer, so
they can run without Supabase deployed. They also assert the payload
schema the edge function requires (operation names, event allowlist,
allowed modes/statuses).
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


def _ok(status=200, body=None):
    r = MagicMock(spec=requests.Response)
    r.status_code = status
    r.json.return_value = body if body is not None else {"ok": True}
    return r


def _client():
    return wic.WorkerIngestClient(URL, worker_id=WID, shared_secret=SECRET, key_version="v1")


# --- construction / config -------------------------------------------------
def test_missing_secret_rejected():
    with pytest.raises(wic.WorkerIngestConfigError):
        wic.WorkerIngestClient(URL, worker_id=WID, shared_secret="", key_version="v1")


def test_missing_url_rejected():
    with pytest.raises(wic.WorkerIngestConfigError):
        wic.WorkerIngestClient("", worker_id=WID, shared_secret=SECRET)


def test_whitespace_secret_rejected():
    with pytest.raises(wic.WorkerIngestConfigError):
        wic.WorkerIngestClient(URL, worker_id=WID, shared_secret=" abc ", key_version="v1")


# --- canonical string + HMAC ----------------------------------------------
def test_canonical_string_shape():
    body = b'{"operation":"HEARTBEAT_UPSERT"}'
    s = wic.canonical_string("111", "nonce-abc", "POST", "/worker-ingest", body, WID, "v1")
    parts = s.split("\n")
    assert parts[0] == "111"
    assert parts[1] == "nonce-abc"
    assert parts[2] == "POST"
    assert parts[3] == "/worker-ingest"
    assert parts[4] == hashlib.sha256(body).hexdigest()
    assert parts[5] == WID
    assert parts[6] == "v1"


def test_hmac_matches_openssl_reference():
    """Cross-check: signature must equal HMAC-SHA256(secret, canonical)."""
    body = b"{}"
    ts, nonce = "1700000000", "n" * 32
    s = wic.canonical_string(ts, nonce, "POST", "/worker-ingest", body, WID, "v1")
    expected = hmac.new(SECRET.encode(), s.encode(), hashlib.sha256).hexdigest()
    # Compute via the client's private helper — same math.
    assert wic._hmac_hex(SECRET, s) == expected


# --- request assembly -----------------------------------------------------
def test_heartbeat_sends_signed_headers_and_returns_body():
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok(200, {"ok": True})) as p:
        got = c.heartbeat(status="healthy", mode="paper", version="1.0")
    assert got == {"ok": True}
    p.assert_called_once()
    _, kwargs = p.call_args
    h = kwargs["headers"]
    for k in ("x-worker-id", "x-worker-timestamp", "x-worker-nonce",
              "x-worker-signature", "x-worker-key-version"):
        assert k in h and h[k]
    body = kwargs["data"]
    # HMAC verifies against the exact bytes sent.
    canonical = wic.canonical_string(
        h["x-worker-timestamp"], h["x-worker-nonce"], "POST",
        "/worker-ingest", body, WID, "v1",
    )
    assert h["x-worker-signature"] == hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def test_body_is_canonical_json_with_sorted_keys():
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok()) as p:
        c.emit_event(code="STARTUP", level="info", message="hi", detail={"z": 1, "a": 2})
    body = p.call_args.kwargs["data"]
    parsed = json.loads(body)
    assert parsed["operation"] == "BOT_EVENT_INSERT"
    # Sorted keys guarantee byte-stable body for signature.
    assert body.decode("utf-8").index('"a"') < body.decode("utf-8").index('"z"')


# --- schema validation ----------------------------------------------------
def test_unknown_event_code_rejected_client_side():
    c = _client()
    with pytest.raises(ValueError):
        c.emit_event(code="NOT_AN_ALLOWED_CODE", message="")


def test_bad_mode_rejected_client_side():
    c = _client()
    with pytest.raises(ValueError):
        c.heartbeat(status="healthy", mode="bogus")


def test_bad_status_rejected_client_side():
    c = _client()
    with pytest.raises(ValueError):
        c.heartbeat(status="explosive", mode="paper")


# --- SIGNAL_EVALUATION observational event code ---------------------------
def test_signal_evaluation_code_allowed_client_side():
    """The observational path's only event code. Rejected client-side before
    it was added, which is why it needed adding at all."""
    assert "SIGNAL_EVALUATION" in wic.ALLOWED_EVENT_CODES
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok()) as p:
        c.emit_event(
            code="SIGNAL_EVALUATION", level="info", message="obs",
            detail={"status": "evaluated", "execution_performed": False},
        )
    sent = json.loads(p.call_args.kwargs["data"])
    assert sent["event"] == "SIGNAL_EVALUATION"
    # Still the SAME operation. No new operation was introduced.
    assert sent["operation"] == "BOT_EVENT_INSERT"
    assert sent["detail"]["execution_performed"] is False


def test_signal_evaluation_is_not_a_new_operation():
    """Guard against scope creep: the edge function accepts EXACTLY this fixed
    allowlist and nothing else. SIGNAL_EVALUATION remains a parameter value for
    BOT_EVENT_INSERT, not an operation. The Scout Guardian added three
    paper-simulation ops (positions read + decision/directive writes); none of
    them touch the signer, credentials, or the ApeX write path."""
    src = EDGE_FN.read_text(encoding="utf-8")
    ops_block = re.search(r"const ALLOWED_OPS = new Set\(\[(.*?)\]\)", src, re.S).group(1)
    ops = set(re.findall(r'"([A-Z_]+)"', ops_block))
    assert ops == {
        "HEARTBEAT_UPSERT", "ACTIVE_CONFIG_READ",
        "BOT_EVENT_INSERT", "EXECUTION_GUARD_READ",
        "EXCHANGE_CREDENTIALS_READ_OWNED",
        "OPEN_POSITIONS_READ", "GUARDIAN_DECISION_INSERT",
        "GUARDIAN_DIRECTIVE_UPSERT",
        # Live-Readiness closures.
        "ACCOUNT_EQUITY_READ", "GUARDIAN_RECENT_CLOSES_READ", "SHADOW_LEDGER_INSERT",
        # Owner-triggered proof-of-life command channel.
        "WORKER_COMMAND_CLAIM", "WORKER_COMMAND_COMPLETE",
        # Signer DB proxy ops (the signer runs outside the edge runtime and
        # cannot hold the service role).
        "APEX_CREDENTIAL_FIND_ACTIVE", "EXECUTION_HALTED_CHECK",
        "ORDER_INTENT_INSERT", "ORDER_INTENT_TRANSITION", "ASTER_INTENTS_LIST", "ASTER_ORDER_RECONCILE",
        "ORDER_AUDIT_INSERT", "APEX_CREDENTIAL_AUDIT_INSERT",
        # Decision ledger. Applied by Lovable on 2026-08-01; these were
        # proposal-only until then. Neither touches the signer, a credential,
        # or the ApeX write path — each writes exactly one table.
        "DECISION_UPSERT", "DECISION_EXECUTION_UPDATE",
    }


def test_signal_evaluation_code_allowed_server_side():
    """Server-side allowlist must carry the code too, or every observational
    event returns 400 EVENT_CODE_NOT_ALLOWED."""
    src = EDGE_FN.read_text(encoding="utf-8")
    block = re.search(r"const ALLOWED_EVENT_CODES = new Set\(\[(.*?)\]\)", src, re.S).group(1)
    codes = set(re.findall(r'"([A-Z_]+)"', block))
    assert "SIGNAL_EVALUATION" in codes


def test_account_equity_read_never_routes_aster_credentials_to_apex():
    src = EDGE_FN.read_text(encoding="utf-8")
    handler = src.split("async function handleAccountEquityRead(", 1)[1].split(
        "async function handleExecutionGuardRead(", 1,
    )[0]
    assert handler.index('conn.exchange !== "apex_omni"') < handler.index("loadApexReadCreds(")
    assert 'jsonError(409, "EQUITY_VENUE_UNSUPPORTED"' in handler


# Codes the worker knows about but the DEPLOYED edge function does not yet
# accept. A ledger of pending work, not a permission — it MUST shrink to
# empty once Lovable applies the corresponding proposal.
#
# EMPTY as of 2026-08-01: Lovable applied `docs/supabase-proposals/002_*` and
# STRATEGY_DECISION is now in the live edge allowlist. Client and server are
# in exact lockstep, which is what the test below now enforces with no
# tolerated gap at all.
PENDING_EDGE_EVENT_CODES: set[str] = set()


def test_client_and_edge_event_allowlists_match():
    """Client and server allowlists must stay in lockstep. A code allowed on
    one side only is either a silent 400 at runtime or a client-side gap.

    The single tolerated gap is the explicitly enumerated pending set above;
    any OTHER divergence still fails."""
    src = EDGE_FN.read_text(encoding="utf-8")
    block = re.search(r"const ALLOWED_EVENT_CODES = new Set\(\[(.*?)\]\)", src, re.S).group(1)
    edge_codes = set(re.findall(r'"([A-Z_]+)"', block))
    assert edge_codes == set(wic.ALLOWED_EVENT_CODES) - PENDING_EDGE_EVENT_CODES


def test_the_pending_set_is_actually_pending_and_not_a_permanent_exemption():
    """Every pending code must exist in the PROPOSAL, or it is not pending —
    it is a code nobody has written the server side for."""
    proposal = open("docs/supabase-proposals/002_worker_ingest_index.proposed.ts").read()
    for code in PENDING_EDGE_EVENT_CODES:
        assert f'"{code}"' in proposal, code


def test_unknown_code_still_rejected_server_side():
    src = EDGE_FN.read_text(encoding="utf-8")
    block = re.search(r"const ALLOWED_EVENT_CODES = new Set\(\[(.*?)\]\)", src, re.S).group(1)
    codes = set(re.findall(r'"([A-Z_]+)"', block))
    assert "NOT_AN_ALLOWED_CODE" not in codes
    assert "SIGNAL_OBSERVED" not in codes  # near-miss spelling must not sneak in
    # The rejection branch is still present and still returns 400.
    assert 'if (!ALLOWED_EVENT_CODES.has(code)) return jsonError(400, "EVENT_CODE_NOT_ALLOWED"' in src


def test_server_rejection_of_unknown_code_surfaces_as_auth_error():
    """A 400 from the edge function must be non-retryable at the client."""
    c = _client()
    with patch.object(wic.requests, "post",
                      return_value=_ok(400, {"error": "EVENT_CODE_NOT_ALLOWED"})) as p:
        with pytest.raises(wic.WorkerIngestAuthError) as ei:
            c.emit_event(code="STARTUP", message="x")
    assert "HTTP_400" in str(ei.value)
    assert p.call_count == 1  # never retried


# --- response handling ----------------------------------------------------
def test_401_raises_auth_error_no_retry():
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok(401, {"error": "INVALID_SIGNATURE"})) as p:
        with pytest.raises(wic.WorkerIngestAuthError) as ei:
            c.heartbeat(status="healthy", mode="paper")
    assert "HTTP_401" in str(ei.value)
    assert p.call_count == 1  # never retried


def test_429_retries_then_raises_transient():
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok(429, {"error": "RATE_LIMITED"})), \
         patch.object(wic.time, "sleep", lambda _: None):
        with pytest.raises(wic.WorkerIngestTransientError):
            c.heartbeat(status="healthy", mode="paper")


def test_5xx_retries_then_raises_transient():
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok(503, {"error": "NONCE_STORE_UNAVAILABLE"})), \
         patch.object(wic.time, "sleep", lambda _: None):
        with pytest.raises(wic.WorkerIngestTransientError):
            c.heartbeat(status="healthy", mode="paper")


def test_network_error_retries_then_raises_transient():
    c = _client()
    with patch.object(wic.requests, "post", side_effect=requests.exceptions.ConnectionError()), \
         patch.object(wic.time, "sleep", lambda _: None):
        with pytest.raises(wic.WorkerIngestTransientError):
            c.heartbeat(status="healthy", mode="paper")


def test_400_body_too_large_raises_auth_error():
    """Server rejects oversized body with 413; client also enforces locally."""
    c = _client()
    with patch.object(wic.requests, "post", return_value=_ok(413, {"error": "BODY_TOO_LARGE"})):
        with pytest.raises(wic.WorkerIngestAuthError):
            c.heartbeat(status="healthy", mode="paper")


# --- worker integration: demo/paper transition ----------------------------
def test_worker_stays_demo_without_shared_secret(monkeypatch):
    import bot_worker as bw
    monkeypatch.setenv("SUPABASE_URL", URL)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.delenv("WORKER_INGEST_SHARED_SECRET", raising=False)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, None)):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.ingest is None
    assert bot.credentials_ok is False


def test_worker_enters_paper_with_valid_secret(monkeypatch):
    import bot_worker as bw
    monkeypatch.setenv("SUPABASE_URL", URL)
    for name in bw.RailwayTurtleBot._KEY_VAR_CANDIDATES:
        monkeypatch.delenv(name, raising=False)
    for name in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BROKER_SIGNING_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", SECRET)
    monkeypatch.setenv("WORKER_INGEST_WORKER_ID", WID)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, None)), \
         patch.object(bw, "create_client", return_value=MagicMock()), \
         patch.object(wic.requests, "post", return_value=_ok(200, {"ok": True})):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "paper"
    assert bot.credentials_ok is True
    assert bot.ingest is not None



def test_worker_demotes_on_ingest_auth_failure(monkeypatch):
    """Simulate auth failure at heartbeat probe → stays demo."""
    import bot_worker as bw
    monkeypatch.setenv("SUPABASE_URL", URL)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setenv("WORKER_INGEST_SHARED_SECRET", SECRET)
    with patch.object(bw, "resolve_dns_with_retry", return_value=(True, None)), \
         patch.object(bw, "check_supabase_reachable", return_value=(True, None)), \
         patch.object(wic.requests, "post", return_value=_ok(401, {"error": "INVALID_SIGNATURE"})):
        bot = bw.RailwayTurtleBot()
    assert bot.mode == "demo"
    assert bot.credentials_ok is False
