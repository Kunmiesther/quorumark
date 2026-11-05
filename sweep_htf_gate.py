"""Canonical higher-timeframe authorization gate for the live SWEEP leg.

PURE. No I/O, no clock read (the caller supplies `now_ms`), no venue access.

WHY THIS EXISTS
---------------
The completed 15m sweep is the entry trigger. The independent direction vote is
1h/4h/1d, and any two of those three must agree with the proposed direction.

FAIL CLOSED. Missing, short, stale or conflicting data is a refusal with a
static reason code — never an inference and never a default.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Optional, Sequence
from shared.zen_sweep_contract import ZEN_SWEEP

# Candle tuple layout, identical to every other parity module.
TS = 0
HIGH = 2
LOW = 3
CLOSE = 4

# Frames that MUST be present, fresh and long enough for a live sweep entry.
ALIGNMENT_FRAMES = ("1h", "4h", "1d")
REQUIRED_FRAMES = ALIGNMENT_FRAMES
REGIME_FRAMES: tuple[str, ...] = ()

INTERVAL_MIN = {
    "15m": 15,
    "1h": 60,
    "4h": 240,
    "1d": 1440,
    "1w": 10080,
    "1M": 43200,
}

# Structure needs room to be a structure. Below this a frame is "insufficient".
MIN_CANDLES = 12
# Bias lookback (completed candles) used for the structural comparison.
BIAS_LOOKBACK = 6
# Dead zone: a drift smaller than this is not a direction.
BIAS_MIN_PCT = 0.0015
# A frame is stale once its newest COMPLETED candle opened more than this many
# intervals ago.
STALE_INTERVALS = 3

# Static refusal codes. Every one is a durable, greppable decision reason.
HTF_ALIGNMENT_REQUIRED = "HTF_ALIGNMENT_REQUIRED"
HTF_DATA_MISSING = "HTF_DATA_MISSING"
HTF_DATA_STALE = "HTF_DATA_STALE"
HTF_INSUFFICIENT_HISTORY = "HTF_INSUFFICIENT_HISTORY"
M15_CONFIRMATION_REQUIRED = "M15_CONFIRMATION_REQUIRED"
REGIME_OPPOSES_DIRECTION = "REGIME_OPPOSES_DIRECTION"

REFUSAL_CODES = frozenset({
    HTF_ALIGNMENT_REQUIRED,
    HTF_DATA_MISSING,
    HTF_DATA_STALE,
    HTF_INSUFFICIENT_HISTORY,
    M15_CONFIRMATION_REQUIRED,
    REGIME_OPPOSES_DIRECTION,
})


@dataclass(frozen=True)
class FrameBias:
    tf: str
    bias: str                    # "long" | "short" | "none"
    usable: bool
    refusal_code: Optional[str]  # set when not usable
    candles: int
    last_ts_ms: Optional[int]
    drift_pct: Optional[float]


@dataclass(frozen=True)
class HtfGateResult:
    authorized: bool
    refusal_code: Optional[str]
    direction: str
    evidence: dict = field(default_factory=dict)


def _drift(candles: Sequence[Sequence[float]], lookback: int) -> Optional[float]:
    if len(candles) < lookback + 1:
        return None
    ref = float(candles[-1 - lookback][CLOSE])
    last = float(candles[-1][CLOSE])
    if ref <= 0:
        return None
    return (last - ref) / ref


def _structure(candles: Sequence[Sequence[float]], lookback: int) -> Optional[str]:
    """Swing structure over the lookback window: higher-high AND higher-low is
    bullish, lower-high AND lower-low is bearish, anything else is None."""
    window = candles[-(lookback * 2):]
    if len(window) < 4:
        return None
    half = len(window) // 2
    first, second = window[:half], window[half:]
    hi_a = max(float(c[HIGH]) for c in first)
    hi_b = max(float(c[HIGH]) for c in second)
    lo_a = min(float(c[LOW]) for c in first)
    lo_b = min(float(c[LOW]) for c in second)
    if hi_b > hi_a and lo_b > lo_a:
        return "long"
    if hi_b < hi_a and lo_b < lo_a:
        return "short"
    return None


def frame_bias(
    tf: str,
    candles: Optional[Sequence[Sequence[float]]],
    *,
    now_ms: int,
) -> FrameBias:
    """Deterministic directional bias for ONE completed-candle series.

    A frame is usable only when it is present, long enough and fresh. Bias is
    "long"/"short" only when drift and swing structure AGREE; otherwise "none".
    """
    interval = INTERVAL_MIN.get(tf)
    if interval is None:
        return FrameBias(tf, "none", False, HTF_DATA_MISSING, 0, None, None)
    if not candles:
        return FrameBias(tf, "none", False, HTF_DATA_MISSING, 0, None, None)
    rows = [c for c in candles if c and len(c) > CLOSE]
    if len(rows) < MIN_CANDLES:
        return FrameBias(tf, "none", False, HTF_INSUFFICIENT_HISTORY, len(rows), None, None)

    last_ts = int(rows[-1][TS])
    if now_ms - last_ts > STALE_INTERVALS * interval * 60_000:
        return FrameBias(tf, "none", False, HTF_DATA_STALE, len(rows), last_ts, None)

    drift = _drift(rows, BIAS_LOOKBACK)
    if drift is None:
        return FrameBias(tf, "none", False, HTF_INSUFFICIENT_HISTORY, len(rows), last_ts, None)
    structure = _structure(rows, BIAS_LOOKBACK)

    bias = "none"
    if drift > BIAS_MIN_PCT and structure == "long":
        bias = "long"
    elif drift < -BIAS_MIN_PCT and structure == "short":
        bias = "short"
    return FrameBias(tf, bias, True, None, len(rows), last_ts, round(drift, 6))


def evaluate_sweep_htf(
    frames: Optional[Mapping[str, Optional[Sequence[Sequence[float]]]]],
    *,
    direction: str,
    now_ms: int,
) -> HtfGateResult:
    """Authorize (or refuse) a live SWEEP entry in `direction`.

    Returns `authorized=True` when at least two usable 1h/4h/1d frames are
    biased in `direction`. A missing, stale, neutral, or opposing third frame
    does not overrule two affirmative votes.
    """
    evidence: dict = {"gate": "sweep_htf", "direction": direction, "frames": {}}
    if direction not in ("long", "short"):
        return HtfGateResult(False, HTF_ALIGNMENT_REQUIRED, direction, evidence)

    src: Mapping[str, Optional[Sequence[Sequence[float]]]] = frames or {}

    biases: dict = {}
    for tf in ALIGNMENT_FRAMES:
        fb = frame_bias(tf, src.get(tf), now_ms=now_ms)
        biases[tf] = fb
        evidence["frames"][tf] = {
            "bias": fb.bias,
            "usable": fb.usable,
            "refusal_code": fb.refusal_code,
            "candles": fb.candles,
            "last_ts_ms": fb.last_ts_ms,
            "drift_pct": fb.drift_pct,
        }

    required_votes = int(ZEN_SWEEP["signal"]["alignment_votes_required"])
    votes = sum(
        1 for tf in ALIGNMENT_FRAMES
        if biases[tf].usable and biases[tf].bias == direction
    )
    evidence["votes"] = votes
    evidence["votes_required"] = required_votes
    if votes < required_votes:
        evidence["blocked_frame"] = next(
            (tf for tf in ALIGNMENT_FRAMES if biases[tf].bias != direction),
            None,
        )
        return HtfGateResult(False, HTF_ALIGNMENT_REQUIRED, direction, evidence)

    evidence["authorized"] = True
    return HtfGateResult(True, None, direction, evidence)


__all__ = [
    "FrameBias",
    "HtfGateResult",
    "REQUIRED_FRAMES",
    "ALIGNMENT_FRAMES",
    "REGIME_FRAMES",
    "REFUSAL_CODES",
    "INTERVAL_MIN",
    "frame_bias",
    "evaluate_sweep_htf",
    "HTF_ALIGNMENT_REQUIRED",
    "HTF_DATA_MISSING",
    "HTF_DATA_STALE",
    "HTF_INSUFFICIENT_HISTORY",
    "M15_CONFIRMATION_REQUIRED",
    "REGIME_OPPOSES_DIRECTION",
]
