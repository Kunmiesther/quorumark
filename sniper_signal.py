"""SNIPER strategy — zone reversal + fakeout entry + VWAP-magnet target
with confirmed-continuation size-up (corrected v2).

PURE detection module. No I/O. Reads OHLCV arrays, returns dataclasses.
Same shape as accumulator_signal / hunter_signal so it plugs into
market_data.ApexPublicFeed.candles.

Why v2 exists
-------------
v1 targeted the nearest OPPOSING zone. Stops (tight, past fakeout wick)
fired ~2x as often as TP because price rarely traveled all the way to the
far zone. 20% WR, -$510 on 90d, all wallets floored. The fakeout filter
itself did add edge (WR lift on some names) — so entry logic is KEPT.
What changes: TARGET.

v2 targets SESSION VWAP (resets daily, UTC 00:00). VWAP is a strong
reversion magnet in ranging markets, and it is much closer than the
opposing zone, so trades actually reach it. When price reaches VWAP:
  * if the reaching candle CLOSES DECISIVELY through VWAP in the trade's
    direction -> CONTINUATION CONFIRMED -> SIZE UP (add a second tranche)
    and ride to the opposing zone (or R-multiple fallback).
  * otherwise -> EXIT at VWAP, bank the base hit.

Stop is unchanged (tight, past fakeout wick).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

# Zone band
from shared.parity_constants import get as _pc_get
# Zone band
ATR_PERIOD = _pc_get("sniper", "atr_period")
ZONE_ATR_MULT = _pc_get("sniper", "zone_atr_mult")
PIVOT_LEFT = _pc_get("sniper", "pivot_left")
PIVOT_RIGHT = _pc_get("sniper", "pivot_right")

# Regime
EMA_PERIOD = _pc_get("sniper", "ema_period")
SLOPE_LOOKBACK = _pc_get("sniper", "slope_lookback")
FLAT_PCT = _pc_get("sniper", "flat_pct")

# Zone freshness
ZONE_LOOKBACK_HOURS = _pc_get("sniper", "zone_lookback_hours")

# Fakeout gating
MAX_WICK_ATR_MULT = _pc_get("sniper", "max_wick_atr_mult")
FALLBACK_R = _pc_get("sniper", "fallback_r")

# Continuation
CONT_BODY_FRAC = _pc_get("sniper", "cont_body_frac")
CONT_MIN_ATR_MULT = _pc_get("sniper", "cont_min_atr_mult")
ATR_PERIOD_LTF = _pc_get("sniper", "atr_period")

Candle = Sequence[float]

DAY_MS = 86_400_000


# ---------- indicators ----------
def true_ranges(c: Sequence[Candle]) -> List[float]:
    out: List[float] = []
    for i, k in enumerate(c):
        if i == 0:
            out.append(float(k[HIGH]) - float(k[LOW])); continue
        pc = float(c[i - 1][CLOSE])
        out.append(max(float(k[HIGH]) - float(k[LOW]),
                       abs(float(k[HIGH]) - pc),
                       abs(float(k[LOW]) - pc)))
    return out


def wilder_atr(c: Sequence[Candle], period: int = ATR_PERIOD) -> List[Optional[float]]:
    n = len(c); out: List[Optional[float]] = [None] * n
    if n < period: return out
    tr = true_ranges(c)
    seed = sum(tr[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, n):
        prev = ((period - 1) * prev + tr[i]) / period
        out[i] = prev
    return out


def ema(c: Sequence[Candle], period: int = EMA_PERIOD) -> List[Optional[float]]:
    n = len(c); out: List[Optional[float]] = [None] * n
    if n < period: return out
    closes = [float(k[CLOSE]) for k in c]
    seed = sum(closes[:period]) / period
    out[period - 1] = seed
    k = 2 / (period + 1)
    prev = seed
    for i in range(period, n):
        prev = closes[i] * k + prev * (1 - k)
        out[i] = prev
    return out


# ---------- session VWAP ----------
def session_vwap_series(ltf: Sequence[Candle]) -> List[Optional[float]]:
    """Session VWAP that resets at UTC 00:00 each day.

    VWAP_t = sum(typical_price * volume) / sum(volume) over the current
    UTC day, inclusive of candle t. Requires real volume (>0). If a
    session's cumulative volume is 0 the entry is None.
    """
    n = len(ltf)
    out: List[Optional[float]] = [None] * n
    cur_day = -1
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(n):
        c = ltf[i]
        ts = int(c[TS])
        day = ts // DAY_MS
        if day != cur_day:
            cur_day = day
            cum_pv = 0.0
            cum_v = 0.0
        hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
        v = float(c[VOLUME]) if len(c) > VOLUME else 0.0
        tp = (hi + lo + cl) / 3.0
        cum_pv += tp * v
        cum_v += v
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


# ---------- zones ----------
@dataclass(frozen=True)
class Zone:
    kind: str
    pivot_index: int
    pivot_ts: int
    level: float
    lower: float
    upper: float
    atr: float


def find_zones(htf: Sequence[Candle], tick: float) -> List[Zone]:
    atr = wilder_atr(htf)
    out: List[Zone] = []
    n = len(htf)
    for i in range(PIVOT_LEFT, n - PIVOT_RIGHT):
        c = htf[i]
        hi = float(c[HIGH]); lo = float(c[LOW])
        nb = [htf[i - 2], htf[i - 1], htf[i + 1], htf[i + 2]]
        a = atr[i + PIVOT_RIGHT] if (i + PIVOT_RIGHT) < len(atr) else None
        if a is None:
            continue
        tol = max(tick, ZONE_ATR_MULT * a)
        if all(hi > float(x[HIGH]) for x in nb):
            out.append(Zone('supply', i, int(c[TS]), hi, hi - tol, hi + tol, a))
        if all(lo < float(x[LOW]) for x in nb):
            out.append(Zone('demand', i, int(c[TS]), lo, lo - tol, lo + tol, a))
    return out


# ---------- regime ----------
def is_ranging_at(htf_ema: List[Optional[float]], i: int,
                  lookback: int = SLOPE_LOOKBACK,
                  flat_pct: float = FLAT_PCT) -> Optional[bool]:
    if i - lookback < 0: return None
    a = htf_ema[i]; b = htf_ema[i - lookback]
    if a is None or b is None or b == 0: return None
    return abs((a - b) / b) <= flat_pct


# ---------- entry ----------
def opposing_zone_target(zones: List[Zone], direction: str,
                         entry_px: float, htf_index_now: int) -> Optional[Zone]:
    cutoff = htf_index_now - ZONE_LOOKBACK_HOURS
    cand: List[Zone] = []
    for z in zones:
        if z.pivot_index + PIVOT_RIGHT > htf_index_now: continue
        if z.pivot_index < cutoff: continue
        if direction == 'long' and z.kind == 'supply' and z.level > entry_px:
            cand.append(z)
        elif direction == 'short' and z.kind == 'demand' and z.level < entry_px:
            cand.append(z)
    if not cand: return None
    if direction == 'long':
        return min(cand, key=lambda z: z.level)
    return max(cand, key=lambda z: z.level)


# alias kept for backward-compat with any external caller
_opposing_zone_target = opposing_zone_target


def active_zones_at(zones: List[Zone], htf_index_now: int) -> List[Zone]:
    cutoff = htf_index_now - ZONE_LOOKBACK_HOURS
    return [z for z in zones
            if z.pivot_index + PIVOT_RIGHT <= htf_index_now
            and z.pivot_index >= cutoff]


def detect_fakeout_entry(ltf_candle: Candle, zone: Zone, tick: float,
                         use_fakeout_filter: bool = True
                         ) -> Optional[Tuple[str, float, float, float, bool]]:
    hi = float(ltf_candle[HIGH]); lo = float(ltf_candle[LOW])
    cl = float(ltf_candle[CLOSE])
    if zone.kind == 'demand':
        wick_beyond = lo < zone.lower
        reclaim = cl >= zone.lower
        if wick_beyond and (zone.lower - lo) > MAX_WICK_ATR_MULT * zone.atr:
            return None
        if use_fakeout_filter:
            if wick_beyond and reclaim and cl <= zone.upper:
                return ('long', cl, lo - tick, lo, True)
            return None
        if lo <= zone.upper and cl <= zone.upper:
            return ('long', cl, min(lo, zone.lower) - tick, lo, False)
        return None
    else:
        wick_beyond = hi > zone.upper
        reclaim = cl <= zone.upper
        if wick_beyond and (hi - zone.upper) > MAX_WICK_ATR_MULT * zone.atr:
            return None
        if use_fakeout_filter:
            if wick_beyond and reclaim and cl >= zone.lower:
                return ('short', cl, hi + tick, hi, True)
            return None
        if hi >= zone.lower and cl >= zone.lower:
            return ('short', cl, max(hi, zone.upper) + tick, hi, False)
        return None


# ---------- continuation check at VWAP ----------
def continuation_confirmed(candle: Candle, vwap: float, direction: str,
                           atr5: Optional[float]) -> bool:
    """True if this candle's CLOSE punched decisively through VWAP in the
    trade's direction. Body fraction gate + ATR gate."""
    hi = float(candle[HIGH]); lo = float(candle[LOW]); cl = float(candle[CLOSE])
    rng = max(hi - lo, 1e-12)
    if direction == 'long':
        beyond = cl - vwap
    else:
        beyond = vwap - cl
    if beyond <= 0:
        return False
    if beyond < CONT_BODY_FRAC * rng:
        return False
    if atr5 is not None and beyond < CONT_MIN_ATR_MULT * atr5:
        return False
    return True


def zone_invalidated(ltf_candle: Candle, zone: Zone) -> bool:
    cl = float(ltf_candle[CLOSE])
    if zone.kind == 'demand':
        return cl < zone.lower - 1e-12
    return cl > zone.upper + 1e-12
