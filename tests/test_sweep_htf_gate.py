"""Higher-timeframe gate for the live SWEEP leg.

Proves the ratified rule: a completed 15m sweep needs two affirmative direction
votes from 1h/4h/1d. The third frame may be neutral, opposing, or unavailable.
"""
from __future__ import annotations

import decision_contract as dc
import decision_reducer
import sweep_htf_gate as gate

MIN = 60_000
NOW = 1_800_000_000_000


def series(tf: str, *, direction: str, count: int = 30, now_ms: int = NOW, step_pct: float = 0.01):
    """Monotone trend series whose newest candle closes just before `now_ms`."""
    interval = gate.INTERVAL_MIN[tf] * MIN
    sign = 1.0 if direction == "long" else -1.0
    out = []
    for i in range(count):
        # Oldest first; newest completed candle opened one interval ago.
        idx = count - 1 - i
        ts = now_ms - (idx + 1) * interval
        base = 100.0 * (1.0 + sign * step_pct * i)
        out.append([ts, base, base * 1.002, base * 0.998, base, 10.0])
    return out


def frames(direction: str, **overrides):
    f = {
        "4h": series("4h", direction=direction),
        "1h": series("1h", direction=direction),
        "1d": series("1d", direction=direction),
    }
    f.update(overrides)
    return f


# ---------- gate ------------------------------------------------------------
def test_aligned_stack_authorizes():
    r = gate.evaluate_sweep_htf(frames("long"), direction="long", now_ms=NOW)
    assert r.authorized is True
    assert r.refusal_code is None


def test_one_conflicting_frame_does_not_overrule_two_votes():
    f = frames("long")
    f["1h"] = series("1h", direction="short")
    r = gate.evaluate_sweep_htf(f, direction="long", now_ms=NOW)
    assert r.authorized is True


def test_one_missing_frame_does_not_overrule_two_votes():
    f = frames("long")
    f["4h"] = None
    r = gate.evaluate_sweep_htf(f, direction="long", now_ms=NOW)
    assert (r.authorized, r.refusal_code) == (True, None)


def test_one_stale_frame_does_not_overrule_two_votes():
    f = frames("long")
    f["4h"] = series("4h", direction="long", now_ms=NOW - 10 * gate.INTERVAL_MIN["4h"] * MIN)
    r = gate.evaluate_sweep_htf(f, direction="long", now_ms=NOW)
    assert (r.authorized, r.refusal_code) == (True, None)


def test_only_one_affirmative_vote_refuses():
    f = frames("long")
    f["1h"] = series("1h", direction="long", count=5)
    r = gate.evaluate_sweep_htf(f, direction="long", now_ms=NOW)
    f["4h"] = series("4h", direction="short")
    assert (r.authorized, r.refusal_code) == (False, gate.HTF_ALIGNMENT_REQUIRED)


def test_daily_can_not_overrule_aligned_1h_and_4h():
    f = frames("long")
    f["1d"] = series("1d", direction="short")
    r = gate.evaluate_sweep_htf(f, direction="long", now_ms=NOW)
    assert (r.authorized, r.refusal_code) == (True, None)


def test_missing_regime_never_blocks():
    r = gate.evaluate_sweep_htf(frames("long"), direction="long", now_ms=NOW)
    assert r.authorized is True


def test_every_refusal_code_is_a_contract_reason_code():
    assert gate.REFUSAL_CODES <= dc.REASON_CODES


# ---------- reducer enforcement --------------------------------------------
def _sweep_input(direction: str, *, authorized: bool, confirmed: bool, code=None):
    return decision_reducer.DirectionInput(
        direction=direction,
        confirmed=confirmed,
        entry_price=100.0,
        entry_zone={"low": 100.0, "high": 100.0},
        invalidation=99.0,
        take_profits=[102.0],
        stop_pct=0.01,
        confirmation_ref="sweep:x",
        idempotency_key="sweep:c:BTCUSDT:long:x",
        htf_gate_required=True,
        htf_authorized=authorized,
        refusal_code=code,
    )


def _reduce(inputs):
    return decision_reducer.reduce_decision(
        strategy="sweep",
        candle_close_ms=NOW,
        directions=tuple(inputs),
        regime="trend",
        trend_age_candles=5,
        guard_authorized=True,
        guard_block_code=None,
        evaluator_wired=True,
        candle_fresh=True,
    )


def test_reducer_refuses_5m_only_confirmation():
    """Even if a caller marks the 5m trigger confirmed, no HTF authorization
    means no long/short decision — the structural second lock."""
    r = _reduce([_sweep_input("long", authorized=False, confirmed=True)])
    assert r.direction == "wait"
    assert r.reason_code == gate.HTF_ALIGNMENT_REQUIRED
    assert r.chosen is None


def test_reducer_records_gate_refusal_code_on_wait():
    r = _reduce([
        _sweep_input("long", authorized=False, confirmed=False,
                     code=gate.M15_CONFIRMATION_REQUIRED),
    ])
    assert r.direction == "wait"
    assert r.reason_code == gate.M15_CONFIRMATION_REQUIRED


def test_reducer_allows_authorized_sweep():
    r = _reduce([_sweep_input("long", authorized=True, confirmed=True)])
    assert r.direction == "long"
    assert r.reason_code == "LONG_CONFIRMED"
    assert r.chosen is not None
    assert r.chosen.idempotency_key.startswith("sweep:")


def test_decision_contract_accepts_every_gate_wait():
    for code in sorted(gate.REFUSAL_CODES):
        d = dc.build_decision(
            connection_id="c1", symbol="BTC-USDT", strategy="sweep",
            candle_close_ms=NOW, direction="wait", reason_code=code,
            reason="refused", evidence={}, created_at_ms=NOW,
        )
        assert d["reason_code"] == code
