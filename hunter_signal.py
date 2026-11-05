"""HUNTER strategy — high-volatility FVG signal detection.

Pure detection module. No I/O, no orders. Independent from Accumulator.

Definitions (owner spec, this session):
  * Volatility gate: Wilder ATR(14) > K * SMA(ATR(14), 20).
  * Fair Value Gap (3-candle):
      bullish FVG at index i (middle candle) when candles[i-1].high < candles[i+1].low
      bearish FVG at index i when                 candles[i-1].low  > candles[i+1].high
    Gap zone:
      bullish -> [candles[i-1].high, candles[i+1].low]
      bearish -> [candles[i+1].high, candles[i-1].low]
  * A FVG is CONFIRMED at index i+1 (right-side candle closed), so signals
    reference confirm_index = i+1. Entry evaluation uses candles AFTER confirm.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

from shared.parity_constants import get as _pc_get
ATR_PERIOD = _pc_get("hunter", "atr_period")
ATR_SMA_PERIOD = _pc_get("hunter", "atr_sma_period")
PIVOT_LEFT = _pc_get("hunter", "pivot_left")
PIVOT_RIGHT = _pc_get("hunter", "pivot_right")


def true_ranges(candles) -> List[float]:
    out = []
    for i, c in enumerate(candles):
        hi, lo = float(c[HIGH]), float(c[LOW])
        if i == 0:
            out.append(hi - lo); continue
        pc = float(candles[i-1][CLOSE])
        out.append(max(hi - lo, abs(hi - pc), abs(lo - pc)))
    return out


def wilder_atr(candles, period: int = ATR_PERIOD) -> List[Optional[float]]:
    n = len(candles)
    out: List[Optional[float]] = [None] * n
    if n < period:
        return out
    tr = true_ranges(candles)
    seed = sum(tr[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, n):
        prev = ((period - 1) * prev + tr[i]) / period
        out[i] = prev
    return out


def sma_of(series: List[Optional[float]], period: int) -> List[Optional[float]]:
    n = len(series)
    out: List[Optional[float]] = [None] * n
    for i in range(n):
        if i + 1 < period:
            continue
        window = series[i + 1 - period: i + 1]
        if any(x is None for x in window):
            continue
        out[i] = sum(window) / period  # type: ignore
    return out


@dataclass
class FVG:
    direction: str          # 'bullish' | 'bearish'
    middle_index: int       # i
    confirm_index: int      # i+1
    confirm_ts: int
    gap_lower: float
    gap_upper: float
    atr_at_confirm: float
    atr_sma_at_confirm: float
    ratio: float            # atr / atr_sma


def find_fvgs(candles, k_threshold: float) -> List[FVG]:
    """All 3-candle FVGs whose confirm candle passes the volatility gate."""
    atr = wilder_atr(candles)
    atr_sma = sma_of(atr, ATR_SMA_PERIOD)
    out: List[FVG] = []
    n = len(candles)
    for i in range(1, n - 1):
        confirm = i + 1
        a = atr[confirm]; s = atr_sma[confirm]
        if a is None or s is None or s <= 0:
            continue
        ratio = a / s
        if ratio < k_threshold:
            continue
        c_prev = candles[i - 1]; c_next = candles[i + 1]
        # Bullish gap
        if c_prev[HIGH] < c_next[LOW]:
            out.append(FVG(
                direction='bullish', middle_index=i, confirm_index=confirm,
                confirm_ts=int(c_next[TS]),
                gap_lower=float(c_prev[HIGH]), gap_upper=float(c_next[LOW]),
                atr_at_confirm=a, atr_sma_at_confirm=s, ratio=ratio,
            ))
        # Bearish gap
        elif c_prev[LOW] > c_next[HIGH]:
            out.append(FVG(
                direction='bearish', middle_index=i, confirm_index=confirm,
                confirm_ts=int(c_next[TS]),
                gap_lower=float(c_next[HIGH]), gap_upper=float(c_prev[LOW]),
                atr_at_confirm=a, atr_sma_at_confirm=s, ratio=ratio,
            ))
    return out


@dataclass
class Swing:
    kind: str   # 'high' | 'low'
    index: int
    level: float


def find_swings(candles) -> List[Swing]:
    out: List[Swing] = []
    n = len(candles)
    for i in range(PIVOT_LEFT, n - PIVOT_RIGHT):
        c = candles[i]
        hi, lo = float(c[HIGH]), float(c[LOW])
        nb = [candles[i-2], candles[i-1], candles[i+1], candles[i+2]]
        if all(hi > float(x[HIGH]) for x in nb):
            out.append(Swing('high', i, hi))
        if all(lo < float(x[LOW]) for x in nb):
            out.append(Swing('low', i, lo))
    return out


def volatility_stats(candles, k_threshold: float) -> dict:
    """How often the gate is open — sanity that the filter really gates."""
    atr = wilder_atr(candles)
    atr_sma = sma_of(atr, ATR_SMA_PERIOD)
    total = 0; hot = 0
    for a, s in zip(atr, atr_sma):
        if a is None or s is None or s <= 0:
            continue
        total += 1
        if a / s >= k_threshold:
            hot += 1
    return {"eligible_candles": total, "hot_candles": hot,
            "hot_fraction": (hot / total) if total else 0.0}
