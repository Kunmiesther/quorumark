"""Durable state authority + dry-run terminal semantics."""
from __future__ import annotations

import pytest

from app.order_store import (
    DRY_RUN_REASON, Intent, OrderStore, StoreConflict, StoreError, StoreTimeout,
    is_venue_rejection, needs_reconciliation,
)

INTENT = Intent(id="i1", user_id="u1", connection_id="c1", client_order_id="coid-1",
                environment="mainnet", state="confirmed", reduce_only=False)


class FakeDb:
    def __init__(self, row=None, fail=None, fail_times=0):
        self.row = row; self.fail = fail; self.fail_times = fail_times
        self.calls = 0; self.updates = []; self.audits = []

    def _maybe_fail(self):
        if self.fail and self.calls <= self.fail_times:
            raise self.fail

    def fetch_intent(self, user_id, client_order_id):
        self.calls += 1; self._maybe_fail(); return self.row

    def update_intent(self, intent_id, patch):
        self.calls += 1; self._maybe_fail(); self.updates.append((intent_id, patch))

    def insert_audit(self, row):
        self.calls += 1; self._maybe_fail(); self.audits.append(row)


def store(db, **k):
    return OrderStore(db, sleep=lambda _s: None, **k)


# --- dry run is terminal and NOT a venue rejection -------------------------
def test_dry_run_sets_rejected_with_reason():
    db = FakeDb(); store(db).mark_dry_run(INTENT)
    assert db.updates[0][1] == {"state": "rejected", "state_reason": DRY_RUN_REASON}


def test_dry_run_audit_says_signed_locally_not_submitted():
    db = FakeDb(); store(db).mark_dry_run(INTENT)
    a = db.audits[0]
    assert a["phase"] == "rejected"
    assert a["reject_reason"] == DRY_RUN_REASON
    s = a["sanitized_response"]
    assert s["submitted_to_venue"] is False
    assert s["signature_discarded"] is True
    assert "not submitted" in s["detail"].lower()
    assert "NOT a venue rejection" in s["detail"]


def test_dry_run_excluded_from_venue_rejection_metrics():
    assert is_venue_rejection("rejected", DRY_RUN_REASON) is False
    assert is_venue_rejection("rejected", "INSUFFICIENT_MARGIN") is True
    assert is_venue_rejection("filled", None) is False


def test_dry_run_never_swept_for_reconciliation():
    """Nothing was sent — reconciling against ApeX would be false work."""
    assert needs_reconciliation("rejected", DRY_RUN_REASON) is False
    assert needs_reconciliation("submitted", None) is True
    assert needs_reconciliation("reconciliation_required", None) is True


def test_dry_run_audit_carries_no_signature_or_seed():
    """Check for MATERIAL, not vocabulary. `signature_discarded` legitimately
    contains the word 'signature' — an earlier version of this test tripped on
    its own flag name."""
    import re
    db = FakeDb(); store(db).mark_dry_run(INTENT)
    blob = str(db.audits[0])
    assert not re.search(r"0x[a-fA-F0-9]{32,}", blob), "hex key/seed material"
    assert not re.search(r"\b[a-fA-F0-9]{64,}\b", blob), "bare hex material"
    for k in ("seeds", "l2_key", "private_key", "zk_seed"):
        assert k not in blob


# --- durable state is the authority ---------------------------------------
@pytest.mark.parametrize("state", ["submitted", "open", "filled", "rejected",
                                   "cancelled", "reconciliation_required", "failed"])
def test_non_signable_states_refused(state):
    """Re-signing something already sent is how you get two positions."""
    db = FakeDb(row={**INTENT.__dict__, "state": state})
    with pytest.raises(StoreError) as e:
        store(db).load_signable_intent("u1", "coid-1")
    assert e.value.code == "INTENT_NOT_SIGNABLE"


@pytest.mark.parametrize("state", ["confirmed", "queued"])
def test_signable_states_allowed(state):
    db = FakeDb(row={**INTENT.__dict__, "state": state})
    assert store(db).load_signable_intent("u1", "coid-1").state == state


def test_missing_intent_refused():
    with pytest.raises(StoreError) as e:
        store(FakeDb(row=None)).load_signable_intent("u1", "coid-1")
    assert e.value.code == "INTENT_NOT_FOUND"


def test_unknown_state_refused():
    db = FakeDb(row={**INTENT.__dict__, "state": "banana"})
    with pytest.raises(StoreError) as e:
        store(db).load_signable_intent("u1", "coid-1")
    assert e.value.code == "INTENT_STATE_UNKNOWN"


def test_invalid_audit_phase_refused():
    with pytest.raises(StoreError) as e:
        store(FakeDb()).audit(INTENT, "not_a_phase")
    assert e.value.code == "AUDIT_PHASE_INVALID"


# --- timeouts / retries ----------------------------------------------------
def test_timeout_surfaces_structured_error():
    db = FakeDb(row={**INTENT.__dict__}, fail=TimeoutError(), fail_times=99)
    with pytest.raises(StoreTimeout) as e:
        store(db).load_signable_intent("u1", "coid-1")
    assert e.value.code == "DB_TIMEOUT"


def test_retry_exhaustion_is_bounded():
    db = FakeDb(row={**INTENT.__dict__}, fail=TimeoutError(), fail_times=99)
    with pytest.raises(StoreTimeout):
        store(db, max_attempts=3).load_signable_intent("u1", "coid-1")
    assert db.calls == 3


def test_transient_fault_recovers_within_budget():
    db = FakeDb(row={**INTENT.__dict__}, fail=TimeoutError(), fail_times=2)
    assert store(db, max_attempts=3).load_signable_intent("u1", "coid-1").state == "confirmed"


def test_conflict_is_never_retried():
    """23505 means durable idempotency refused. Retrying re-refuses, slower."""
    db = FakeDb(row={**INTENT.__dict__}, fail=StoreConflict("DUP"), fail_times=99)
    with pytest.raises(StoreConflict):
        store(db, max_attempts=3).load_signable_intent("u1", "coid-1")
    assert db.calls == 1
