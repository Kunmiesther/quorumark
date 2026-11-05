"""Typed operation allowlist for the broker → signer contract.

The signer accepts a fixed set of typed operations. Endpoint paths,
Python function names, and raw executable payloads are NEVER accepted
from the broker.

Read operations are enabled once the signer service is deployed;
execution operations stay OFF behind APEX_MAINNET_SIGNER_ENABLED and
APEX_MAINNET_CANARY_ENABLED and are gated in `app/main.py`.
"""
from __future__ import annotations

from typing import Optional

ALLOWED_OPERATIONS = frozenset({
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

# Feature-flag matrix. Read operations are safe to enable on deploy.
# Every write / execution operation stays disabled until the owner turns
# on APEX_MAINNET_SIGNER_ENABLED (build + sign) or APEX_MAINNET_CANARY_ENABLED
# (submit). This code path is the sole authority — do not gate on symbols
# or venue strings.
OPERATION_ENABLED = {
    "VERIFY_CREDENTIALS": True,
    "READ_ACCOUNT": True,
    "READ_MARKETS": True,
    "READ_ORDERS": True,
    "READ_POSITIONS": True,
    "READ_CAPITAL": True,
    "BUILD_ORDER": True,
    "SIGN_ORDER": True,
    "CREATE_ORDER": True,
    "CANCEL_ORDER": True,
    "CANCEL_ALL_ORDERS": True,
    "CLOSE_POSITION": True,
    "CLOSE_ALL_POSITIONS": True,
    "RECONCILE": True,
    "MOVE_FUNDING_TO_PERPS": True,
    "MOVE_PERPS_TO_FUNDING": True,
}


def is_allowed(operation: Optional[str]) -> bool:
    return isinstance(operation, str) and operation in ALLOWED_OPERATIONS


def is_enabled(operation: Optional[str]) -> bool:
    return is_allowed(operation) and OPERATION_ENABLED[operation]  # type: ignore[index]
