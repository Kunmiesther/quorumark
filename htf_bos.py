"""1h Break-of-Structure detector — live-worker mirror of
`src/lib/paper/htfBos.ts`.

DEBT-06 promotion pathway (Python side). Reuses accumulator_signal.evaluate
(the same primitive that carries the BOS-significance filter), so a
sub-threshold poke can never confirm on either side.

Aggregation of 5m → 1h candles happens here (mirrors htfCandles.aggregate1h
in TS). Only COMPLETED hour buckets are emitted.

Consumers: bot_worker.py HTF promotion pass — when an open position is
profitable AND `state` matches the position's direction, emit promotion
directives (promote_runner + cancel_fixed_tp + set_breakeven_stop).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

import accumulator_signal as _sig
from accumulator_signal import Candle, TS, OPEN, HIGH, LOW, CLOSE, VOLUME

HOUR_MS = 60 * 60 * 1000
FOUR_HOUR_MS = 4 * HOUR_MS


MIN_HTF_CANDLES_FOR_BOS = (
    max(_sig.ATR_PERIOD, _sig.EMA_PERIOD) + _sig.PIVOT_LEFT + _sig.PIVOT_RIGHT + 1
)


HtfBosState = str  # "bullish_bos" | "bearish_bos" | "none"


@dataclass
class HtfBosResult:
    state: HtfBosState
    confirmed_at_ts: Optional[int]
    broken_level: Optional[float]
    bars_since_confirm: Optional[int]


def aggregate_1h(candles_5m: Sequence[Candle]) -> List[list]:
    """Aggregate ascending 5m candles into COMPLETED 1h buckets."""
    buckets: dict[int, list] = {}
    order: list[int] = []
    for c in candles_5m:
        ts = int(c[TS])
        hour = (ts // HOUR_MS) * HOUR_MS
        if hour not in buckets:
            buckets[hour] = [hour, float(c[OPEN]), float(c[HIGH]), float(c[LOW]), float(c[CLOSE]), float(c[VOLUME])]
            order.append(hour)
        else:
            b = buckets[hour]
            b[HIGH] = max(b[HIGH], float(c[HIGH]))
            b[LOW] = min(b[LOW], float(c[LOW]))
            b[CLOSE] = float(c[CLOSE])
            b[VOLUME] += float(c[VOLUME])
    # Only completed hours: drop the most-recent bucket if it lacks 12 sub-candles.
    if not order:
        return []
    counts: dict[int, int] = {}
    for c in candles_5m:
        h = (int(c[TS]) // HOUR_MS) * HOUR_MS
        counts[h] = counts.get(h, 0) + 1
    completed = [buckets[h] for h in order if counts.get(h, 0) >= 12]
    return completed


def aggregate_4h(candles_5m: Sequence[Candle]) -> List[list]:
    """Aggregate ascending 5m candles into COMPLETED 4h buckets.

    Mirrors `aggregate4h` in src/lib/paper/htfCandles.ts. Used by the sweep
    leg's HTF direction-alignment filter (owner directive 2026-07-26).
    """
    buckets: dict[int, list] = {}
    order: list[int] = []
    for c in candles_5m:
        ts = int(c[TS])
        bkt = (ts // FOUR_HOUR_MS) * FOUR_HOUR_MS
        if bkt not in buckets:
            buckets[bkt] = [bkt, float(c[OPEN]), float(c[HIGH]), float(c[LOW]), float(c[CLOSE]), float(c[VOLUME])]
            order.append(bkt)
        else:
            b = buckets[bkt]
            b[HIGH] = max(b[HIGH], float(c[HIGH]))
            b[LOW] = min(b[LOW], float(c[LOW]))
            b[CLOSE] = float(c[CLOSE])
            b[VOLUME] += float(c[VOLUME])
    if not order:
        return []
    counts: dict[int, int] = {}
    for c in candles_5m:
        b = (int(c[TS]) // FOUR_HOUR_MS) * FOUR_HOUR_MS
        counts[b] = counts.get(b, 0) + 1
    return [buckets[h] for h in order if counts.get(h, 0) >= 48]




def detect_htf_bos(htf_candles: Sequence[Candle], tick: float) -> HtfBosResult:
    """Given completed 1h candles + symbol tick, return the current HTF BOS
    state. `none` if too few candles or no confirmed break yet."""
    none = HtfBosResult("none", None, None, None)
    if len(htf_candles) < MIN_HTF_CANDLES_FOR_BOS:
        return none

    long_eval = _sig.evaluate(htf_candles, "long", tick)
    short_eval = _sig.evaluate(htf_candles, "short", tick)

    events = []
    long_breaks = getattr(long_eval, "breaks", None) or long_eval.get("breaks", [])  # type: ignore[union-attr]
    short_breaks = getattr(short_eval, "breaks", None) or short_eval.get("breaks", [])  # type: ignore[union-attr]
    for be in long_breaks:
        events.append((int(be.break_ts), int(be.break_index), "long", float(be.swing.level)))
    for be in short_breaks:
        events.append((int(be.break_ts), int(be.break_index), "short", float(be.swing.level)))
    if not events:
        return none

    events.sort(key=lambda e: (e[0], e[1]))
    ts, idx, direction, level = events[-1]
    newest = len(htf_candles) - 1
    return HtfBosResult(
        state="bullish_bos" if direction == "long" else "bearish_bos",
        confirmed_at_ts=ts,
        broken_level=level,
        bars_since_confirm=newest - idx,
    )
