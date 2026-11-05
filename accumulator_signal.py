"""Accumulator (dca) entry-path signal detection — Stage 1.

Implements the owner-ratified entry path from
docs/STRATEGY_SPEC_v1_ADDENDUM_A_CANDIDATE.md rev 0.17:

    §3.4   swing point .............. S19 (five-candle pivot), S22 (zone tolerance)
    §3.5   break of structure ....... S20 (subject/lookback), S21 (EMA confirmation)
    §3.6   retest ................... S25
    §3.6.1 frozen zone .............. S26

PURE DETECTION. No orders. No I/O. No side effects. Not wired into the worker
loop. Mirrors junk_filter.py conventions.

Candle = [ts, open, high, low, close, volume]  (indices 0..5)

IMPLEMENTATION NOTES — read before trusting output
--------------------------------------------------
1. ATR here is TRUE Wilder smoothing, per S40. This module's
   wilder_atr_series() and junk_filter._atr() now agree to 0.0000% on a
   60-bar reference series (verified 2026-07-16). junk_filter._atr previously
   computed a simple mean of the last `period` true ranges -- Wilder's SEED
   value only, not the recursive series -- diverging ~2.78%. Fixed in commit
   b407d6ec. If either implementation changes, re-verify they still agree:
   the volatility floor (S40, threshold 0.0008) and every zone edge in the
   strategy (S22, 0.05 x ATR14) both depend on this number.

2. S22 sets zone tolerance = max(1 tick, 0.05 x ATR14_5m) but does NOT say
   which candle's ATR fixes it for SWING GROUPING. S26 froze the RETEST zone at
   the breaking candle. B-12 (ruled, not yet recorded -- 0.18 was gated behind
   the 0.17 push) freezes STOP zones at the swing's CONFIRMATION candle.
   This module uses the confirmation candle for swing grouping, consistent with
   B-12, and marks it `assumption="B12_confirmation_candle_atr"` on every Zone
   it produces. NOT an owner ruling. Verify before testnet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional, Sequence

Candle = Sequence[float]

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

from shared.parity_constants import get as _pc_get
ATR_PERIOD = _pc_get("accumulator", "atr_period")
EMA_PERIOD = _pc_get("accumulator", "ema_period")            # v1 entry.ema_period
PIVOT_LEFT = _pc_get("accumulator", "pivot_left")            # S19: two completed candles before
PIVOT_RIGHT = _pc_get("accumulator", "pivot_right")          # S19: two completed candles after
LOOKBACK_CANDLES = _pc_get("accumulator", "lookback_candles")  # S20: 4 hours of 5m candles
RETEST_WINDOW = _pc_get("accumulator", "retest_window")      # S25: six completed candles
ZONE_ATR_MULT = _pc_get("accumulator", "zone_atr_mult")      # S22

# Both this module and junk_filter._atr compute true Wilder smoothing and agree
# to 0.0000% (verified 2026-07-16, commit b407d6ec). Kept as a named invariant:
# S40's volatility floor and S22's zone tolerance both consume this value.
ATR_IMPLEMENTATIONS_AGREE = True

Direction = Literal["long", "short"]


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------
def true_ranges(candles: Sequence[Candle]) -> list[float]:
    """TR series. First element uses high-low (no prior close)."""
    out: list[float] = []
    for i, c in enumerate(candles):
        high, low = float(c[HIGH]), float(c[LOW])
        if i == 0:
            out.append(high - low)
            continue
        prev_close = float(candles[i - 1][CLOSE])
        out.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return out


def wilder_atr_series(
    candles: Sequence[Candle], period: int = ATR_PERIOD
) -> list[Optional[float]]:
    """True Wilder ATR. atr[i] is ATR through candle i, or None if undefined.

    Seed  : atr[period-1] = mean(TR[0..period-1])
    Recurse: atr[i] = ((period-1)*atr[i-1] + TR[i]) / period
    """
    n = len(candles)
    out: list[Optional[float]] = [None] * n
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


def ema_series(
    candles: Sequence[Candle], period: int = EMA_PERIOD
) -> list[Optional[float]]:
    """EMA of closes. ema[i] is EMA through candle i. Seeded with SMA(period)."""
    n = len(candles)
    out: list[Optional[float]] = [None] * n
    if n < period:
        return out
    closes = [float(c[CLOSE]) for c in candles]
    seed = sum(closes[:period]) / period
    out[period - 1] = seed
    k = 2.0 / (period + 1)
    prev = seed
    for i in range(period, n):
        prev = closes[i] * k + prev * (1 - k)
        out[i] = prev
    return out


# ---------------------------------------------------------------------------
# Swing points — S19
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Swing:
    kind: Literal["high", "low"]
    pivot_index: int
    pivot_ts: float
    level: float              # S19.3 — the wick extreme
    confirm_index: int        # S19.4 — pivot + 2; usable only once this closes
    confirm_ts: float


def find_confirmed_swings(candles: Sequence[Candle]) -> list[Swing]:
    """S19 five-candle pivots, strict inequality on both sides.

    S19.6 (inside candles) is satisfied structurally: an inside candle's high is
    by definition <= the prior high, so it can never pass rule 1. No special case.
    """
    out: list[Swing] = []
    n = len(candles)
    for i in range(PIVOT_LEFT, n - PIVOT_RIGHT):
        c = candles[i]
        hi, lo = float(c[HIGH]), float(c[LOW])
        nb = [candles[i - 2], candles[i - 1], candles[i + 1], candles[i + 2]]
        if all(hi > float(x[HIGH]) for x in nb):
            out.append(
                Swing("high", i, float(c[TS]), hi, i + PIVOT_RIGHT,
                      float(candles[i + PIVOT_RIGHT][TS]))
            )
        if all(lo < float(x[LOW]) for x in nb):
            out.append(
                Swing("low", i, float(c[TS]), lo, i + PIVOT_RIGHT,
                      float(candles[i + PIVOT_RIGHT][TS]))
            )
    return out


# ---------------------------------------------------------------------------
# Zones — S22 / S26
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Zone:
    level: float
    tolerance: float
    upper: float
    lower: float
    atr: float
    tick: float
    atr_index: int
    assumption: str = ""


def zone_tolerance(atr: float, tick: float) -> float:
    """S22 / S26: max(1 minimum tick, 0.05 x ATR14_5m)."""
    return max(tick, ZONE_ATR_MULT * atr)


def build_zone(level: float, atr: float, tick: float, atr_index: int,
               assumption: str = "") -> Zone:
    tol = zone_tolerance(atr, tick)
    return Zone(level, tol, level + tol, level - tol, atr, tick, atr_index, assumption)


def group_liquidity_zones(
    swings: Sequence[Swing],
    atr_at: Sequence[Optional[float]],
    tick: float,
) -> list[Swing]:
    """S22: pivots within max(1 tick, 0.05 x ATR) form ONE zone; the OUTERMOST
    wick is the level. Highs group with highs, lows with lows.

    ATR reference = the swing's CONFIRMATION candle. See module docstring note 2:
    this is an assumption consistent with B-12, NOT an owner ruling for grouping.
    """
    merged: list[Swing] = []
    for kind in ("high", "low"):
        group = sorted([s for s in swings if s.kind == kind],
                       key=lambda s: s.pivot_index)
        used: set[int] = set()
        for i, s in enumerate(group):
            if i in used:
                continue
            atr = atr_at[s.confirm_index] if s.confirm_index < len(atr_at) else None
            if atr is None:
                merged.append(s)
                continue
            tol = zone_tolerance(atr, tick)
            cluster = [s]
            for j in range(i + 1, len(group)):
                if j in used:
                    continue
                if abs(group[j].level - s.level) <= tol:
                    cluster.append(group[j])
                    used.add(j)
            if len(cluster) == 1:
                merged.append(s)
                continue
            # S22: outermost extreme is the level. Keep the LATEST confirmation
            # so the zone is only usable once every member pivot has confirmed.
            best = max(cluster, key=lambda x: x.level) if kind == "high" \
                else min(cluster, key=lambda x: x.level)
            latest = max(cluster, key=lambda x: x.confirm_index)
            merged.append(
                Swing(kind, best.pivot_index, best.pivot_ts, best.level,
                      latest.confirm_index, latest.confirm_ts)
            )
    return sorted(merged, key=lambda s: s.pivot_index)


# ---------------------------------------------------------------------------
# Break of structure — S20 / S21
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class BreakEvent:
    direction: Direction
    swing: Swing
    break_index: int
    break_ts: float
    break_close: float
    ema_at_break: float
    zone: Zone                # S26 — frozen at the BREAKING candle


def select_subject(
    swings: Sequence[Swing], direction: Direction, break_index: int
) -> Optional[Swing]:
    """S20: most recent confirmed swing in the relevant direction.

    - long  -> most recent confirmed swing HIGH
    - short -> most recent confirmed swing LOW
    - the swing must have CONFIRMED strictly before the breaking candle began
      (confirm_index < break_index) -- no retroactive subject
    - pivot must lie within the previous LOOKBACK_CANDLES completed candles
    """
    kind = "high" if direction == "long" else "low"
    floor = break_index - LOOKBACK_CANDLES
    cands = [
        s for s in swings
        if s.kind == kind
        and s.confirm_index < break_index
        and s.pivot_index >= floor
        and s.pivot_index < break_index
    ]
    if not cands:
        return None
    return max(cands, key=lambda s: s.pivot_index)


def detect_break(
    candles: Sequence[Candle],
    direction: Direction,
    tick: float,
    swings: Optional[Sequence[Swing]] = None,
    atr_at: Optional[Sequence[Optional[float]]] = None,
    ema_at: Optional[Sequence[Optional[float]]] = None,
    at_index: Optional[int] = None,
) -> Optional[BreakEvent]:
    """S20 + S21: close beyond BOTH the selected swing level AND EMA(15).

    A wick through the level alone is not a break (S19 break condition).
    """
    n = len(candles)
    i = n - 1 if at_index is None else at_index
    if i < 0 or i >= n:
        return None
    atr_at = atr_at if atr_at is not None else wilder_atr_series(candles)
    ema_at = ema_at if ema_at is not None else ema_series(candles)
    swings = swings if swings is not None else group_liquidity_zones(
        find_confirmed_swings(candles), atr_at, tick
    )

    atr, ema = atr_at[i], ema_at[i]
    if atr is None or ema is None:
        return None

    subject = select_subject(swings, direction, i)
    if subject is None:
        return None

    close = float(candles[i][CLOSE])
    if direction == "long":
        if not (close > subject.level and close > ema):
            return None
    else:
        if not (close < subject.level and close < ema):
            return None

    # S26 — zone frozen at the BREAKING candle's close.
    zone = build_zone(subject.level, atr, tick, i, assumption="S26_break_candle_atr")
    return BreakEvent(direction, subject, i, float(candles[i][TS]), close, ema, zone)


# ---------------------------------------------------------------------------
# Retest — S25
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class RetestResult:
    state: Literal["confirmed", "expired_window", "expired_breach", "pending"]
    break_event: BreakEvent
    retest_index: Optional[int] = None
    retest_ts: Optional[float] = None
    reason: str = ""
    checked: list[int] = field(default_factory=list)


def detect_retest(
    candles: Sequence[Candle],
    be: BreakEvent,
    ema_at: Optional[Sequence[Optional[float]]] = None,
) -> RetestResult:
    """S25. The break candle cannot be the retest; evaluation starts at +1.

    Long : low enters the zone, close back ABOVE level AND EMA(15) -> confirmed.
           A completed close BELOW the fixed lower edge -> immediate expiry.
    Short: mirror.
    Window: RETEST_WINDOW completed candles.
    """
    ema_at = ema_at if ema_at is not None else ema_series(candles)
    z = be.zone
    checked: list[int] = []
    start = be.break_index + 1
    stop = min(start + RETEST_WINDOW, len(candles))

    for j in range(start, stop):
        c = candles[j]
        close = float(c[CLOSE])
        ema = ema_at[j]
        checked.append(j)
        if ema is None:
            continue

        if be.direction == "long":
            if close < z.lower:
                return RetestResult("expired_breach", be, j, float(c[TS]),
                                    "completed close below fixed lower edge", checked)
            entered = float(c[LOW]) <= z.upper
            if entered and close > z.level and close > ema:
                return RetestResult("confirmed", be, j, float(c[TS]),
                                    "low entered zone; close above level and EMA", checked)
        else:
            if close > z.upper:
                return RetestResult("expired_breach", be, j, float(c[TS]),
                                    "completed close above fixed upper edge", checked)
            entered = float(c[HIGH]) >= z.lower
            if entered and close < z.level and close < ema:
                return RetestResult("confirmed", be, j, float(c[TS]),
                                    "high entered zone; close below level and EMA", checked)

    if stop - start < RETEST_WINDOW:
        return RetestResult("pending", be, None, None,
                            "window not yet elapsed", checked)
    return RetestResult("expired_window", be, None, None,
                        f"no valid retest within {RETEST_WINDOW} candles", checked)


# ---------------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------------
def evaluate(
    candles: Sequence[Candle],
    direction: Direction,
    tick: float,
) -> dict:
    """Run the full entry path over completed candles. Detection only."""
    atr_at = wilder_atr_series(candles)
    ema_at = ema_series(candles)
    raw = find_confirmed_swings(candles)
    swings = group_liquidity_zones(raw, atr_at, tick)

    breaks: list[BreakEvent] = []
    for i in range(len(candles)):
        be = detect_break(candles, direction, tick, swings, atr_at, ema_at, at_index=i)
        if be is not None:
            breaks.append(be)

    results = [detect_retest(candles, be, ema_at) for be in breaks]
    return {
        "candles": len(candles),
        "swings_raw": len(raw),
        "swings_grouped": len(swings),
        "breaks": breaks,
        "retests": results,
        "entries": [r for r in results if r.state == "confirmed"],
    }
