"""Live-readiness wiring — call-site glue between bot_worker.py and the
pure parity modules delivered in the Live-Readiness pass (max_loss,
regime, routing, entry_guard, reentry_lockout, htf_bos, stop_verification,
pilot_sizing).

Pure functions. No I/O. No credential reads. No venue calls. Every
consumer of this module is expected to attach the returned records to
existing telemetry surfaces (SIGNAL_EVALUATION detail, guardian
decision evidence, guardian directive queue) so the ceremony can
inspect them without introducing a new event code / operation server-side.

No block in this module submits an order. It only returns directive or
evidence dictionaries; the outer worker applies the explicit live-mode flag
and chooses the configured order transport.
"""
from __future__ import annotations

from typing import Iterable, Optional, Sequence

import accumulator_signal
import entry_guard
import htf_bos
import max_loss
import pilot_sizing  # noqa: F401  (re-exported for callers that want it)
import regime as regime_mod
import reentry_lockout
import routing
import stop_verification


CANDLE_HIGH = accumulator_signal.HIGH
CANDLE_LOW = accumulator_signal.LOW


# ─── entry-gate pipeline (fail-closed) ──────────────────────────────────────
def entry_gate(
    candles: Sequence[Sequence[float]],
    symbol: str,
    lockout_set: set,
    direction: Optional[str] = None,
) -> dict:
    """Deterministic pre-flight for a candidate ENTRY.

    Runs classify_regime → leg_for_regime → evaluate_entry_authorization,
    then applies re-entry lockout (per direction). Returns a small dict
    the caller attaches to telemetry. `authorized=True` only if all four
    gates pass for `direction`; when `direction` is None, `authorized` is
    True iff either direction passes.
    """
    r = regime_mod.classify_regime(candles)
    leg = routing.leg_for_regime(r.regime, r.trend_age_candles)
    g = entry_guard.evaluate_entry_authorization(r.regime, leg, symbol)

    directions: dict = {}
    for d in ("long", "short") if direction is None else (direction,):
        blocked_by_lockout = reentry_lockout.is_locked_out(lockout_set, symbol, d)
        directions[d] = {
            "authorized": bool(g.authorized and not blocked_by_lockout),
            "block_code": (
                g.block_code
                if not g.authorized
                else ("reentry_lockout" if blocked_by_lockout else None)
            ),
            "lockout": blocked_by_lockout,
        }

    return {
        "regime": r.regime,
        "trend_age_candles": r.trend_age_candles,
        "adx": None if r.adx is None else round(r.adx, 4),
        "atr_pct": None if r.atr_pct is None else round(r.atr_pct, 6),
        "efficiency_ratio": None if r.efficiency_ratio is None else round(r.efficiency_ratio, 4),
        "leg": leg,
        "guard_authorized": g.authorized,
        "guard_block_code": g.block_code,
        "guard_block_detail": g.block_detail,
        "directions": directions,
    }


# ─── max-loss cap ───────────────────────────────────────────────────────────
def _side_sign(side: str) -> int:
    return 1 if side == "long" else (-1 if side == "short" else 0)


def unrealized_worst(pos: dict, latest_candle: Sequence[float]) -> float:
    """Worst-case unrealized PnL over the current cycle using the newest
    candle's LOW (long) / HIGH (short). Returns 0.0 if entry/qty missing."""
    side = str(pos.get("direction") or "").lower()
    sign = _side_sign(side)
    if sign == 0:
        return 0.0
    entry = float(pos.get("entry_price") or 0.0) or 0.0
    qty = float(pos.get("size_qty") or 0.0) or 0.0
    if entry <= 0 or qty <= 0 or not latest_candle:
        return 0.0
    worst_price = float(latest_candle[CANDLE_LOW]) if side == "long" else float(latest_candle[CANDLE_HIGH])
    return (worst_price - entry) * qty * sign


def evaluate_max_loss(pos: dict, latest_candle: Sequence[float]) -> dict:
    """Return {'triggered': bool, 'unrealized_worst': float, 'margin': float}
    for the caller to convert into a close directive with reason='max_loss_cap'.
    """
    margin = float(pos.get("margin") or 0.0) or 0.0
    worst = unrealized_worst(pos, latest_candle)
    return {
        "triggered": bool(max_loss.should_trigger_max_loss(margin, worst)),
        "unrealized_worst": worst,
        "margin": margin,
        "max_loss_margin_frac": max_loss.MAX_LOSS_MARGIN_FRAC,
    }


# ─── HTF promotion ──────────────────────────────────────────────────────────
def evaluate_htf_promotion(
    pos: dict,
    candles_5m: Sequence[Sequence[float]],
    tick: float,
    mark: float,
) -> dict:
    """Detect an aligned 1h BOS on a profitable, non-promoted position.

    Returns {'promote': bool, 'state', 'broken_level', 'aligned', 'profitable'}.
    On promote=True the caller emits three directives:
        promote_runner, cancel_fixed_tp, set_breakeven_stop
    with bank_fraction=0 (no partial closes) per the ratified ruling.
    """
    side = str(pos.get("direction") or "").lower()
    sign = _side_sign(side)
    already = bool(pos.get("promoted"))
    entry = float(pos.get("entry_price") or 0.0) or 0.0
    profitable = (sign != 0 and entry > 0 and mark > 0 and (mark - entry) * sign > 0)

    htf = htf_bos.aggregate_1h(candles_5m)
    res = htf_bos.detect_htf_bos(htf, tick)
    aligned = (
        (side == "long" and res.state == "bullish_bos")
        or (side == "short" and res.state == "bearish_bos")
    )
    return {
        "promote": bool(profitable and aligned and not already),
        "already_promoted": already,
        "state": res.state,
        "broken_level": res.broken_level,
        "bars_since_confirm": res.bars_since_confirm,
        "aligned": aligned,
        "profitable": profitable,
    }


# ─── stop verification ──────────────────────────────────────────────────────
def build_stop_verify_positions(positions: Iterable[dict]) -> list:
    out = []
    for p in positions:
        side = str(p.get("direction") or "").lower()
        if side not in ("long", "short"):
            continue
        stop = p.get("stop_level")
        if stop is None:
            continue
        try:
            stop_f = float(stop)
        except (TypeError, ValueError):
            continue
        if stop_f <= 0:
            continue
        out.append(stop_verification.Position(
            id=str(p.get("id") or ""),
            symbol=str(p.get("symbol") or ""),
            side=side,
            intended_stop=stop_f,
        ))
    return out


def stop_verify_summary(positions: Iterable[dict], exchange_orders: Iterable) -> dict:
    """Run verify_position_stops for the paper cycle. In paper_simulate mode
    the caller does NOT emit repair directives — only telemetry (STOP_VERIFY_OK
    / STOP_VERIFY_WOULD_REPAIR) — and this function returns per-position status
    so those can be attached to guardian decision evidence."""
    verify_positions = build_stop_verify_positions(positions)
    repairs = stop_verification.verify_position_stops(verify_positions, exchange_orders)
    repair_by_pid = {r.position_id: r for r in repairs}
    per_position: dict = {}
    for vp in verify_positions:
        r = repair_by_pid.get(vp.id)
        if r is None:
            per_position[vp.id] = {"status": "STOP_VERIFY_OK", "reason": None}
        else:
            per_position[vp.id] = {"status": "STOP_VERIFY_WOULD_REPAIR", "reason": r.reason}
    return {
        "paper_simulate": bool(stop_verification.PAPER_SIMULATE),
        "checked": len(verify_positions),
        "would_repair": len(repairs),
        "per_position": per_position,
    }


# ─── lockout convenience ────────────────────────────────────────────────────
def build_lockout_set(recent_closes: Iterable[dict], now_ms: int) -> set:
    """Thin passthrough so bot_worker doesn't need to import reentry_lockout
    directly. `recent_closes` = iterable of dicts with keys
    {symbol, direction, exit_reason, closed_at_ms}."""
    return reentry_lockout.build_lockout_set(recent_closes, now_ms)
