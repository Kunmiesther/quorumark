"""Tests for the new live-worker parity modules.

Covers max_loss, regime, routing, entry_guard, reentry_lockout, htf_bos,
pilot_sizing, stop_verification. Pure unit tests — no network, no DB.
"""
from __future__ import annotations

import math
import sys
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import pytest


# ─── max_loss ─────────────────────────────────────────────────────────────
def test_max_loss_predicate_matches_ts():
    from max_loss import should_trigger_max_loss, MAX_LOSS_MARGIN_FRAC
    assert MAX_LOSS_MARGIN_FRAC == 0.50
    assert should_trigger_max_loss(margin=100, unrealized_worst=-50) is True
    assert should_trigger_max_loss(margin=100, unrealized_worst=-49.999) is False
    assert should_trigger_max_loss(margin=0, unrealized_worst=-1000) is False
    assert should_trigger_max_loss(margin=100, unrealized_worst=25) is False
    assert should_trigger_max_loss(margin=None, unrealized_worst=-100) is False  # type: ignore[arg-type]


# ─── routing ──────────────────────────────────────────────────────────────
def test_leg_for_regime_matrix():
    from routing import leg_for_regime, TREND_FRESH_MAX_CANDLES
    assert leg_for_regime("high_vol") == "hunter"
    assert leg_for_regime("neutral") == "sniper"
    assert leg_for_regime(None) is None
    assert leg_for_regime("trend") == "accumulator"  # backward-compat default
    assert leg_for_regime("trend", TREND_FRESH_MAX_CANDLES) == "vanguard"
    assert leg_for_regime("trend", TREND_FRESH_MAX_CANDLES + 1) == "accumulator"


# ─── entry_guard ──────────────────────────────────────────────────────────
def test_entry_guard_blocks_wait_regimes():
    from entry_guard import evaluate_entry_authorization
    r = evaluate_entry_authorization("opposing_to_open_position", "hunter", "BTC-USDT")
    assert not r.authorized
    assert r.block_code == "wait_regime"

    r = evaluate_entry_authorization(None, "hunter", "BTC-USDT")
    assert not r.authorized and r.block_code == "no_regime"

    r = evaluate_entry_authorization("trend", None, "BTC-USDT")
    assert not r.authorized and r.block_code == "no_leg"

    r = evaluate_entry_authorization("neutral", "sniper", "BTC-USDT")
    assert r.authorized and r.block_code is None


# ─── reentry_lockout ──────────────────────────────────────────────────────
def test_reentry_lockout_scoping():
    from reentry_lockout import build_lockout_set, is_locked_out, REENTRY_LOCKOUT_MS
    now = 1_000_000_000_000
    trades = [
        {"symbol": "LINK-USDT", "direction": "long", "exit_reason": "scout_bos",
         "closed_at_ms": now - 5 * 60_000},
        {"symbol": "LINK-USDT", "direction": "long", "exit_reason": "manual",
         "closed_at_ms": now - 1_000},  # non-trigger reason
        {"symbol": "ETH-USDT", "direction": "short", "exit_reason": "scout_guardian_cluster",
         "closed_at_ms": now - REENTRY_LOCKOUT_MS - 1},  # expired
    ]
    s = build_lockout_set(trades, now)
    assert is_locked_out(s, "LINK-USDT", "long") is True
    assert is_locked_out(s, "LINK-USDT", "short") is False  # opposite direction unaffected
    assert is_locked_out(s, "ETH-USDT", "short") is False   # expired
    assert is_locked_out(s, "BTC-USDT", "long") is False


# ─── pilot_sizing ─────────────────────────────────────────────────────────
def test_pilot_allocation_clamps():
    from pilot_sizing import (
        pilot_allocation, pilot_leverage,
        RESERVE_FLOOR_USD, CEILING_USD, MAX_LEVERAGE,
    )
    assert pilot_allocation(0) == 0
    assert pilot_allocation(RESERVE_FLOOR_USD) == 0
    assert pilot_allocation(RESERVE_FLOOR_USD + 50) == 50
    assert pilot_allocation(RESERVE_FLOOR_USD + CEILING_USD + 999) == CEILING_USD
    assert pilot_leverage(1) == 1
    assert pilot_leverage(MAX_LEVERAGE + 100) == MAX_LEVERAGE
    assert pilot_leverage(-5) == 1


# ─── stop_verification ────────────────────────────────────────────────────
def test_stop_verification_flags_missing_and_loose():
    from stop_verification import (
        Position, ExchangeStopOrder, verify_position_stops, TOLERANCE_PCT,
    )
    positions = [
        Position(id="p1", symbol="BTC-USDT", side="long", intended_stop=100.0),
        Position(id="p2", symbol="ETH-USDT", side="short", intended_stop=200.0),
        Position(id="p3", symbol="SOL-USDT", side="long", intended_stop=50.0),
    ]
    # p1: healthy tight stop; p2: too-loose (above intended by > tolerance);
    # p3: missing entirely.
    exch = [
        ExchangeStopOrder(symbol="BTC-USDT", side="short", position_side="long",
                          stop_price=100.0, reduce_only=True),
        ExchangeStopOrder(symbol="ETH-USDT", side="long", position_side="short",
                          stop_price=200.0 * (1 + TOLERANCE_PCT * 5), reduce_only=True),
    ]
    directives = verify_position_stops(positions, exch)
    codes = sorted((d.position_id, d.reason) for d in directives)
    assert ("p2", "too_loose") in codes
    assert ("p3", "missing") in codes
    assert not any(d.position_id == "p1" for d in directives)


# ─── regime (smoke) ───────────────────────────────────────────────────────
def _rising_candles(n: int, start: float = 100.0, step: float = 0.5) -> list[list]:
    out = []
    p = start
    for i in range(n):
        o = p
        c = p + step
        h = c + 0.05
        l = o - 0.05
        out.append([i * 300_000, o, h, l, c, 1.0])
        p = c
    return out


def test_regime_classifies_and_ages_a_strong_trend():
    from regime import classify_regime
    candles = _rising_candles(120)
    r = classify_regime(candles)
    # This synthetic ramp is either 'trend' (rising, high ER/ADX) or clamped
    # to 'high_vol' if ATR% is elevated. Both are legitimate commits — the
    # invariant is just that we classify and count age.
    assert r.regime in ("trend", "high_vol", "neutral")
    assert r.trend_age_candles >= 1
    assert r.adx is not None
    assert r.efficiency_ratio is not None


# ─── htf_bos (smoke) ──────────────────────────────────────────────────────
def test_htf_bos_none_when_too_few_candles():
    from htf_bos import detect_htf_bos, MIN_HTF_CANDLES_FOR_BOS
    r = detect_htf_bos([], tick=0.1)
    assert r.state == "none"
    r = detect_htf_bos([[0, 1, 1, 1, 1, 1]] * (MIN_HTF_CANDLES_FOR_BOS - 1), tick=0.1)
    assert r.state == "none"


def test_htf_bos_aggregate_only_returns_completed_hours():
    from htf_bos import aggregate_1h, HOUR_MS
    # 12 sub-candles at hour H → completed. 3 sub-candles at hour H+1 → dropped.
    c5m = []
    for i in range(12):
        c5m.append([i * 5 * 60_000, 100, 101, 99, 100.5, 1.0])
    for j in range(3):
        c5m.append([HOUR_MS + j * 5 * 60_000, 100, 101, 99, 100.5, 1.0])
    agg = aggregate_1h(c5m)
    assert len(agg) == 1
    assert agg[0][0] == 0  # first hour bucket ts
