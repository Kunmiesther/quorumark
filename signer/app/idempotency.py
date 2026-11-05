"""Idempotency for order signing.

ROLE: FAST PRE-CHECK IN FRONT OF THE DATABASE CONSTRAINT
-------------------------------------------------------
Durable idempotency is ALREADY enforced by the schema (verified in
pg_indexes, 2026-07-17 — pg_constraint does NOT list CREATE UNIQUE INDEX,
which is why an earlier check wrongly reported these as absent):

    orders_conn_client_order_id_uniq
        UNIQUE (connection_id, client_order_id)
    order_intents_user_id_client_order_id_key
        UNIQUE (user_id, client_order_id)
    order_audit_conn_idem_phase_uniq
        UNIQUE (connection_id, idempotency_key, phase) WHERE idempotency_key IS NOT NULL

The DATABASE is the authority. It holds across restarts and replicas; this
cache does not. This module exists only to reject a conflicting replay
cheaply, before doing zk work — it is an optimisation and a clear error
message, NOT the control.

Two rules follow:
  * A cache MISS means "unknown here", never "safe to sign". The durable
    check against orders / order_intents still runs.
  * This cache must never be the reason a signature is produced. It may only
    be a reason one is REFUSED.

Do not add a competing idempotency store. `public.order_intents` already
models intent -> reconcile (see order_intents_reconcile_idx), and
`public.order_audit` already models idempotency phases. Building beside them
creates two sources of truth for whether an order exists, which is the exact
hazard idempotency is meant to prevent.

No request parameter is stored in plaintext: the fingerprint is a salted
digest, so the cache cannot become a record of what was traded.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Optional

# Bounded. An unbounded idempotency cache is a memory leak with extra steps.
MAX_ENTRIES = 4096
TTL_SECONDS = 24 * 3600

_SALT_ENV = "APEX_IDEMPOTENCY_SALT"


class IdempotencyConflict(Exception):
    """Same client_order_id, different parameters. NEVER sign this."""

    code = "IDEMPOTENCY_CONFLICT"


@dataclass(frozen=True)
class Entry:
    fingerprint: str
    status: str
    created_at: float


def _salt() -> bytes:
    # Not a secret-grade control; it stops the cache being a plaintext ledger
    # of orders if a process dump is ever captured.
    return os.environ.get(_SALT_ENV, "apex-signer-idempotency").encode()


def request_fingerprint(payload: dict) -> str:
    """Salted digest over the ORDER-DEFINING fields only.

    Deliberately excludes `is_live`: flipping canary on must not make a
    replayed id look like a new order.
    """
    material = {
        k: payload.get(k)
        for k in ("credential_id", "symbol", "side", "order_type", "size", "price", "reduce_only")
    }
    blob = json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(_salt() + blob).hexdigest()[:32]


class IdempotencyCache:
    def __init__(self, max_entries: int = MAX_ENTRIES, ttl: int = TTL_SECONDS) -> None:
        self._d: dict[str, Entry] = {}
        self._lock = threading.Lock()
        self._max = max_entries
        self._ttl = ttl

    def _prune(self, now: float) -> None:
        for k in [k for k, v in self._d.items() if now - v.created_at > self._ttl]:
            del self._d[k]
        if len(self._d) > self._max:
            for k, _ in sorted(self._d.items(), key=lambda kv: kv[1].created_at)[
                : len(self._d) - self._max
            ]:
                del self._d[k]

    def check(self, client_order_id: str, fingerprint: str) -> Optional[Entry]:
        """Return the prior entry on exact replay, None if unseen.
        Raise IdempotencyConflict if the id was reused with other params."""
        now = time.time()
        with self._lock:
            self._prune(now)
            prev = self._d.get(client_order_id)
            if prev is None:
                return None
            if prev.fingerprint != fingerprint:
                raise IdempotencyConflict(IdempotencyConflict.code)
            return prev

    def record(self, client_order_id: str, fingerprint: str, status: str) -> None:
        with self._lock:
            self._d[client_order_id] = Entry(fingerprint, status, time.time())
            self._prune(time.time())
