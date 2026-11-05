"""Regime classifier — live-worker mirror of `src/lib/paper/regime.ts`.

DEBT-03 closure. Pure. No I/O. Loads thresholds from shared parity JSON.

Same algorithm as the TS implementation:
  - Wilder ADX (period from JSON)
  - Kaufman efficiency ratio (window from JSON)
  - ATR% (uses shared Wilder ATR from accumulator_signal.wilder_atr_series)
  - Hysteresis + N-candle confirmation delay

Both sides read the SAME thresholds under `regime_classifier.*` — no drift.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

from shared.parity_constants import get as _pc_get
from accumulator_signal import wilder_atr_series, Candle, HIGH, LOW, CLOSE

Regime = str  # "trend" | "neutral" | "high_vol"

ADX_PERIOD: int = int(_pc_get("regime_classifier", "adx_period"))
ER_WINDOW: int = int(_pc_get("regime_classifier", "er_window"))
ADX_ENTER: float = float(_pc_get("regime_classifier", "adx_enter"))
ADX_EXIT: float = float(_pc_get("regime_classifier", "adx_exit"))
ER_ENTER: float = float(_pc_get("regime_classifier", "er_enter"))
VOL_ENTER_ATR_PCT: float = float(_pc_get("regime_classifier", "vol_enter_atr_pct"))
VOL_EXIT_ATR_PCT: float = float(_pc_get("regime_classifier", "vol_exit_atr_pct"))
CONFIRM_CANDLES: int = int(_pc_get("regime_classifier", "confirm_candles"))


@dataclass
class RegimeResult:
    regime: Optional[Regime]
    adx: Optional[float]
    efficiency_ratio: Optional[float]
    atr_pct: Optional[float]
    trend_age_candles: int


def adx_series(candles: Sequence[Candle], period: int = ADX_PERIOD) -> List[Optional[float]]:
    n = len(candles)
    out: List[Optional[float]] = [None] * n
    if n < 2 * period + 1:
        return out
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    tr = [0.0] * n
    for i in range(1, n):
        up = float(candles[i][HIGH]) - float(candles[i - 1][HIGH])
        dn = float(candles[i - 1][LOW]) - float(candles[i][LOW])
        plus_dm[i] = up if (up > dn and up > 0) else 0.0
        minus_dm[i] = dn if (dn > up and dn > 0) else 0.0
        h, l = float(candles[i][HIGH]), float(candles[i][LOW])
        pc = float(candles[i - 1][CLOSE])
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))

    sm_tr = sum(tr[1:period + 1])
    sm_plus = sum(plus_dm[1:period + 1])
    sm_minus = sum(minus_dm[1:period + 1])

    dx: List[Optional[float]] = [None] * n

    def _dx() -> float:
        pdi = 0.0 if sm_tr == 0 else 100.0 * (sm_plus / sm_tr)
        mdi = 0.0 if sm_tr == 0 else 100.0 * (sm_minus / sm_tr)
        denom = pdi + mdi
        return 0.0 if denom == 0 else 100.0 * (abs(pdi - mdi) / denom)

    dx[period] = _dx()
    for i in range(period + 1, n):
        sm_tr = sm_tr - sm_tr / period + tr[i]
        sm_plus = sm_plus - sm_plus / period + plus_dm[i]
        sm_minus = sm_minus - sm_minus / period + minus_dm[i]
        dx[i] = _dx()

    seed_end = 2 * period
    if seed_end >= n:
        return out
    adx = sum(dx[period + 1:seed_end + 1]) / period  # type: ignore[operator]
    out[seed_end] = adx
    for i in range(seed_end + 1, n):
        adx = (adx * (period - 1) + dx[i]) / period  # type: ignore[operator]
        out[i] = adx
    return out


def efficiency_ratio_series(candles: Sequence[Candle], window: int = ER_WINDOW) -> List[Optional[float]]:
    n = len(candles)
    out: List[Optional[float]] = [None] * n
    for i in range(window, n):
        net = abs(float(candles[i][CLOSE]) - float(candles[i - window][CLOSE]))
        path = 0.0
        for k in range(i - window + 1, i + 1):
            path += abs(float(candles[k][CLOSE]) - float(candles[k - 1][CLOSE]))
        out[i] = None if path == 0 else net / path
    return out


def _desired(current: Optional[Regime], adx: float, er: float, atr_pct: float) -> Regime:
    if current == "high_vol":
        if atr_pct >= VOL_EXIT_ATR_PCT:
            return "high_vol"
    elif atr_pct >= VOL_ENTER_ATR_PCT:
        return "high_vol"
    if current == "trend":
        return "trend" if adx >= ADX_EXIT else "neutral"
    return "trend" if (adx >= ADX_ENTER and er >= ER_ENTER) else "neutral"


def regime_state_series(candles: Sequence[Candle]) -> List[Optional[Regime]]:
    """Return the committed regime at every candle in one linear pass."""
    n = len(candles)
    adx = adx_series(candles)
    er = efficiency_ratio_series(candles)
    atr = wilder_atr_series(candles)
    current: Optional[Regime] = None
    pending: Optional[Regime] = None
    pending_count = 0
    states: List[Optional[Regime]] = [None] * n
    for i in range(n):
        a, e, at = adx[i], er[i], atr[i]
        close = float(candles[i][CLOSE])
        atr_pct = (at / close) if (at is not None and close > 0) else None
        if a is None or e is None or atr_pct is None:
            states[i] = current
            continue
        desired = _desired(current, a, e, atr_pct)
        if current is None:
            current = desired
            pending, pending_count = None, 0
        elif desired == current:
            pending, pending_count = None, 0
        else:
            if desired == pending:
                pending_count += 1
            else:
                pending, pending_count = desired, 1
            if pending_count >= CONFIRM_CANDLES:
                current = desired
                pending, pending_count = None, 0
        states[i] = current
    return states


def classify_regime(candles: Sequence[Candle]) -> RegimeResult:
    """Compute committed regime + supporting metrics at the newest candle."""
    n = len(candles)
    if n == 0:
        return RegimeResult(None, None, None, None, 0)
    adx = adx_series(candles)
    er = efficiency_ratio_series(candles)
    atr = wilder_atr_series(candles)

    current: Optional[Regime] = None
    pending: Optional[Regime] = None
    pending_count = 0
    states: List[Optional[Regime]] = [None] * n

    for i in range(n):
        a, e, at = adx[i], er[i], atr[i]
        close = float(candles[i][CLOSE])
        atr_pct = (at / close) if (at is not None and close > 0) else None
        if a is None or e is None or atr_pct is None:
            states[i] = current
            continue
        desired = _desired(current, a, e, atr_pct)
        if current is None:
            current = desired
            pending, pending_count = None, 0
        elif desired == current:
            pending, pending_count = None, 0
        else:
            if desired == pending:
                pending_count += 1
            else:
                pending, pending_count = desired, 1
            if pending_count >= CONFIRM_CANDLES:
                current = desired
                pending, pending_count = None, 0
        states[i] = current

    i = n - 1
    newest = states[i]
    age = 0
    if newest is not None:
        k = i
        while k >= 0 and states[k] == newest:
            age += 1
            k -= 1
    at_last = atr[i]
    close_last = float(candles[i][CLOSE])
    return RegimeResult(
        regime=newest,
        adx=adx[i],
        efficiency_ratio=er[i],
        atr_pct=(at_last / close_last) if (at_last is not None and close_last > 0) else None,
        trend_age_candles=age,
    )
