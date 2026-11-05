"""Idempotency: exact replay is safe, conflicting reuse is refused."""
from __future__ import annotations

import pytest

from app.idempotency import IdempotencyCache, IdempotencyConflict, request_fingerprint

BASE = {
    "credential_id": "cred-1", "symbol": "BTC-USDT", "side": "BUY",
    "order_type": "LIMIT", "size": "0.01", "price": "50000", "reduce_only": False,
}


def test_unseen_id_returns_none():
    assert IdempotencyCache().check("coid-1", request_fingerprint(BASE)) is None


def test_exact_replay_returns_prior_outcome():
    c = IdempotencyCache(); fp = request_fingerprint(BASE)
    c.record("coid-1", fp, "signed_not_submitted")
    got = c.check("coid-1", fp)
    assert got is not None and got.status == "signed_not_submitted"


@pytest.mark.parametrize("field,value", [
    ("size", "0.02"), ("price", "51000"), ("side", "SELL"),
    ("symbol", "ETH-USDT"), ("reduce_only", True), ("order_type", "MARKET"),
    ("credential_id", "cred-2"),
])
def test_conflicting_reuse_is_rejected(field, value):
    """The dangerous case: same id, different order. Must never sign."""
    c = IdempotencyCache()
    c.record("coid-1", request_fingerprint(BASE), "signed_not_submitted")
    conflicting = {**BASE, field: value}
    with pytest.raises(IdempotencyConflict) as e:
        c.check("coid-1", request_fingerprint(conflicting))
    assert e.value.code == "IDEMPOTENCY_CONFLICT"


def test_is_live_does_not_change_fingerprint():
    """Flipping canary must not let a replayed id masquerade as new."""
    assert request_fingerprint({**BASE, "is_live": False}) == request_fingerprint({**BASE, "is_live": True})


def test_fingerprint_is_not_a_plaintext_ledger():
    fp = request_fingerprint(BASE)
    for leak in ("BTC-USDT", "50000", "0.01", "BUY"):
        assert leak not in fp
    assert len(fp) == 32


def test_cache_is_bounded():
    c = IdempotencyCache(max_entries=10)
    for i in range(100):
        c.record(f"coid-{i}", request_fingerprint({**BASE, "size": str(i)}), "signed_not_submitted")
    assert len(c._d) <= 10


def test_ttl_expiry_frees_ids():
    import time as t
    c = IdempotencyCache(ttl=0)
    fp = request_fingerprint(BASE)
    c.record("coid-1", fp, "signed_not_submitted")
    t.sleep(0.01)
    assert c.check("coid-1", fp) is None


def test_module_defers_to_the_database_not_itself():
    """The cache is a pre-check, not the control. Durable uniqueness is
    enforced by orders_conn_client_order_id_uniq and friends (verified in
    pg_indexes). This test previously asserted the OPPOSITE — that no such
    constraint existed — because the original check queried pg_constraint,
    which does not list CREATE UNIQUE INDEX. A test that enforces a false
    claim about the schema is worse than no test."""
    import app.idempotency as m
    d = m.__doc__ or ""
    assert "orders_conn_client_order_id_uniq" in d
    assert "The DATABASE is the authority" in d
    assert "never be the reason a signature is produced" in d
    assert "Do not add a competing idempotency store" in d
    # A miss means "unknown here", never "safe to sign".
    assert IdempotencyCache().check("coid-1", request_fingerprint(BASE)) is None
