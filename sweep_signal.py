"""LIQUIDITY-SWEEP strategy — Python-canonical mirror of the TS sweep.

Exact 1:1 functional port of `src/lib/paper/sweep.ts` (renamed identifiers
to snake_case). Same detection logic, same level sourcing, same gates,
same exit geometry. Reads the same shared `sweep` block via
shared.parity_constants → mainnet_parity_constants.json — no new
constants introduced on this side.

The purpose is parity: the TS paper engine and the Python live worker
must return IDENTICAL entry / stop / tp / mode on the same 5m candle
fixture. Live == paper.

Pure. Deterministic. No I/O.

Candle shape: (ts_ms, open, high, low, close, volume) — matches
src/lib/paper/signal.ts TS/OPEN/HIGH/LOW/CLOSE/VOLUME.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

from shared.parity_constants import group as _pc_group

_SWEEP = _pc_group("sweep")
_BOS_SIG = _pc_group("bos_significance")

# ─── exported constants (mirror the TS `export const SWEEP_*`) ────────────
SWEEP_ENABLED: bool = bool(_SWEEP["enabled"])
SWEEP_ENABLE_RETEST: bool = bool(_SWEEP["enable_retest"])
SWEEP_ENABLE_REJECTION: bool = bool(_SWEEP["enable_rejection"])
SWEEP_MAX_RUNGS: int = int(_SWEEP["max_rungs"])
SWEEP_TP_RR: float = float(_SWEEP.get("tp_rr", 2.5))
SWEEP_MAX_RETEST_CANDLES: int = int(_SWEEP["max_retest_candles"])
SWEEP_BODY_RATIO: float = float(_SWEEP["body_ratio"])
SWEEP_SWING_LOOKBACK: int = int(_SWEEP["swing_lookback"])
SWEEP_MIN_ATR_MULT: float = float(_SWEEP["min_atr_mult"])
SWEEP_ATR_PERIOD: int = int(_SWEEP["atr_period"])
SWEEP_ATR_SMA_PERIOD: int = int(_SWEEP["atr_sma_period"])
SWEEP_RSI_PERIOD: int = int(_SWEEP["rsi_period"])
SWEEP_RSI_LONG_MAX: float = float(_SWEEP["rsi_long_max"])
SWEEP_RSI_SHORT_MIN: float = float(_SWEEP["rsi_short_min"])
SWEEP_SESSION_HOURS_UTC: List[int] = list(_SWEEP["session_hours_utc"])
SWEEP_MIN_DISPLACEMENT_ATR: float = float(_BOS_SIG["min_displacement_atr"])

# Candle tuple indices (parity with src/lib/paper/signal.ts).
TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

DAY_MS = 86_400_000
HOUR_MS = 3_600_000

Candle = Sequence[float]


# ─── indicators ────────────────────────────────────────────────────────────

def atr_series(candles: Sequence[Candle], period: int = SWEEP_ATR_PERIOD) -> List[Optional[float]]:
    """Wilder ATR (matches the ATR the TS engine feeds detectSweep)."""
    n = len(candles)
    out: List[Optional[float]] = [None] * n
    if n < period + 1:
        return out
    trs: List[float] = []
    for i in range(1, n):
        h, l, pc = candles[i][HIGH], candles[i][LOW], candles[i - 1][CLOSE]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    avg = sum(trs[:period]) / period
    out[period] = avg
    for i in range(period + 1, n):
        # trs is 0-indexed at i-1 for candle i
        avg = (avg * (period - 1) + trs[i - 1]) / period
        out[i] = avg
    return out


def rsi_series(candles: Sequence[Candle], period: int = SWEEP_RSI_PERIOD) -> List[Optional[float]]:
    """Wilder RSI — port of `rsiSeries` in TS."""
    n = len(candles)
    out: List[Optional[float]] = [None] * n
    if n < period + 1:
        return out
    gain = 0.0
    loss = 0.0
    for i in range(1, period + 1):
        d = candles[i][CLOSE] - candles[i - 1][CLOSE]
        if d >= 0:
            gain += d
        else:
            loss -= d
    avg_g = gain / period
    avg_l = loss / period
    out[period] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1 + avg_g / avg_l)
    for i in range(period + 1, n):
        d = candles[i][CLOSE] - candles[i - 1][CLOSE]
        g = d if d > 0 else 0.0
        l = -d if d < 0 else 0.0
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
        out[i] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1 + avg_g / avg_l)
    return out


def _sma(values: Sequence[Optional[float]], idx: int, period: int) -> Optional[float]:
    if idx + 1 < period:
        return None
    s = 0.0
    count = 0
    for i in range(idx - period + 1, idx + 1):
        v = values[i]
        if v is None:
            return None
        s += v
        count += 1
    return s / period if count == period else None


# ─── level discovery ───────────────────────────────────────────────────────

@dataclass
class LiquidityLevel:
    price: float
    kind: str            # "high" | "low"
    source: str          # "prior_day" | "session" | "swing" | "equal"
    formed_idx: int


def find_liquidity_levels(
    candles: Sequence[Candle],
    atr_at_newest: float,
    swing_lookback: int = SWEEP_SWING_LOOKBACK,
) -> List[LiquidityLevel]:
    """1:1 port of `findLiquidityLevels`."""
    n = len(candles)
    if n == 0:
        return []
    levels: List[LiquidityLevel] = []
    now_ts = candles[n - 1][TS]
    now_day = int(now_ts // DAY_MS)

    # Prior-day hi/lo
    pd_hi = float("-inf"); pd_lo = float("inf")
    pd_hi_idx = -1; pd_lo_idx = -1
    for i in range(n):
        if int(candles[i][TS] // DAY_MS) == now_day - 1:
            if candles[i][HIGH] > pd_hi:
                pd_hi = candles[i][HIGH]; pd_hi_idx = i
            if candles[i][LOW] < pd_lo:
                pd_lo = candles[i][LOW]; pd_lo_idx = i
    if pd_hi_idx >= 0:
        levels.append(LiquidityLevel(pd_hi, "high", "prior_day", pd_hi_idx))
    if pd_lo_idx >= 0:
        levels.append(LiquidityLevel(pd_lo, "low", "prior_day", pd_lo_idx))

    # Prior-session hi/lo
    session_hours = sorted(SWEEP_SESSION_HOURS_UTC)
    from datetime import datetime, timezone
    now_hour = datetime.fromtimestamp(now_ts / 1000, tz=timezone.utc).hour
    session_start_hour = session_hours[0]
    for h in session_hours:
        if h <= now_hour:
            session_start_hour = h
    idx_in_list = session_hours.index(session_start_hour)
    if idx_in_list > 0:
        prev_session_hour = session_hours[idx_in_list - 1]
    else:
        prev_session_hour = session_hours[-1]
    is_wrapped = (idx_in_list == 0)
    day_of_prev = now_day - 1 if is_wrapped else now_day
    prev_session_start_ts = day_of_prev * DAY_MS + prev_session_hour * HOUR_MS
    cur_session_start_ts = now_day * DAY_MS + session_start_hour * HOUR_MS
    ss_hi = float("-inf"); ss_lo = float("inf")
    ss_hi_idx = -1; ss_lo_idx = -1
    for i in range(n):
        t = candles[i][TS]
        if prev_session_start_ts <= t < cur_session_start_ts:
            if candles[i][HIGH] > ss_hi:
                ss_hi = candles[i][HIGH]; ss_hi_idx = i
            if candles[i][LOW] < ss_lo:
                ss_lo = candles[i][LOW]; ss_lo_idx = i
    if ss_hi_idx >= 0:
        levels.append(LiquidityLevel(ss_hi, "high", "session", ss_hi_idx))
    if ss_lo_idx >= 0:
        levels.append(LiquidityLevel(ss_lo, "low", "session", ss_lo_idx))

    # 5m swing hi/lo within swing_lookback candles (2-bar-each-side fractal),
    # excluding newest (skip last 2).
    frm = max(0, n - 1 - swing_lookback)
    # Match TS: `for (let i = from + 2; i < n - 2; i++)`
    for i in range(frm + 2, n - 2):
        h = candles[i][HIGH]; l = candles[i][LOW]
        is_pivot_hi = (h > candles[i - 1][HIGH] and h > candles[i - 2][HIGH]
                       and h > candles[i + 1][HIGH] and h > candles[i + 2][HIGH])
        is_pivot_lo = (l < candles[i - 1][LOW] and l < candles[i - 2][LOW]
                       and l < candles[i + 1][LOW] and l < candles[i + 2][LOW])
        if is_pivot_hi:
            levels.append(LiquidityLevel(h, "high", "swing", i))
        if is_pivot_lo:
            levels.append(LiquidityLevel(l, "low", "swing", i))

    # Collapse equal levels within tolerance = 0.10 × ATR.
    tol = max(1e-12, 0.10 * atr_at_newest)
    collapsed: List[LiquidityLevel] = []
    for lv in sorted(levels, key=lambda x: x.price):
        if collapsed:
            last = collapsed[-1]
            if last.kind == lv.kind and abs(last.price - lv.price) <= tol:
                last.source = "equal"
                last.formed_idx = max(last.formed_idx, lv.formed_idx)
                last.price = (last.price + lv.price) / 2
                continue
        collapsed.append(LiquidityLevel(lv.price, lv.kind, lv.source, lv.formed_idx))
    return collapsed


# ─── sweep detection ──────────────────────────────────────────────────────

def _body_ratio(c: Candle) -> float:
    rng = c[HIGH] - c[LOW]
    if not (rng > 0):
        return 0.0
    return abs(c[CLOSE] - c[OPEN]) / rng


def _candle_swept(swept: Candle, level: LiquidityLevel, min_displacement: float) -> Optional[str]:
    if level.kind == "high" and swept[HIGH] >= level.price + min_displacement:
        return "high"
    if level.kind == "low" and swept[LOW] <= level.price - min_displacement:
        return "low"
    return None


@dataclass
class SweepEntry:
    direction: str            # "long" | "short"
    mode: str                 # "retest" | "rejection"
    entry: float
    stop: float
    swept_level: float
    level_source: str
    atr_at_entry: float
    tp_distance: float

    @property
    def tp(self) -> float:
        """TP price (direction-signed) — matches sweepTpPrice() semantics."""
        return sweep_tp_price(self.entry, self.stop, self.direction)


def sweep_tp_price(entry: float, stop: float, direction: str) -> float:
    """Port of `sweepTpPrice`. TP = entry ± SWEEP_TP_RR × |entry − stop| (2.5R)."""
    d = SWEEP_TP_RR * abs(entry - stop)
    return entry + d if direction == "long" else entry - d


def _build_entry(
    direction: str,
    mode: str,
    confirm: Candle,
    level: LiquidityLevel,
    atr_now: float,
    tick: float,
    original_sweep_extreme: Optional[float] = None,
) -> SweepEntry:
    entry = confirm[CLOSE]
    if original_sweep_extreme is not None:
        swept_extreme = original_sweep_extreme
    else:
        swept_extreme = confirm[LOW] if direction == "long" else confirm[HIGH]
    t = tick if tick > 0 else 0
    stop = swept_extreme - t if direction == "long" else swept_extreme + t
    # TP geometry: 2.5R (owner directive 2026-07-26).
    risk = abs(entry - stop)
    tp_distance = SWEEP_TP_RR * risk
    return SweepEntry(
        direction=direction, mode=mode, entry=entry, stop=stop,
        swept_level=level.price, level_source=level.source,
        atr_at_entry=atr_now, tp_distance=tp_distance,
    )



def detect_sweep(
    candles: Sequence[Candle],
    atr: Sequence[Optional[float]],
    htf_bos_state: str,          # "bullish_bos" | "bearish_bos" | "none"
    tick: float,
) -> Optional[SweepEntry]:
    """1:1 port of TS `detectSweep`."""
    if not SWEEP_ENABLED:
        return None
    n = len(candles)
    if n < SWEEP_ATR_PERIOD + SWEEP_RSI_PERIOD + 5:
        return None

    newest = candles[n - 1]
    iN = n - 1
    atr_now = atr[iN]
    if not (atr_now and atr_now > 0):
        return None

    atr_sma = _sma(atr, iN, SWEEP_ATR_SMA_PERIOD)
    if atr_sma is None:
        return None
    if not (atr_now > atr_sma * SWEEP_MIN_ATR_MULT):
        return None

    rsi = rsi_series(candles, SWEEP_RSI_PERIOD)
    rsi_now = rsi[iN]
    if rsi_now is None:
        return None

    min_displacement = SWEEP_MIN_DISPLACEMENT_ATR * atr_now
    levels = find_liquidity_levels(candles, atr_now, SWEEP_SWING_LOOKBACK)
    if not levels:
        return None

    # Body gate on the confirmation candle.
    body = _body_ratio(newest)
    if body < SWEEP_BODY_RATIO:
        return None
    closes_up = newest[CLOSE] > newest[OPEN]
    closes_dn = newest[CLOSE] < newest[OPEN]

    # Priority: session-first (session/prior_day/equal) then swing. Then by
    # proximity to newest close. Stable sort matches the JS Array.sort semantics
    # we rely on (V8 is stable for large arrays; Python's sort is stable too).
    price_ref = newest[CLOSE]
    def _priority(s: str) -> int:
        return 1 if s == "swing" else 0
    sorted_levels = sorted(
        levels, key=lambda lv: (_priority(lv.source), abs(lv.price - price_ref))
    )

    for lv in sorted_levels:
        # ═══ Mode B: REJECTION (single-candle sweep + reclaim close) ═══
        if SWEEP_ENABLE_REJECTION:
            swept = _candle_swept(newest, lv, min_displacement)
            if swept == "low" and newest[CLOSE] > lv.price and closes_up:
                if htf_bos_state == "bearish_bos":
                    continue
                if not (rsi_now < SWEEP_RSI_LONG_MAX):
                    continue
                return _build_entry("long", "rejection", newest, lv, atr_now, tick)
            if swept == "high" and newest[CLOSE] < lv.price and closes_dn:
                if htf_bos_state == "bullish_bos":
                    continue
                if not (rsi_now > SWEEP_RSI_SHORT_MIN):
                    continue
                return _build_entry("short", "rejection", newest, lv, atr_now, tick)

        # ═══ Mode A: SWEEP + RETEST ═══
        if SWEEP_ENABLE_RETEST:
            look_from = max(0, n - 1 - SWEEP_MAX_RETEST_CANDLES)
            for j in range(n - 2, look_from - 1, -1):
                swept_dir = _candle_swept(candles[j], lv, min_displacement)
                if not swept_dir:
                    continue
                if swept_dir == "low":
                    touched = (newest[LOW] <= lv.price
                               and newest[CLOSE] > lv.price
                               and closes_up)
                    if not touched:
                        continue
                    if htf_bos_state == "bearish_bos":
                        continue
                    if not (rsi_now < SWEEP_RSI_LONG_MAX):
                        continue
                    return _build_entry(
                        "long", "retest", newest, lv, atr_now, tick,
                        candles[j][LOW],
                    )
                else:
                    touched = (newest[HIGH] >= lv.price
                               and newest[CLOSE] < lv.price
                               and closes_dn)
                    if not touched:
                        continue
                    if htf_bos_state == "bullish_bos":
                        continue
                    if not (rsi_now > SWEEP_RSI_SHORT_MIN):
                        continue
                    return _build_entry(
                        "short", "retest", newest, lv, atr_now, tick,
                        candles[j][HIGH],
                    )
    return None
