"""Durable order state: `order_intents` + `order_audit` are the AUTHORITY.

SOURCE OF TRUTH
---------------
`order_intents.state` (enum `order_intent_state`) and `order_audit.phase` are
the only durable record of whether an order exists. The in-process
`IdempotencyCache` may REFUSE early; it may never authorize. Every signing
decision is checked against the database, not the cache.

Durable uniqueness already exists (verified in pg_indexes, 2026-07-17):
    order_intents_user_id_client_order_id_key  UNIQUE (user_id, client_order_id)
    orders_conn_client_order_id_uniq           UNIQUE (connection_id, client_order_id)
A conflicting reuse fails closed at the database with SQLSTATE 23505. No
parallel idempotency store is created here — `order_intents` already models
intent -> reconcile, and duplicating it would create two answers to
"does this order exist", which is the hazard idempotency exists to prevent.

DRY RUN (owner ruling, 2026-07-17)
----------------------------------
`is_live=false` signs locally and DISCARDS the signature. Terminal outcome:
    state        = 'rejected'
    state_reason = 'DRY_RUN_NOT_SUBMITTED'
This is NOT a venue rejection, NOT a risk rejection, and NOT a
reconciliation case. Nothing was ever sent. `DRY_RUN_NOT_SUBMITTED` MUST be
excluded from venue-rejection metrics and alerting — see
`is_venue_rejection()`, which is the single predicate for that filter. Do not
re-derive the test at each call site.

`rejected` is a terminal state, chosen over parking at `signing`: a row left
in a transient state is indistinguishable from a genuine crash mid-submit and
would generate false `reconciliation_required` work against a venue that
never saw the order.

NEVER PERSISTED
---------------
Signatures, seeds, decrypted bundles, and raw payloads never reach this
module's writes. `order_audit.sanitized_response` carries bounded metadata
only.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Optional, Protocol

DRY_RUN_REASON = "DRY_RUN_NOT_SUBMITTED"

# Verified live labels — do not invent.
INTENT_STATES = frozenset({
    "previewed", "confirmed", "queued", "signing", "submitted", "open",
    "partially_filled", "filled", "cancellation_pending", "cancelled",
    "rejected", "reconciliation_required", "failed",
})
AUDIT_PHASES = frozenset({"received", "validated", "rejected", "submitted", "exchange_response"})

# States from which signing may begin. `submitted` and beyond are excluded:
# re-signing something already sent is how you get two positions.
SIGNABLE_STATES = frozenset({"confirmed", "queued"})

DB_TIMEOUT_SECONDS = 5.0
MAX_ATTEMPTS = 3
BACKOFF_BASE = 0.2


class StoreError(Exception):
    """Structured. `code` is static; never contains order or key material."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class StoreTimeout(StoreError):
    pass


class StoreConflict(StoreError):
    """23505 — durable idempotency refused the write. FAIL CLOSED."""


def is_venue_rejection(state: str, state_reason: Optional[str]) -> bool:
    """Single predicate for venue-rejection metrics and alerts.

    A dry run is `rejected` but was never sent, so it is NOT a venue
    rejection. Owner ruling 2026-07-17.
    """
    if state != "rejected":
        return False
    return state_reason not in (DRY_RUN_REASON, "CAMPAIGN_NOT_SUBMITTED", "CAMPAIGN_RESERVATION_INCOMPLETE")


def needs_reconciliation(state: str, state_reason: Optional[str]) -> bool:
    """A dry run must never be swept for reconciliation — nothing was sent."""
    if state == "rejected" and state_reason == DRY_RUN_REASON:
        return False
    return state in ("submitted", "reconciliation_required")


class DbClient(Protocol):
    def fetch_intent(self, user_id: str, client_order_id: str) -> Optional[dict]: ...
    def update_intent(self, intent_id: str, patch: dict) -> None: ...
    def insert_audit(self, row: dict) -> None: ...


@dataclass(frozen=True)
class Intent:
    id: str
    user_id: str
    connection_id: str
    client_order_id: str
    environment: str
    state: str
    reduce_only: bool


class OrderStore:
    def __init__(self, db: DbClient, timeout: float = DB_TIMEOUT_SECONDS,
                 max_attempts: int = MAX_ATTEMPTS, sleep=time.sleep) -> None:
        self._db = db
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._sleep = sleep

    def _retry(self, fn, *a, **k):
        """Bounded retries for TRANSIENT faults only. A conflict is never
        retried — retrying a 23505 just re-refuses, slower."""
        last: Optional[Exception] = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return fn(*a, **k)
            except StoreConflict:
                raise
            except TimeoutError:
                last = StoreTimeout("DB_TIMEOUT")
            except Exception:
                last = StoreError("DB_UNAVAILABLE")
            if attempt < self._max_attempts:
                self._sleep(BACKOFF_BASE * (2 ** (attempt - 1)))
        raise last or StoreError("DB_UNAVAILABLE")

    def load_signable_intent(self, user_id: str, client_order_id: str) -> Intent:
        row = self._retry(self._db.fetch_intent, user_id, client_order_id)
        if not row:
            raise StoreError("INTENT_NOT_FOUND")
        state = row.get("state")
        if state not in INTENT_STATES:
            raise StoreError("INTENT_STATE_UNKNOWN")
        if state not in SIGNABLE_STATES:
            # Includes already-submitted, already-rejected, and dry-run rows.
            raise StoreError("INTENT_NOT_SIGNABLE")
        return Intent(
            id=row["id"], user_id=row["user_id"], connection_id=row["connection_id"],
            client_order_id=row["client_order_id"], environment=row["environment"],
            state=state, reduce_only=bool(row.get("reduce_only", False)),
        )

    def audit(self, intent: Intent, phase: str, *, reject_reason: Optional[str] = None,
              sanitized: Optional[dict] = None) -> None:
        if phase not in AUDIT_PHASES:
            raise StoreError("AUDIT_PHASE_INVALID")
        self._retry(self._db.insert_audit, {
            "user_id": intent.user_id,
            "connection_id": intent.connection_id,
            "idempotency_key": intent.client_order_id,
            "phase": phase,
            "symbol": None,
            "is_live": False,
            "reject_reason": reject_reason,
            # Bounded metadata only. Never signatures, seeds, or payloads.
            "sanitized_response": sanitized or {},
        })

    def mark_signing(self, intent: Intent) -> None:
        self._retry(self._db.update_intent, intent.id, {"state": "signing"})

    def mark_submitted(self, intent: Intent, *, venue_order_id: str,
                       protection_ids: Optional[dict] = None) -> None:
        """Entry accepted by the venue. Persists venue id BEFORE we release."""
        self._retry(self._db.update_intent, intent.id, {
            "state": "submitted",
            "exchange_order_id": str(venue_order_id),
            "exchange_status": "accepted",
        })
        self.audit(intent, "submitted", sanitized={
            "venue_order_id": str(venue_order_id),
            "protection_venue_ids": protection_ids or {},
        })

    def mark_reconciliation_required(self, intent: Intent, reason: str) -> None:
        """Ambiguous submission or protection failure. Never blind-retry."""
        self._retry(self._db.update_intent, intent.id, {
            "state": "reconciliation_required",
            "state_reason": reason,
        })
        self.audit(intent, "rejected", reject_reason=reason, sanitized={
            "requires_reconciliation": True,
        })

    def mark_dry_run(self, intent: Intent) -> None:
        """Terminal dry-run outcome. Owner ruling 2026-07-17.

        Signed locally, deliberately not submitted. The audit row says so in
        words so no reader mistakes it for a venue or risk rejection.
        """
        self._retry(self._db.update_intent, intent.id, {
            "state": "rejected",
            "state_reason": DRY_RUN_REASON,
        })
        self.audit(intent, "rejected", reject_reason=DRY_RUN_REASON, sanitized={
            "outcome": "signed_locally_not_submitted",
            "detail": ("Intent was signed locally inside the signer container and "
                       "deliberately not submitted. The signature was discarded and "
                       "nothing was transmitted to ApeX. Terminal dry-run outcome: "
                       "NOT a venue rejection, NOT a risk rejection, NOT a "
                       "reconciliation case."),
            "submitted_to_venue": False,
            "signature_discarded": True,
            "is_venue_rejection": False,
            "requires_reconciliation": False,
        })
