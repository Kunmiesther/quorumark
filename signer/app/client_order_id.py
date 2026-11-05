"""Venue-safe client order IDs.

DEFECT THIS FIXES: Turtle Bot builds human-readable idempotency keys such as
`accum:<connection-uuid>:ETHUSDT:short:1785899714`. ApeX Omni rejects those
outright with code 3 / "Invalid client order ID" — the venue accepts only a
short alphanumeric token, and our colon-delimited keys were additionally
truncated in transit, so EVERY live order was refused before it could reach
the matching engine.

`venue_client_id()` maps any internal key to a deterministic, venue-safe
token: same input -> same output, so the venue-side duplicate-clientId guard
still protects against retry duplication. Collisions are not a practical
concern (24 hex chars of SHA-256).
"""
from __future__ import annotations

import hashlib
import re

_ALNUM = re.compile(r"[^A-Za-z0-9]")
_MAX_LEN = 32


def venue_client_id(raw: str | None) -> str | None:
    """Deterministic alphanumeric client order id (<= 32 chars) or None."""
    if raw is None:
        return None
    raw = str(raw)
    if not raw:
        return None
    cleaned = _ALNUM.sub("", raw)
    if cleaned == raw and len(cleaned) <= _MAX_LEN:
        return cleaned
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    prefix = cleaned[:8] or "tb"
    return f"{prefix}{digest}"[:_MAX_LEN]
