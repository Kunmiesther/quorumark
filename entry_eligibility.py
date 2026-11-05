"""Which confirmed entry may create an order intent. EXACTLY ONE, OR NONE.

WHY THIS MODULE EXISTS — read before changing anything here
-----------------------------------------------------------
`accumulator_signal.evaluate()` returns `entries`: EVERY confirmed retest
across the FULL 198-candle lookback. It is a description of the window, NOT a
list of things to trade.

Live evidence, 2026-07-17 — four consecutive observations:

    04:37:31  long=5  short=10
    04:40:03  long=5  short=10
    04:45:05  long=5  short=10
    04:50:06  long=5  short=10

Identical across four different candles, because they are the SAME historical
confirmations re-derived as the window slides. A worker that created an intent
per element of `entries` would retrade ~15 historical entries EVERY CYCLE,
forever. That is the single most dangerous misreading available in this
codebase, and it looks completely reasonable in a diff.

THE RULE (owner requirement, 2026-07-17)
----------------------------------------
An order may be created ONLY for a confirmation tied to the NEWEST COMPLETED
CANDLE. Historical confirmed entries must NEVER create or recreate intents.
Sliding-window changes must never turn an old entry into a new one.

Eligibility is therefore an identity question, not a recency heuristic:
    retest_index == len(candles) - 1
The retest must have confirmed ON the newest completed candle — not near it,
not recently, ON it. Anything else is history.

`entry_key()` is the cross-cycle identity of a confirmation. It is anchored to
absolute TIMESTAMPS, never to indices: an index means a different candle on
every cycle as the window slides, so an index-keyed dedup would silently
re-admit the same trade under a new number.
"""
from __future__ import annotations

from typing import Optional, Sequence

import accumulator_signal as sig


def entry_key(symbol: str, interval_min: int, retest) -> tuple:
    """Cross-cycle identity of a confirmation. TIMESTAMP-anchored.

    Indices shift every cycle as the window slides; timestamps do not. Keying
    on an index would let the same confirmation return under a new number.
    """
    return (
        symbol,
        int(interval_min),
        int(retest.break_event.break_ts),   # which break
        int(retest.retest_ts),              # which confirmation
        retest.break_event.direction,
    )


def newly_confirmed_entry(result: dict, candles: Sequence) -> Optional[object]:
    """The single entry eligible to create an intent, or None.

    Returns a confirmed RetestResult ONLY if it confirmed on the newest
    completed candle. Everything else in `entries` is history.
    """
    if not candles:
        return None
    newest_index = len(candles) - 1
    newest_ts = int(candles[newest_index][sig.TS])
    for r in result.get("entries", []) or []:
        if r.state != "confirmed":
            continue
        if r.retest_index is None:
            continue
        # BOTH must hold. The index says "at the edge"; the timestamp says
        # "this exact candle". Requiring both means a re-indexed window cannot
        # promote an old entry.
        if int(r.retest_index) == newest_index and int(r.retest_ts) == newest_ts:
            return r
    return None


def eligible_entries(result: dict, candles: Sequence) -> list:
    """0 or 1 elements. Never more. A list only so callers cannot forget the
    'or none' case by unpacking."""
    r = newly_confirmed_entry(result, candles)
    return [r] if r is not None else []
