"""Re-entry lockout — live-worker mirror of
`src/lib/paper/reentryLockout.ts`.

DEBT-06 addendum. After any Guardian-driven close on (symbol, direction) —
scout_bos / scout_guardian_bos / scout_guardian_cluster — block NEW entries
on that same (symbol, direction) for `entry_lockout.reentry_lockout_candles`
five-minute candles (default 12 → 1 hour). Opposite direction is never
blocked; unrelated symbols are unaffected.

Pure. Reads the shared JSON constant. The worker supplies a bundle of recent
closes (from its ledger read) and the current cycle timestamp.
"""
from __future__ import annotations

from typing import Iterable, Set, Tuple

from shared.parity_constants import get as _pc_get

LOCKOUT_TRIGGER_REASONS = frozenset({
    "scout_bos",
    "scout_guardian_bos",
    "scout_guardian_cluster",
})

REENTRY_LOCKOUT_CANDLES: int = int(_pc_get("entry_lockout", "reentry_lockout_candles"))
INTERVAL_MIN = 5
REENTRY_LOCKOUT_MS: int = REENTRY_LOCKOUT_CANDLES * INTERVAL_MIN * 60_000


def _key(symbol: str, direction: str) -> Tuple[str, str]:
    return (symbol, direction)


def build_lockout_set(trades: Iterable[dict], now_ms: int) -> Set[Tuple[str, str]]:
    """Given an iterable of recent-close rows with fields
    {symbol, direction, exit_reason, closed_at_ms}, return the set of
    (symbol, direction) pairs currently under re-entry lockout."""
    out: Set[Tuple[str, str]] = set()
    for t in trades:
        reason = t.get("exit_reason")
        if reason not in LOCKOUT_TRIGGER_REASONS:
            continue
        direction = t.get("direction")
        if direction not in ("long", "short"):
            continue
        closed = t.get("closed_at_ms")
        try:
            closed_ms = int(closed)
        except (TypeError, ValueError):
            continue
        if now_ms - closed_ms >= REENTRY_LOCKOUT_MS:
            continue
        out.add(_key(t["symbol"], direction))
    return out


def is_locked_out(lockout: Set[Tuple[str, str]], symbol: str, direction: str) -> bool:
    return _key(symbol, direction) in lockout
