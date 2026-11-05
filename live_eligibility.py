"""Live-execution eligibility for one `active_bot_config` row.

PURE / READ-ONLY. No I/O, no credentials, no venue access.

WHY THIS EXISTS
---------------
`active_bot_config` returns every enabled strategy row the owner has ever
configured, including rows bound to connections that are paper-mode,
unverified, or disconnected. The worker used to run its LIVE legs for all of
them, which produced two observable defects on 2026-07-31:

  * three candidate identities for ONE completed ETH-USDT 5m candle — one per
    connection — because `candidate_id` is (correctly) connection-scoped, and
  * a stream of `CONNECTION_NOT_VERIFIED` order-intent rejections from the two
    connections that could never have executed anything.

Eligibility is fail-closed: a missing, unknown, or malformed field means NOT
eligible. This gate decides participation only; it never widens authority and
every downstream guard (kill switch, broker verification, signer preflight)
still applies unchanged.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

LIVE_MODE = "live"
VERIFIED_STATUS = "verified"


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return False


def _text(value: Any) -> str:
    return str(value).strip().lower() if isinstance(value, str) else ""


def live_execution_block_code(cfg: Optional[Mapping[str, Any]]) -> Optional[str]:
    """Return a static block code, or None when the row may execute live.

    Codes are stable, sanitized tokens safe to persist and display:
      CONFIG_MISSING, CONFIG_NOT_LIVE_MODE, CONNECTION_NOT_VERIFIED,
      PERMISSIONS_NOT_VERIFIED, TRADE_PERMISSION_MISSING.
    """
    if not isinstance(cfg, Mapping):
        return "CONFIG_MISSING"
    if _text(cfg.get("mode")) != LIVE_MODE:
        return "CONFIG_NOT_LIVE_MODE"
    if _text(cfg.get("status")) != VERIFIED_STATUS:
        return "CONNECTION_NOT_VERIFIED"
    if not _truthy(cfg.get("permissions_verified")):
        return "PERMISSIONS_NOT_VERIFIED"
    if not _truthy(cfg.get("permission_trade")):
        return "TRADE_PERMISSION_MISSING"
    return None


def live_execution_eligible(cfg: Optional[Mapping[str, Any]]) -> bool:
    """True only for a live-mode, verified, trade-permitted connection row."""
    return live_execution_block_code(cfg) is None
