"""Audits and responses never carry api_key/secret/passphrase/signature."""
from __future__ import annotations

import inspect

import app.execution as execution
import app.main as main
import app.orders_v3 as orders_v3


LEAKS = ("api_secret", "APEX-SIGNATURE", "passphrase", "seeds", "encrypted_credentials")


def test_orders_v3_logs_only_classified_reject_metadata():
    src = inspect.getsource(orders_v3)
    # The module may log a stable endpoint/code/category for operations, but
    # must never put credentials, signatures, headers, or raw bodies in the
    # log call.
    assert "apex reject endpoint=%s code=%s category=%s" in src
    assert "log.info" not in src and "log.debug" not in src


def test_execution_never_writes_signature_to_audit():
    src = inspect.getsource(execution)
    # The pipeline consumes `signature` but never stores it as audit
    # metadata — the audit rows are written by main.py via order_store,
    # which passes only sanitized dicts.
    for bad in ("insert_audit", "log."):
        assert bad not in src, f"execution.py must not persist audit or log directly: {bad}"


def test_close_position_forces_reduce_only_string():
    src = inspect.getsource(main.close_position_endpoint)
    # A regression that dropped reduceOnly=true would silently allow
    # position increases — assert the literal is in the emitted payload.
    assert '"reduceOnly": "true"' in src


def test_sign_order_still_has_no_transmission_path():
    """The pre-existing invariant: /v1/sign-order is dry-run only."""
    src = inspect.getsource(main.sign_order)
    for bad in ("requests.post", "requests.put", "create_order_v3",
                "httpx.", "session.post", "urlopen",
                "orders_v3.create_order"):
        assert bad not in src, f"submission path leaked into sign_order: {bad}"
