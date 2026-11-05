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
    # Accumulator live-intent bridge outcome (dispatched OR refused before
    # dispatch — `detail.blocked` + `detail.block_code` distinguish them).
    "ACCUMULATOR_INTENT_SUBMITTED",
    # Canonical candidate identity for a naturally detected setup. HISTORICAL:
    # the live path no longer emits this. The signer does not emit it either —
    # this list is a SECURITY-CONSTANT MIRROR of the repo-root client, and
    # `signer/tests/test_worker_ingest_client_parity.py` requires the two to
    # be byte-identical so drift cannot hide a widened event surface.
    "STRATEGY_CANDIDATE_CREATED",
    # One canonical deterministic decision per completed candle, including
    # WAIT. Same mirror rule as above.
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
            if k in ("api_key", "api_secret", "passphrase", "omni_seed",
                     "plaintext_api_key", "plaintext_api_secret", "plaintext_omni_seed"):
                raise WorkerIngestAuthError("PLAINTEXT_LEAK_REJECTED")
        return cred

    # ---- signer DB proxy ops ---------------------------------------------
    # These let the Railway signer read/write only the rows /v1/orders needs
    # without holding SUPABASE_SERVICE_ROLE_KEY. Every op is validated
    # server-side; the signer only asserts the returned shape here.
    def find_active_apex_credential(self, *, user_id: str, exchange_connection_id: str,
                                    environment: str) -> Optional[dict]:
        if not user_id or not exchange_connection_id or not environment:
            raise ValueError("user_id, exchange_connection_id, environment required")
        body = {
            "operation": "APEX_CREDENTIAL_FIND_ACTIVE",
            "user_id": user_id,
            "exchange_connection_id": exchange_connection_id,
            "environment": environment,
        }
        try:
            resp = self._post(body, idempotent=True)
        except WorkerIngestAuthError as e:
            if "HTTP_404" in str(e):
                return None
            raise
        cred = resp.get("credential") if isinstance(resp, dict) else None
        return cred if isinstance(cred, dict) else None

    def check_execution_halted(self, *, user_id: str,
                               connection_id: Optional[str], require_live: bool = False) -> bool:
        """Fail-CLOSED: any transport/auth failure raises so the caller can
        treat it as halted. Never silently returns False."""
        if not user_id:
            raise ValueError("user_id required")
        body = {
            "operation": "EXECUTION_HALTED_CHECK",
            "user_id": user_id,
            "connection_id": connection_id or "",
        }
        if require_live:
            body["require_live"] = True
        resp = self._post(body, idempotent=True)
        if not isinstance(resp, dict) or "halted" not in resp:
            raise WorkerIngestAuthError("MALFORMED_HALTED_RESPONSE")
        if require_live and resp.get("live_entry_checked") is not True:
            raise WorkerIngestAuthError("LIVE_ENTRY_CHECK_UNCONFIRMED")
        return bool(resp["halted"])

    def insert_order_intent_row(self, row: dict) -> Optional[str]:
        body = {"operation": "ORDER_INTENT_INSERT", "row": row}
        resp = self._post(body, idempotent=False)
        return resp.get("id") if isinstance(resp, dict) else None

    def synfutures_campaign_operation(self, **payload):
        # Mutations are never automatically retried. Durable identity/leases
        # reconcile an uncertain response before another dispatch is permitted.
        resp = self._post(payload, idempotent=payload.get("operation") == "SYNFUTURES_CAMPAIGN_CONTEXT")
        if not isinstance(resp, dict) or resp.get("ok") is not True or "result" not in resp:
            raise WorkerIngestAuthError("SYNFUTURES_CAMPAIGN_RESPONSE_UNCONFIRMED")
        return resp["result"]

    def synfutures_account_context(self, *, user_id, connection_id):
        resp = self._post({"operation": "SYNFUTURES_ACCOUNT_CONTEXT", "user_id": user_id,
                           "connection_id": connection_id}, idempotent=True)
        if not isinstance(resp, dict) or not isinstance(resp.get("context"), dict):
            raise WorkerIngestAuthError("SYNFUTURES_CONTEXT_UNCONFIRMED")
        return resp["context"]

    def list_synfutures_transactions(self, *, user_id, connection_id):
        resp = self._post({"operation": "SYNFUTURES_TRANSACTIONS_LIST",
                           "user_id": user_id, "connection_id": connection_id}, idempotent=True)
        if not isinstance(resp, dict) or not isinstance(resp.get("transactions"), list):
            raise WorkerIngestAuthError("SYNFUTURES_JOURNAL_RESPONSE_INVALID")
        return resp["transactions"]

    def reserve_synfutures_transaction(self, *, user_id, connection_id, intent_id, transaction):
        resp = self._post({"operation": "SYNFUTURES_TRANSACTION_RESERVE",
                           "user_id": user_id, "connection_id": connection_id,
                           "intent_id": intent_id, "transaction": transaction}, idempotent=False)
        if not isinstance(resp, dict) or type(resp.get("created")) is not bool or resp.get("tx_hash") != transaction.get("tx_hash"):
            raise WorkerIngestAuthError("SYNFUTURES_RESERVATION_UNCONFIRMED")
        # A replay returns created=False. It NEVER grants another send attempt.
        return resp

    def observe_synfutures_transaction(self, **observation):
        resp = self._post({"operation": "SYNFUTURES_TRANSACTION_OBSERVE", **observation}, idempotent=True)
        if not isinstance(resp, dict) or resp.get("ok") is not True:
            raise WorkerIngestAuthError("SYNFUTURES_OBSERVATION_UNCONFIRMED")

    def list_aster_intents(self, *, user_id, connection_id, symbol=None):
        resp = self._post({"operation": "ASTER_INTENTS_LIST", "user_id": user_id,
                           "connection_id": connection_id, "symbol": symbol}, idempotent=True)
        if not isinstance(resp, dict) or not isinstance(resp.get("intents"), list):
            raise WorkerIngestAuthError("ASTER_LEDGER_RESPONSE_INVALID")
        return resp["intents"]

    def reconcile_aster_order(self, **observation):
        self._post({"operation": "ASTER_ORDER_RECONCILE", **observation}, idempotent=True)

    def transition_order_intent(self, *, intent_id: str, user_id: str,
                                state: str, exchange_order_id: Optional[str] = None,
                                state_reason: Optional[str] = None) -> None:
        body = {
            "operation": "ORDER_INTENT_TRANSITION", "id": intent_id,
            "user_id": user_id, "state": state,
            "exchange_order_id": exchange_order_id,
            "state_reason": state_reason,
        }
        self._post(body, idempotent=False)

    def insert_order_audit_row(self, row: dict) -> None:
        body = {"operation": "ORDER_AUDIT_INSERT", "row": row}
        self._post(body, idempotent=False)

    def insert_apex_credential_audit_row(self, row: dict) -> None:
        body = {"operation": "APEX_CREDENTIAL_AUDIT_INSERT", "row": row}
        self._post(body, idempotent=False)

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
            if r.status_code in (400, 401, 403, 409, 413):
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
