"""SWEEP (H1) entry adapter — live-worker mirror of the neutral-regime
`sweep` branch in `src/lib/paper/engine.ts`. Pure detection + planning;
no I/O, no orders.

Contract mirrors `hunter_entry`:
  * Consume the SAME completed-candle series and tick size the accumulator
    evaluator sees.
  * Return a plan (fill/stop/tp + dedup key) when the newest candle either
    sweeps + reclaims a liquidity level (rejection) or retests one that
    was swept in the recent window (retest).
  * Return None otherwise with a short reason_code.

Byte-parity with the TS engine is guaranteed by delegating to
`sweep_signal.detect_sweep` (same shared JSON, same math).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import htf_bos
import sweep_signal


@dataclass(frozen=True)
class SweepEntryPlan:
    direction: str          # 'long' | 'short'
    mode: str               # 'rejection' | 'retest'
    fill_px: float
    stop_level: float
    tp_level: float
    swept_level: float
    level_source: str
    stop_pct: float         # |fill - stop| / fill
    dedup_key: str          # per-level-per-mode-per-direction; ts-stamped


def evaluate(
    candles: Sequence[Sequence[float]],
    direction: str,
    tick: float,
) -> tuple[Optional[SweepEntryPlan], str]:
    """Look for a Sweep entry on the NEWEST candle for `direction`.

    Reason codes: sweep_disabled | sweep_no_atr | sweep_no_setup |
                  sweep_wrong_direction | confirmed.
    """
    if direction not in ("long", "short"):
        return None, "sweep_wrong_direction"
    if not sweep_signal.SWEEP_ENABLED:
        return None, "sweep_disabled"

    atr = sweep_signal.atr_series(candles)
    if not atr or atr[-1] is None or atr[-1] <= 0:
        return None, "sweep_no_atr"

    # 1h HTF BOS gate — same signal the TS sweep branch consumes.
    try:
        htf = htf_bos.aggregate_1h(candles)
        bos = htf_bos.detect_htf_bos(htf, tick)
        bos_state = bos.state if bos and bos.state else "none"
    except Exception:
        bos_state = "none"

    entry = sweep_signal.detect_sweep(candles, atr, bos_state, tick)
    if entry is None:
        return None, "sweep_no_setup"
    if entry.direction != direction:
        return None, "sweep_wrong_direction"

    fill_px = float(entry.entry)
    stop_lvl = float(entry.stop)
    tp_lvl = float(entry.tp)
    stop_pct = abs(fill_px - stop_lvl) / fill_px if fill_px else 0.0
    newest_ts = int(candles[-1][sweep_signal.TS])
    dedup_key = (
        f"{direction}:{entry.mode}:{entry.level_source}:"
        f"{round(float(entry.swept_level), 8)}:{newest_ts}"
    )
    return SweepEntryPlan(
        direction=direction,
        mode=entry.mode,
        fill_px=fill_px,
        stop_level=stop_lvl,
        tp_level=tp_lvl,
        swept_level=float(entry.swept_level),
        level_source=str(entry.level_source),
        stop_pct=float(stop_pct),
        dedup_key=dedup_key,
    ), "confirmed"
