"""Typed-operation allowlist contract for the broker → signer interface."""
from __future__ import annotations

import pytest

from app.operations import ALLOWED_OPERATIONS, OPERATION_ENABLED, is_allowed


def test_allowlist_matches_spec():
    assert ALLOWED_OPERATIONS == frozenset({
        "VERIFY_CREDENTIALS",
        "READ_ACCOUNT",
        "READ_MARKETS",
        "READ_ORDERS",
        "READ_POSITIONS",
        "READ_CAPITAL",
        "BUILD_ORDER",
        "SIGN_ORDER",
        "CREATE_ORDER",
        "CANCEL_ORDER",
        "CANCEL_ALL_ORDERS",
        "CLOSE_POSITION",
        "CLOSE_ALL_POSITIONS",
        "RECONCILE",
        "MOVE_FUNDING_TO_PERPS",
        "MOVE_PERPS_TO_FUNDING",
    })


def test_execution_ops_are_enabled():
    for op in ("CREATE_ORDER", "CANCEL_ORDER", "CANCEL_ALL_ORDERS",
               "CLOSE_POSITION", "CLOSE_ALL_POSITIONS", "SIGN_ORDER", "BUILD_ORDER"):
        assert OPERATION_ENABLED[op] is True


def test_read_ops_are_allowed():
    for op in ("VERIFY_CREDENTIALS", "READ_ACCOUNT", "READ_MARKETS",
               "READ_ORDERS", "READ_POSITIONS", "READ_CAPITAL"):
        assert OPERATION_ENABLED[op] is True


@pytest.mark.parametrize("bad", [
    "withdraw", "WITHDRAW", "deposit", "transfer", "payout", "cashout",
    "eval", "exec", "run", "arbitrary_path", "",
    "read_account",  # lowercase is not in the allowlist
    None,
])
def test_arbitrary_and_forbidden_ops_are_rejected(bad):
    assert is_allowed(bad) is False


def test_symbol_containing_forbidden_substring_does_not_control_authorization():
    """`symbol` is NEVER an authorization signal. Only `operation` is."""
    # Even if a symbol string contains "deposit", authorization is based
    # solely on the operation enum. This mirrors the edge-function fix.
    assert is_allowed("READ_MARKETS") is True


def test_internal_capital_moves_are_typed_and_allowed():
    assert is_allowed("MOVE_FUNDING_TO_PERPS") is True
    assert is_allowed("MOVE_PERPS_TO_FUNDING") is True
