"""Junk-filter scaffolding for TurtleBot strategy engine.

Deterministic gates now; AI-backed variants slot in later behind the same
callable signatures. These functions are PURE and side-effect free (aside
from module-level logging on config warnings). None of them are wired into
any auto-emission path — the stage-3 engine will call them.

Params source of truth: user_strategy.params.junk_filter (spec_version v1).
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional, Sequence

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Volatility floor
# ---------------------------------------------------------------------------
ATR_PERIOD = 14
# Conservative default when params.junk_filter.volatility_floor.threshold is
# null. Expressed as ATR / close ratio, i.e. minimum realized 5m range as
# a fraction of price. 0.0008 = 8 bps of price per 5m bar.
DEFAULT_ATR_RATIO_FLOOR = 0.0008


Candle = Sequence[float]  # [ts, open, high, low, close, volume]


def _to_rows(candles: Iterable[Candle]) -> list[Candle]:
    return [c for c in candles]


def _atr(candles: list[Candle], period: int = ATR_PERIOD) -> Optional[float]:
    """True Wilder recursive ATR smoothing over the full candle series.

    Seeded with the mean of the first `period` true ranges, then recursed
    forward one bar at a time as ATR_t = ((period - 1) * ATR_{t-1} + TR_t) / period
    to the last bar. Returns None if not enough data.
    """
    if len(candles) < period + 1:
        return None
    trs: list[float] = []
    prev_close = float(candles[0][4])
    for c in candles[1:]:
        high = float(c[2])
        low = float(c[3])
        close = float(c[4])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr)
        prev_close = close
    if len(trs) < period:
        return None
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = ((period - 1) * atr + tr) / period
    return atr


def volatility_floor_ok(
    candles_5m: Iterable[Candle],
    params_junk_filter: Optional[dict] = None,
) -> bool:
    """Return True if realized 5m ATR/price is above the configured floor.

    False = skip trade (dead tape).

    Reads params.junk_filter.volatility_floor.threshold if present. If the
    threshold is None, uses DEFAULT_ATR_RATIO_FLOOR and logs a warning that
    a threshold should be set explicitly.
    """
    rows = _to_rows(candles_5m)
    atr = _atr(rows)
    if atr is None or not rows:
        # Not enough data to judge — refuse to trade.
        return False
    last_close = float(rows[-1][4])
    if last_close <= 0:
        return False

    threshold: Optional[float] = None
    if params_junk_filter:
        vf = params_junk_filter.get("volatility_floor") or {}
        raw = vf.get("threshold")
        if raw is not None:
            try:
                threshold = float(raw)
            except (TypeError, ValueError):
                threshold = None

    if threshold is None:
        log.warning(
            "volatility_floor.threshold is null; using default %.6f. "
            "Set params.junk_filter.volatility_floor.threshold explicitly.",
            DEFAULT_ATR_RATIO_FLOOR,
        )
        threshold = DEFAULT_ATR_RATIO_FLOOR

    return (atr / last_close) >= threshold


# ---------------------------------------------------------------------------
# Level quality — STUB. Returns None while enabled_flag is false.
# ---------------------------------------------------------------------------
def level_quality_score(context: dict) -> Optional[float]:
    """Return an AI-derived 0..1 quality score for the setup, or None to skip.

    While params.junk_filter.level_quality.enabled_flag is false, this MUST
    return None (pass-through). Never blocks a trade in the disabled state.
    Wired to accept an AI score in a later phase.
    """
    params = (context or {}).get("params") or {}
    junk = params.get("junk_filter") or {}
    lq = junk.get("level_quality") or {}
    if not lq.get("enabled_flag"):
        return None
    # AI backend not wired yet; return None so the engine treats it as
    # "no opinion" rather than a block.
    return None


# ---------------------------------------------------------------------------
# AI v2 attachment points — safe no-op defaults.
# ---------------------------------------------------------------------------
def regime_throttle(context: dict) -> dict:
    """Return regime-adaptive throttling hints. Safe default = no throttle."""
    _ = context
    return {"throttle": False, "size_multiplier": 1.0, "reason": None}


def execution_health_check(fills: Any) -> dict:
    """Post-fill health signal. Safe default = healthy."""
    _ = fills
    return {"healthy": True, "issues": []}
