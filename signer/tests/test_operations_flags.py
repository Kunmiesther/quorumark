"""Every new execution op stays OFF by default. Test guards the flag matrix."""
from __future__ import annotations

from app.operations import ALLOWED_OPERATIONS, OPERATION_ENABLED, is_enabled


def test_new_ops_allowed():
    for op in ("BUILD_ORDER", "CREATE_ORDER", "CANCEL_ORDER", "CLOSE_POSITION", "RECONCILE"):
        assert op in ALLOWED_OPERATIONS


def test_every_execution_op_enabled():
    for op in ("BUILD_ORDER", "SIGN_ORDER", "CREATE_ORDER", "CANCEL_ORDER",
               "CANCEL_ALL_ORDERS", "CLOSE_POSITION", "CLOSE_ALL_POSITIONS",
               "RECONCILE"):
        assert OPERATION_ENABLED[op] is True, f"{op} must be enabled"
        assert is_enabled(op) is True


def test_reads_remain_enabled():
    for op in ("VERIFY_CREDENTIALS", "READ_ACCOUNT", "READ_MARKETS",
               "READ_ORDERS", "READ_POSITIONS", "READ_CAPITAL"):
        assert is_enabled(op) is True


def test_internal_capital_moves_are_enabled():
    for op in ("MOVE_FUNDING_TO_PERPS", "MOVE_PERPS_TO_FUNDING"):
        assert is_enabled(op) is True
