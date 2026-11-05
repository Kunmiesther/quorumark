"""HMAC client for the Supabase `worker-ingest` edge function.

This is the ONLY privileged path the Railway worker uses to write heartbeat,
read active config, or emit sanitized events. It never touches the Supabase
Data API directly with the publishable key — that key is only for
non-privileged connectivity checks.

Auth: HMAC-SHA256 over `ts\nnonce\nMETHOD\npath\nsha256hex(body)\nworker_id\nkey_version`
Secret env var: WORKER_INGEST_SHARED_SECRET (separate from every other secret).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any, Optional
from urllib.parse import urlparse

import requests


ALLOWED_EVENT_CODES = {
    "STARTUP", "SHUTDOWN", "MODE_TRANSITION", "EXECUTION_HALTED",
    "KILL_SWITCH_FAIL_CLOSED", "ORDER_INTENT_RESULT",
    "ORDER_INTENT_NETWORK_ERROR", "CONNECTIVITY_DEGRADED",
    "CONNECTIVITY_RECOVERED", "CONFIG_READ", "HEARTBEAT",
    # Observational only. Emitted by the worker's market-data/signal path,
    # which executes nothing. `detail.status` is one of evaluated | skipped |
    # error, and every payload asserts `execution_performed: false`. This is a
    # parameter value for the existing BOT_EVENT_INSERT operation — NOT a new
    # operation. Must stay in lockstep with ALLOWED_EVENT_CODES in
    # supabase/functions/worker-ingest/index.ts or the server returns
    # 400 EVENT_CODE_NOT_ALLOWED.
    "SIGNAL_EVALUATION",
    "MARKET_WATCH",
    # Proof-of-life trade trigger. Emitted once per claimed worker_commands
    # 'test_order' row with the sanitized submit_order_intent outcome. Never
    # carries plaintext credentials or full exchange payloads.
    "PROOF_OF_LIFE_ORDER",
    # Accumulator live-intent bridge outcome. Emitted once per confirmed
    # retest, whether the intent was dispatched or refused before dispatch
    # (`detail.blocked` + `detail.block_code`). Must stay in lockstep with
    # ALLOWED_EVENT_CODES in supabase/functions/worker-ingest/index.ts.
    "ACCUMULATOR_INTENT_SUBMITTED",
    # Canonical candidate identity for a naturally detected setup. HISTORICAL:
    # the live path no longer emits this — see decision_contract.py. The code
    # stays allowlisted so existing rows keep a valid event vocabulary. Must
    # stay in lockstep with ALLOWED_EVENT_CODES in
    # supabase/functions/worker-ingest/index.ts.
    "STRATEGY_CANDIDATE_CREATED",
    # One canonical deterministic decision per completed candle, including
    # WAIT. Purely a record of what the strategy decided; the durable row is
    # written by DECISION_UPSERT, and this event is the human-readable trail.
    "STRATEGY_DECISION",
}
ALLOWED_LEVELS = {"debug", "info", "warn", "error"}
ALLOWED_MODES = {"demo", "paper", "live"}
ALLOWED_STATUSES = {"starting", "healthy", "degraded", "halted", "unknown"}
MAX_MESSAGE_LEN = 500
MAX_BODY_BYTES = 32 * 1024
REQUEST_TIMEOUT = (5, 10)


class WorkerIngestConfigError(Exception):
    """WORKER_INGEST_* env vars missing or malformed. Never contains values."""


class WorkerIngestAuthError(Exception):
    """Auth/schema rejection from the edge function — do NOT retry."""


class WorkerIngestTransientError(Exception):
    """Network, 5xx, or 429 — safe to retry with jitter."""


def _canonical_body(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_hex(secret: str, msg: str) -> str:
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def canonical_string(ts: str, nonce: str, method: str, path: str, body: bytes,
                     worker_id: str, key_version: str) -> str:
    """Exposed for tests. Must match the edge function byte-for-byte."""
    return "\n".join([ts, nonce, method, path, _sha256_hex(body), worker_id, key_version])


class WorkerIngestClient:
    def __init__(self,
                 supabase_url: str,
                 worker_id: Optional[str] = None,
                 shared_secret: Optional[str] = None,
                 key_version: Optional[str] = None) -> None:
        if not supabase_url:
            raise WorkerIngestConfigError("SUPABASE_URL missing")
        secret = shared_secret if shared_secret is not None else os.environ.get("WORKER_INGEST_SHARED_SECRET")
        wid = worker_id if worker_id is not None else os.environ.get("WORKER_INGEST_WORKER_ID", "railway-turtlebot-primary")
        kv = key_version if key_version is not None else os.environ.get("WORKER_INGEST_KEY_VERSION", "v1")
        if not secret or not secret.strip() or secret != secret.strip():
            raise WorkerIngestConfigError("WORKER_INGEST_SHARED_SECRET missing or malformed")
        if not wid or len(wid) > 64:
            raise WorkerIngestConfigError("WORKER_INGEST_WORKER_ID missing or too long")

        parsed = urlparse(supabase_url.rstrip("/"))
        self._endpoint = f"{parsed.scheme}://{parsed.netloc}/functions/v1/worker-ingest"
        self._path = "/worker-ingest"
        self._secret = secret
        self.worker_id = wid
        self.key_version = kv

    # ---- public ops -------------------------------------------------------
    def heartbeat(self, *, status: str, mode: str, version: Optional[str] = None,
                  health: Optional[dict] = None) -> dict:
        if status not in ALLOWED_STATUSES:
            raise ValueError("bad status")
        if mode not in ALLOWED_MODES:
            raise ValueError("bad mode")
        body = {
            "operation": "HEARTBEAT_UPSERT",
            "status": status, "mode": mode,
            "version": version, "health": health or {},
        }
        return self._post(body, idempotent=True)

    def read_active_config(self) -> list[dict]:
        body = {"operation": "ACTIVE_CONFIG_READ"}
        resp = self._post(body, idempotent=True)
        return resp.get("configs", []) or []

    def read_execution_guard(self, *, user_id: str, connection_id: str) -> dict:
        """Signed, server-authorized kill-switch read.

        Returns the parsed guard response dict on HTTP 200; raises
        WorkerIngestAuthError on 4xx/schema failure or WorkerIngestTransientError
        on network/5xx/429. Callers MUST fail closed on any exception AND on
        a returned payload that is missing/false in any expected field.
        """
        if not user_id or not connection_id:
            raise ValueError("user_id and connection_id required")
        body = {
            "operation": "EXECUTION_GUARD_READ",
            "user_id": user_id,
            "connection_id": connection_id,
        }
        # NOT idempotent from a retry standpoint: every checkpoint MUST get a
        # fresh evaluation. If the first HTTP attempt fails, the caller decides
        # (it will fail closed) rather than us silently retrying with the same
        # nonce/timestamp and masking a state change.
        return self._post(body, idempotent=False)

    def read_exchange_credentials_owned(self, *, user_id: str, connection_id: str) -> dict:
        """Signer-only read. Returns the parsed `credential` sub-object of the
        edge-function response, which contains encrypted columns and minimal
        exchange/environment metadata only. Never plaintext.
        """
        if not user_id or not connection_id:
            raise ValueError("user_id and connection_id required")
        body = {
            "operation": "EXCHANGE_CREDENTIALS_READ_OWNED",
            "user_id": user_id,
            "connection_id": connection_id,
        }
        # Signer uses this for verify/read-account; retries are safe because
        # the op is a pure read with no side effect. Bounded by _post's own
        # retry cap and jitter.
        resp = self._post(body, idempotent=True)
        cred = resp.get("credential") if isinstance(resp, dict) else None
        if not isinstance(cred, dict):
            raise WorkerIngestAuthError("MALFORMED_CREDENTIAL_RESPONSE")
        required = ("encrypted_api_key", "encrypted_api_secret",
                    "encryption_version", "exchange", "environment",
                    "connection_status")
        for k in required:
            if k not in cred:
                raise WorkerIngestAuthError("MALFORMED_CREDENTIAL_RESPONSE")
        # Belt-and-suspenders: refuse any field that looks like a plaintext
        # credential leak (server should never send it, but fail closed).
        for k in cred:
            if k in ("api_key", "api_secret", "passphrase",
                     "plaintext_api_key", "plaintext_api_secret"):
                raise WorkerIngestAuthError("PLAINTEXT_LEAK_REJECTED")
        return cred

    def emit_event(self, *, code: str, level: str = "info",
                   message: str = "", user_id: Optional[str] = None,
                   detail: Optional[dict] = None) -> dict:
        if code not in ALLOWED_EVENT_CODES:
            raise ValueError(f"event code not allowed: {code}")
        if level not in ALLOWED_LEVELS:
            raise ValueError("bad level")
        body = {
            "operation": "BOT_EVENT_INSERT",
            "event": code, "level": level,
            "message": message[:MAX_MESSAGE_LEN],
            "user_id": user_id, "detail": detail or {},
        }
        return self._post(body, idempotent=True)

    # ---- Scout Guardian ---------------------------------------------------
    def read_open_positions(self) -> list[dict]:
        """Read every open paper position (non-credential columns). This is the
        Guardian's view of the book — it supervises positions regardless of
        which strategy or user opened them. Pure read; safe to retry."""
        body = {"operation": "OPEN_POSITIONS_READ"}
        resp = self._post(body, idempotent=True)
        pos = resp.get("positions") if isinstance(resp, dict) else None
        return pos if isinstance(pos, list) else []

    def read_account_equity(self, *, user_id: str, connection_id: str) -> dict:
        """Authenticated account-equity read for an OWNED connection.

        Server-side the edge function verifies ownership, decrypts the REST
        credentials, and reads ApeX /api/v3/account-balance in-process. The
        response carries ONLY {total_equity, available_balance, currency} —
        never credentials. Pure read; safe to retry.
        """
        if not user_id or not connection_id:
            raise ValueError("user_id and connection_id required")
        body = {
            "operation": "ACCOUNT_EQUITY_READ",
            "user_id": user_id,
            "connection_id": connection_id,
        }
        resp = self._post(body, idempotent=True)
        if not isinstance(resp, dict):
            raise WorkerIngestAuthError("EQUITY_SHAPE_UNEXPECTED")
        for k in ("api_key", "api_secret", "passphrase"):
            if k in resp:
                raise WorkerIngestAuthError("PLAINTEXT_LEAK_REJECTED")
        return resp

    def read_recent_guardian_closes(self, *, window_ms: Optional[int] = None) -> list[dict]:
        """Return recent guardian-class closes (scout_bos, scout_guardian_bos,
        scout_guardian_cluster) within the last ``window_ms`` ms so the worker
        can build its per-cycle re-entry lockout set. Server clamps the window
        and defaults to ~2× REENTRY_LOCKOUT_CANDLES × 5m if not supplied.

        Returns a list of dicts with keys {symbol, direction, exit_reason,
        closed_at_ms}. Pure read; safe to retry."""
        body: dict[str, Any] = {"operation": "GUARDIAN_RECENT_CLOSES_READ"}
        if window_ms is not None:
            body["window_ms"] = int(window_ms)
        resp = self._post(body, idempotent=True)
        closes = resp.get("closes") if isinstance(resp, dict) else None
        return closes if isinstance(closes, list) else []


    def insert_guardian_decisions(self, decisions: list[dict]) -> dict:
        """Persist a batch of Guardian decisions (incl. 'hold') to the
        onyx_decisions ledger. Each item must carry user_id, correlation_id
        (UUIDs), symbol, side (long|short|flat), decision
        (open|add|close|hold|reject); optional detail/reject_reason/etc."""
        if not decisions:
            raise ValueError("no decisions")
        body = {"operation": "GUARDIAN_DECISION_INSERT", "decisions": decisions}
        # Not retried: onyx_decisions is an append-only ledger, so a silent
        # retry after an ambiguous network failure could double-log. The caller
        # re-derives decisions each cycle, so a dropped batch self-heals.
        return self._post(body, idempotent=False)

    def upsert_guardian_directives(self, directives: list[dict]) -> dict:
        """Enqueue action directives for the paper engine. Idempotent server-
        side (partial unique index on (position_id, directive_type) WHERE
        status='pending'), so re-emitting the same directive each cycle is a
        no-op until the engine consumes it."""
        if not directives:
            raise ValueError("no directives")
        body = {"operation": "GUARDIAN_DIRECTIVE_UPSERT", "directives": directives}
        return self._post(body, idempotent=True)

    def upsert_decision(self, decision: dict) -> dict:
        """Record ONE canonical deterministic decision for one completed candle.

        Idempotent by construction: the server keys on `decision_id` and
        `(connection_id, symbol, candle_close_at)`, ignores duplicates, and
        ALWAYS returns the STORED row's execution state:

            {"ok": True, "decision_id": str, "execution_state": str,
             "stored_direction": str, "stored_reason_code": str,
             "correlation_id": str}

        There is deliberately no `created` flag. Whether THIS call inserted
        the row is not information the caller may act on — two workers racing
        the same candle would each be told something different about a single
        shared fact. `execution_state` is the shared fact, and it reads the
        same from either side of the race.

        `execution_state` is what makes duplicate submission impossible across
        restarts and redeploys: a decision already past `not_reached` has
        been acted on, and the worker must not act on it again. Retried
        safely — the write is an upsert, never an append.
        """
        if not isinstance(decision, dict) or not decision.get("decision_id"):
            raise ValueError("decision requires decision_id")
        body = {"operation": "DECISION_UPSERT", "decision": decision}
        return self._post(body, idempotent=True)

    def update_decision_execution(self, *, decision_id: str, execution_state: str,
                                  reason_code: Optional[str] = None,
                                  safety: Optional[dict] = None,
                                  intent: Optional[dict] = None,
                                  apex_result: Optional[dict] = None) -> dict:
        """Advance ONE decision's execution record.

        The decision itself is immutable; only the execution columns move,
        and only forward. The server refuses a backwards transition, so a
        late-arriving retry can never downgrade a recorded ApeX result.
        """
        if not decision_id:
            raise ValueError("decision_id required")
        body: dict[str, Any] = {
            "operation": "DECISION_EXECUTION_UPDATE",
            "decision_id": decision_id,
            "execution_state": execution_state,
        }
        if reason_code is not None:
            body["reason_code"] = reason_code
        if safety is not None:
            body["safety"] = safety
        if intent is not None:
            body["intent"] = intent
        if apex_result is not None:
            body["apex_result"] = apex_result
        return self._post(body, idempotent=True)

    def insert_shadow_ledger(self, rows: list[dict]) -> dict:
        """Best-effort write into paper_live_shadow_ledger via the signed path.

        `rows` = list of dicts with keys
          {source: 'paper'|'live', cycle_ts_ms, symbol, side, decision,
           reason_code, price?, qty?, correlation_id?, detail?}.

        Server-side operation `SHADOW_LEDGER_INSERT` is scheduled but may not
        yet be enabled: callers MUST swallow WorkerIngestAuthError. The write
        is not required for cycle correctness — only for /shadow surface
        population."""
        if not rows:
            raise ValueError("no rows")
        body = {"operation": "SHADOW_LEDGER_INSERT", "rows": rows}
        return self._post(body, idempotent=True)

    # ---- transport --------------------------------------------------------
    # ---- Proof-of-life trade command channel ------------------------------
    def claim_worker_command(self, *, command: Optional[str] = None) -> Optional[dict]:
        """Atomically consume ONE pending worker_commands row (server-side
        UPDATE ... WHERE status='pending' returns 0 rows on race). When
        `command` is set, only rows of that kind are claimable — required so
        the proof-of-life poll never swallows a strategy_test row (or
        vice-versa)."""
        body: dict = {"operation": "WORKER_COMMAND_CLAIM"}
        if command:
            body["command"] = command
        resp = self._post(body, idempotent=False)
        cmd = resp.get("command") if isinstance(resp, dict) else None
        return cmd if isinstance(cmd, dict) else None

    def complete_worker_command(self, *, command_id: str, status: str,
                                result: Optional[dict] = None,
                                error_message: Optional[str] = None) -> dict:
        """Report the outcome of a claimed command. `status` must be
        'completed' or 'failed'. `result` carries the sanitized submit outcome
        (never plaintext credentials)."""
        if status not in ("completed", "failed"):
            raise ValueError("status must be completed|failed")
        body = {
            "operation": "WORKER_COMMAND_COMPLETE",
            "command_id": command_id,
            "status": status,
            "result": result or {},
            "error_message": error_message,
        }
        return self._post(body, idempotent=True)

    # ---- transport --------------------------------------------------------
    def _post(self, payload: dict, *, idempotent: bool) -> dict:
        body = _canonical_body(payload)
        if len(body) > MAX_BODY_BYTES:
            raise WorkerIngestAuthError("body too large")
        max_attempts = 3 if idempotent else 1
        last_err: Optional[Exception] = None
        for attempt in range(1, max_attempts + 1):
            ts = str(int(time.time()))
            nonce = secrets.token_hex(16)
            sig = _hmac_hex(self._secret, canonical_string(
                ts, nonce, "POST", self._path, body, self.worker_id, self.key_version,
            ))
            headers = {
                "content-type": "application/json",
                "x-worker-id": self.worker_id,
                "x-worker-timestamp": ts,
                "x-worker-nonce": nonce,
                "x-worker-signature": sig,
                "x-worker-key-version": self.key_version,
            }
            try:
                r = requests.post(self._endpoint, data=body, headers=headers, timeout=REQUEST_TIMEOUT)
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
                last_err = WorkerIngestTransientError(f"NETWORK: {type(e).__name__}")
                self._sleep_jitter(attempt)
                continue
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    return {}
            if r.status_code in (401, 403, 400, 413):
                # Never retry auth/schema failures. Never log headers or body.
                code = self._safe_code(r)
                raise WorkerIngestAuthError(f"HTTP_{r.status_code}_{code}")
            if r.status_code == 429 or r.status_code >= 500:
                last_err = WorkerIngestTransientError(f"HTTP_{r.status_code}")
                self._sleep_jitter(attempt)
                continue
            raise WorkerIngestAuthError(f"HTTP_{r.status_code}")
        raise last_err or WorkerIngestTransientError("UNKNOWN")

    @staticmethod
    def _safe_code(r: requests.Response) -> str:
        try:
            j = r.json()
            c = j.get("error") if isinstance(j, dict) else None
            if isinstance(c, str) and c[:40].replace("_", "").replace("-", "").isalnum():
                return c[:40]
        except Exception:
            pass
        return "UNSPECIFIED"

    @staticmethod
    def _sleep_jitter(attempt: int) -> None:
        delay = min(2 ** (attempt - 1), 4) + (secrets.randbelow(500) / 1000.0)
        time.sleep(delay)
