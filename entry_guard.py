"""Entry-authorization guard — live-worker mirror of
`src/lib/paper/entryGuard.ts::evaluateEntryAuthorization`.

DEBT-04 closure. Fail-closed on 'wait_regime' and 'opposing_to_open_position'.
Pure — takes the pre-classified regime + leg + symbol, returns
(authorized, block_code, block_detail).

The Python live worker calls this AFTER `regime.classify_regime` +
`routing.leg_for_regime` and BEFORE emitting an entry directive. If a
worker cycle proceeds past a `wait_regime` result, that is a live-side
bug — the return here is authoritative.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# The set of regimes for which NEW entries are never authorized.
_WAIT_REGIMES = frozenset({"reversal_forming", "opposing_to_open_position"})


@dataclass
class EntryGuardResult:
    authorized: bool
    block_code: Optional[str]
    block_detail: Optional[str]


def evaluate_entry_authorization(
    regime: Optional[str],
    leg: Optional[str],
    symbol: str,
) -> EntryGuardResult:
    """Deterministic pre-flight for every candidate open on the live worker.

    Rules:
        * regime in WAIT_REGIMES → blocked (wait_regime)
        * regime is None → blocked (no_regime)
        * leg is None → blocked (no_leg)
        * otherwise → authorized
    """
    if regime in _WAIT_REGIMES:
        return EntryGuardResult(False, "wait_regime", f"regime={regime}; symbol={symbol}")
    if regime is None:
        return EntryGuardResult(False, "no_regime", f"symbol={symbol}")
    if leg is None:
        return EntryGuardResult(False, "no_leg", f"symbol={symbol}; regime={regime}")
    return EntryGuardResult(True, None, None)
