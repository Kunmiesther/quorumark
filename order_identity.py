"""Stable broker-sized identities for strategy entries; no execution or I/O."""
import hashlib


def entry_order_key(identity: str) -> str:
    """Keep existing valid keys; compact overlong keys without truncating scope.

    The full identity includes the connection, symbol, direction and signal
    timestamps. Hashing that identity preserves repeatability across restarts
    and avoids collisions caused by truncating the timestamp suffix. Never
    apply this to venue-returned order IDs or historical reconciliation keys.
    """
    if not isinstance(identity, str) or len(identity) < 8:
        raise ValueError("INVALID_ENTRY_IDENTITY")
    if len(identity) <= 64:
        return identity
    return "tb1:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:60]
