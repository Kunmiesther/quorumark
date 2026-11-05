"""HUNTER entry adapter — live-worker mirror of the `hunter` branch in
`src/lib/paper/engine.ts` (~1477-1600). Pure detection + planning; no I/O,
no orders. The caller (bot_worker) is responsible for gating, sizing, and
intent submission.

Contract:
  * Consume the SAME completed-candle series and tick size the accumulator
    evaluator sees.
  * Return a plan (fill/stop/tp/FVG identity + confirm_ts for dedup) when
    the newest candle retraced into a recent volatility-gated FVG that
    matches the requested direction.
  * Return None otherwise, with a short reason_code the caller can log.

Mirrors these constants from the shared parity JSON:
  hunter.k_threshold, hunter.retrace_window
Byte-parity with `src/lib/paper/hunter.ts` FVG detection is guaranteed by
`hunter_signal.find_fvgs` (same JSON, same math).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import hunter_signal
from shared.parity_constants import get as _pc_get

K_THRESHOLD: float = float(_pc_get("hunter", "k_threshold"))
RETRACE_WINDOW: int = int(_pc_get("hunter", "retrace_window"))

TS = hunter_signal.TS
OPEN = hunter_signal.OPEN
HIGH = hunter_signal.HIGH
LOW = hunter_signal.LOW
CLOSE = hunter_signal.CLOSE


@dataclass(frozen=True)
class HunterEntry:
    direction: str           # 'long' | 'short'
    fill_px: float           # worse of touched-gap-edge, capped by candle open
    stop_level: float        # far gap edge (long: gapLower, short: gapUpper)
    tp_level: float          # mirror-TP fallback (1R structural target)
    fvg_confirm_ts: int      # dedup key
    gap_lower: float
    gap_upper: float
    ratio: float             # ATR ratio at FVG confirm (>= K)
    stop_pct: float          # |fill - stop| / fill — what the signer wants


def _mirror_tp_from_stop(fill_px: float, stop_lvl: float, direction: str) -> float:
    """1R mirror TP — matches TS engine `mirrorTpFromStop` fallback."""
    dist = abs(fill_px - stop_lvl)
    return fill_px + dist if direction == "long" else fill_px - dist


def evaluate(
    candles: Sequence[Sequence[float]],
    direction: str,
) -> tuple[Optional[HunterEntry], str]:
    """Look for a Hunter entry on the NEWEST candle.

    Returns (plan, reason_code). `plan` is None whenever the reason code is
    anything other than 'confirmed'. Reason codes mirror the TS engine's
    Hunter telemetry: hunter_no_fvg | hunter_no_retest | hunter_degenerate_gap
    | confirmed.
    """
    n = len(candles)
    if n < 3 or direction not in ("long", "short"):
        return None, "hunter_no_fvg"

    fvgs = hunter_signal.find_fvgs(candles, K_THRESHOLD)
    want_dir = "bullish" if direction == "long" else "bearish"
    newest_idx = n - 1

    # Recent, matching, retrace window not yet expired at newest candle.
    eligible = [
        f for f in fvgs
        if f.direction == want_dir
        and f.confirm_index < newest_idx
        and (newest_idx - f.confirm_index) <= RETRACE_WINDOW
    ]
    if not eligible:
        return None, "hunter_no_fvg"

    # Freshest first (newest confirm wins).
    eligible.sort(key=lambda f: -f.confirm_index)

    newest = candles[-1]
    newest_lo = float(newest[LOW])
    newest_hi = float(newest[HIGH])
    newest_open = float(newest[OPEN])

    picked = None
    entry_raw = 0.0
    for f in eligible:
        if direction == "long" and newest_lo <= f.gap_upper:
            picked = f
            entry_raw = min(f.gap_upper, newest_open)
            break
        if direction == "short" and newest_hi >= f.gap_lower:
            picked = f
            entry_raw = max(f.gap_lower, newest_open)
            break
    if picked is None:
        return None, "hunter_no_retest"

    stop_lvl = picked.gap_lower if direction == "long" else picked.gap_upper
    if direction == "long" and not (stop_lvl < entry_raw):
        return None, "hunter_degenerate_gap"
    if direction == "short" and not (stop_lvl > entry_raw):
        return None, "hunter_degenerate_gap"

    tp_lvl = _mirror_tp_from_stop(entry_raw, stop_lvl, direction)
    stop_pct = abs(entry_raw - stop_lvl) / entry_raw if entry_raw else 0.0

    return HunterEntry(
        direction=direction,
        fill_px=float(entry_raw),
        stop_level=float(stop_lvl),
        tp_level=float(tp_lvl),
        fvg_confirm_ts=int(picked.confirm_ts),
        gap_lower=float(picked.gap_lower),
        gap_upper=float(picked.gap_upper),
        ratio=float(picked.ratio),
        stop_pct=float(stop_pct),
    ), "confirmed"
