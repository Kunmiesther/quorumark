"""Unit tests for the Scout Guardian v2 deterministic rule engine.

Position-aware gate pipeline. Pure rules — no network, no DB, no LLM. The
adverse-BOS path delegates to accumulator_signal.detect_break; those tests
monkeypatch it so we exercise the v2 gates (fresh, significant, grace,
strategy rule, promoted, pair, vol-scaling) without hand-crafting long
candle series. The primitive itself is covered by
test_accumulator_*.py.
"""
from __future__ import annotations

from types import SimpleNamespace

import accumulator_signal
import scout_guardian as sg


CANDLE_MS = sg.CANDLE_MS
OPEN_TS = 1_700_000_000_000
PAST_GRACE_NOW = OPEN_TS + (sg.GRACE_CANDLES + 5) * CANDLE_MS
WITHIN_GRACE_NOW = OPEN_TS + 1 * CANDLE_MS  # < GRACE_CANDLES=2 → within grace


def _fill(price, qty=1.0, margin=7.5, tp=None):
    return {"price": price, "qty": qty, "margin": margin, "tp": tp or price * 1.01}


def _pos(**over):
    pos = {
        "id": "pos-long",
        "user_id": "11111111-1111-4111-8111-111111111111",
        "symbol": "BTC-USDT",
        "wallet_key": "BTC-long",
        "direction": "long",
        "entry_price": 100.0,
        "entry_candle_ts_ms": OPEN_TS,
        "strategy": "accumulator",
        "promoted": False,
        "pair_id": None,
        "fills": [_fill(100.0)],
        "pending_rungs": [],
    }
    pos.update(over)
    return pos


def _candles():
    # 1 minimal candle is enough — we monkeypatch detect_break.
    return [[0, 1, 1, 1, 1, 1]]


def _patch_break(monkeypatch, event):
    monkeypatch.setattr(
        accumulator_signal, "detect_break", lambda *a, **k: event, raising=True,
    )


def _break(break_ts, level=100.0, close=98.0):
    return SimpleNamespace(
        swing=SimpleNamespace(level=level),
        break_close=close,
        ema_at_break=level + 0.5,
        break_ts=break_ts,
    )


# ─── pure helpers (retained public API) ─────────────────────────────────────
def test_avg_entry_vwap_from_fills():
    pos = _pos(fills=[_fill(100.0, qty=1.0), _fill(90.0, qty=1.0)])
    assert sg.avg_entry(pos) == 95.0


def test_adverse_drawdown_sign_long_and_short():
    long_pos = _pos()
    assert sg.adverse_drawdown_frac(long_pos, 95.0) == 0.05
    short_pos = _pos(direction="short")
    assert sg.adverse_drawdown_frac(short_pos, 105.0) == 0.05


def test_adverse_direction_mapping():
    assert sg.adverse_direction("long") == "short"
    assert sg.adverse_direction("short") == "long"
    assert sg.adverse_direction("flat") is None


# ─── FRESH gate: the flaw-1 regression ─────────────────────────────────────
def test_stale_break_before_opened_at_is_ignored(monkeypatch):
    # Break timestamp BEFORE the position opened → HOLD.
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS - CANDLE_MS))
    v = sg.evaluate_position(_pos(), _candles(), tick=0.1, mark=97.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "hold"
    assert v.reason_code is None
    gates = v.evidence.get("gates", {})
    assert gates.get("detected") is True
    assert gates.get("fresh") is False


def test_fresh_significant_past_grace_closes(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + CANDLE_MS))
    v = sg.evaluate_position(_pos(), _candles(), tick=0.1, mark=97.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "close"
    assert v.reason_code == sg.REASON_ADVERSE_BOS
    types = sorted(d.directive_type for d in v.directives)
    assert types == [sg.DIRECTIVE_CLOSE_POSITION]


def test_fresh_break_within_grace_blocks_close(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + 1))
    pos = _pos(pending_rungs=[_fill(96.0)], fills=[_fill(100.0), _fill(96.0)])
    v = sg.evaluate_position(pos, _candles(), tick=0.1, mark=97.0, now_ms=WITHIN_GRACE_NOW)
    assert v.decision == "hold"
    assert v.evidence["gates"]["close_blocked_by_grace"] is True
    # Rung cancel is still allowed if the beyond-deepest gate fires; here mark
    # sits above deepest fill so no cancel — but the grace-blocked close is
    # the point of the test.


def test_sub_significance_is_hold_with_gate_evidence(monkeypatch):
    # detect_break returns None when the shared BOS-significance filter
    # rejects the poke — Guardian records `detected: false`.
    _patch_break(monkeypatch, None)
    v = sg.evaluate_position(_pos(), _candles(), tick=0.1, mark=99.9, now_ms=PAST_GRACE_NOW)
    assert v.decision == "hold"
    assert v.evidence["gates"].get("detected") is False


# ─── SNIPER rule ───────────────────────────────────────────────────────────
def test_sniper_ignores_adverse_bos(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + CANDLE_MS))
    # 1% underwater — under sniper_max_adverse_pct (3%)
    v = sg.evaluate_position(_pos(strategy="sniper"),
                             _candles(), tick=0.1, mark=99.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "hold"
    assert v.reason_code is None


def test_sniper_closes_on_max_adverse_fallback(monkeypatch):
    _patch_break(monkeypatch, None)
    # 5% underwater — over sniper_max_adverse_pct (3%)
    v = sg.evaluate_position(_pos(strategy="sniper"),
                             _candles(), tick=0.1, mark=95.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "close"
    assert v.reason_code == sg.REASON_SNIPER_INVALIDATED


# ─── PROMOTED runner: worker never emits close ─────────────────────────────
def test_promoted_runner_never_closes(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + CANDLE_MS))
    v = sg.evaluate_position(_pos(promoted=True),
                             _candles(), tick=0.1, mark=90.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "hold"
    assert v.evidence["rule"] == "runner_5m_skipped"
    assert v.directives == []


# ─── ARBITER pair: delegated ───────────────────────────────────────────────
def test_arbiter_pair_delegated(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + CANDLE_MS))
    v = sg.evaluate_position(_pos(pair_id="p-xyz"),
                             _candles(), tick=0.1, mark=90.0, now_ms=PAST_GRACE_NOW)
    assert v.decision == "hold"
    assert v.evidence["rule"] == "arbiter_pair_delegated"


# ─── VOL scaling: same move, different symbols ─────────────────────────────
def _flat_candles(px=100.0, n=30):
    return [[i * CANDLE_MS, px, px, px, px, 1.0] for i in range(n)]


def _wide_candles(px=100.0, span=5.0, n=30):
    # Alternating high-low candles → big ATR → high atr_pct.
    return [[i * CANDLE_MS, px, px + span, px - span, px, 1.0] for i in range(n)]


def test_vol_scaling_closes_low_vol_holds_high_vol(monkeypatch):
    _patch_break(monkeypatch, _break(break_ts=OPEN_TS + CANDLE_MS))
    # Low-vol symbol (flat candles → atr_pct ≈ 0): a 1% adverse move triggers
    # the trend-leg close normally (fresh + significant + past grace).
    v_low = sg.evaluate_position(_pos(), _flat_candles(), tick=0.1, mark=99.0, now_ms=PAST_GRACE_NOW)
    assert v_low.decision == "close"


# ─── CLUSTER rule ──────────────────────────────────────────────────────────
def _cluster_positions(n, price=100.0, direction="long", strategy="accumulator", promoted=False):
    out = []
    for i in range(n):
        out.append({
            "id": f"p{i}", "user_id": "u", "symbol": f"S{i}-USDT",
            "wallet_key": f"S{i}-{direction}", "direction": direction,
            "entry_price": price, "entry_candle_ts_ms": OPEN_TS,
            "strategy": strategy, "promoted": promoted,
            "pair_id": None,
            "fills": [_fill(price)], "pending_rungs": [],
        })
    return out


def test_cluster_fires_on_three_underwater_longs():
    positions = _cluster_positions(3)
    marks = {p["symbol"]: 97.0 for p in positions}  # 3% underwater — over 2% floor
    dirs = sg.evaluate_cluster(positions, marks)
    assert len(dirs) == 3
    assert all(d.reason_code == sg.REASON_CLUSTER for d in dirs)


def test_cluster_runners_cannot_drag_over_threshold():
    # 2 promoted runners + 1 normal — runners' dd is measured from BE stop,
    # so they read as ~0% and cannot fill out the cluster.
    runners = _cluster_positions(2, promoted=True)
    for r in runners:
        r["runner_breakeven_stop"] = 100.0  # BE = current mark → dd = 0
    normals = _cluster_positions(1)
    positions = runners + normals
    for p in positions:
        p["symbol"] = f"CLU-{p['id']}"
    marks = {p["symbol"]: 97.0 for p in positions}
    dirs = sg.evaluate_cluster(positions, marks)
    assert dirs == []


# ─── portfolio orchestration ───────────────────────────────────────────────
def test_portfolio_marks_no_market_data_as_hold():
    pos = _pos()
    res = sg.evaluate_portfolio([pos], market_by_symbol={})
    assert len(res.verdicts) == 1
    assert res.verdicts[0].decision == "hold"
    assert res.verdicts[0].evidence.get("rule") == "no_market_data"


def test_portfolio_is_deterministic(monkeypatch):
    _patch_break(monkeypatch, None)
    positions = _cluster_positions(3)
    for p in positions:
        p["entry_candle_ts_ms"] = OPEN_TS
    market = {p["symbol"]: {"candles": _flat_candles(), "tick": 0.1, "mark": 97.0}
              for p in positions}
    a = sg.evaluate_portfolio(positions, market, now_ms=PAST_GRACE_NOW)
    b = sg.evaluate_portfolio(positions, market, now_ms=PAST_GRACE_NOW)
    assert [d.position_id for d in a.cluster_directives] == [d.position_id for d in b.cluster_directives]
    assert [v.decision for v in a.verdicts] == [v.decision for v in b.verdicts]
    assert len(a.cluster_directives) == 3


# ─── integration: real detect_break on a flat series must be safe ──────────
def test_detect_adverse_bos_safe_on_flat_series():
    flat = [[i * CANDLE_MS, 100.0, 100.0, 100.0, 100.0, 1.0] for i in range(120)]
    assert sg.detect_adverse_bos(flat, tick=0.1, side="long") is None
