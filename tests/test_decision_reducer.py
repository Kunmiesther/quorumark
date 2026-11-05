"""One candle -> exactly one direction, with a named reason every time."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import decision_reducer as dr


def _dir(direction, **kw):
    return dr.DirectionInput(direction=direction, **kw)


def _reduce(**overrides):
    base = dict(
        strategy="accumulator",
        candle_close_ms=1753920000000,
        directions=(_dir("long", confirmed=False), _dir("short", confirmed=False)),
        regime="trend",
        trend_age_candles=4,
        guard_authorized=True,
        guard_block_code=None,
        evaluator_wired=True,
        candle_fresh=True,
    )
    base.update(overrides)
    return dr.reduce_decision(**base)


CONFIRMED_LONG = dict(
    confirmed=True, entry_price=3000.0,
    entry_zone={"low": 2990.0, "high": 3010.0}, invalidation=2950.0,
    take_profits=[3100.0], stop_pct=0.0166,
    confirmation_ref="break:1|retest:2", idempotency_key="accum:c:ETHUSDT:long:1:2",
)


def test_nothing_confirmed_is_a_named_wait_not_an_absence():
    r = _reduce()
    assert r.direction == "wait"
    assert r.reason_code == "NO_CONFIRMED_ENTRY"
    assert "No confirmed break-and-retest" in r.reason
    assert r.chosen is None


def test_a_single_confirmation_wins():
    r = _reduce(directions=(_dir("long", **CONFIRMED_LONG), _dir("short", confirmed=False)))
    assert r.direction == "long"
    assert r.reason_code == "LONG_CONFIRMED"
    assert r.chosen is not None
    assert r.chosen.idempotency_key == "accum:c:ETHUSDT:long:1:2"
    assert r.entry_zone == {"low": 2990.0, "high": 3010.0}
    assert r.invalidation == 2950.0
    assert r.take_profits == [3100.0]


def test_both_directions_confirming_still_trades_the_first_one():
    """The pre-refactor bridges looped over SIGNAL_DIRECTIONS and submitted an
    intent per confirmation; the FIRST reached the venue and the second always
    hit the signer's single-position preflight. Taking the first confirmation
    preserves exactly the trade that was placed before. Standing down would
    refuse a trade the old code made."""
    short = dict(CONFIRMED_LONG)
    short["idempotency_key"] = "accum:c:ETHUSDT:short:1:2"
    r = _reduce(directions=(_dir("long", **CONFIRMED_LONG), _dir("short", **short)))
    assert r.direction == "long"
    assert r.reason_code == "LONG_CONFIRMED"
    assert r.chosen.idempotency_key == "accum:c:ETHUSDT:long:1:2"
    # Both confirmations stay visible in the evidence.
    assert r.evidence["multiple_confirmations"] == ["long", "short"]


def test_regime_guard_block_is_named_precisely():
    r = _reduce(
        directions=(_dir("long", **CONFIRMED_LONG), _dir("short", confirmed=False)),
        guard_authorized=False, guard_block_code="wait_regime",
    )
    assert r.direction == "wait"
    assert r.reason_code == "REGIME_WAIT"
    assert "LONG confirmed" in r.reason


def test_an_unclassifiable_regime_is_not_the_same_as_a_waiting_one():
    r = _reduce(
        directions=(_dir("long", **CONFIRMED_LONG), _dir("short", confirmed=False)),
        guard_authorized=False, guard_block_code="no_regime",
    )
    assert r.reason_code == "REGIME_UNAVAILABLE"


def test_a_missing_stop_distance_is_a_refusal_not_a_default():
    no_stop = dict(CONFIRMED_LONG)
    no_stop["stop_pct"] = None
    r = _reduce(directions=(_dir("long", **no_stop), _dir("short", confirmed=False)))
    assert r.direction == "wait"
    assert r.reason_code == "STOP_DISTANCE_UNAVAILABLE"


def test_an_unwired_leg_says_so_instead_of_looking_like_no_setup():
    r = _reduce(strategy="arbiter", evaluator_wired=False, directions=())
    assert r.reason_code == "EVALUATOR_NOT_WIRED"
    assert "arbiter" in r.reason


def test_a_routed_turtle_outside_the_mandate_is_a_policy_refusal():
    r = _reduce(
        strategy="vanguard",
        turtle_route_authorized=False,
        evaluator_wired=False,
        directions=(),
    )
    assert r.direction == "wait"
    assert r.reason_code == "TURTLE_NOT_ENABLED"
    assert "not enabled in this mandate" in r.reason
    assert r.evidence["turtle_route_authorized"] is False


def test_a_stale_candle_cannot_trade_even_when_confirmed():
    r = _reduce(
        directions=(_dir("long", **CONFIRMED_LONG), _dir("short", confirmed=False)),
        candle_fresh=False,
    )
    assert r.direction == "wait"
    assert r.reason_code == "CANDLE_STALE"


def test_an_unwired_leg_wins_over_a_stale_candle():
    """Ordering is fixed so one candle cannot produce two plausible reasons."""
    r = _reduce(
        directions=(_dir("long", **CONFIRMED_LONG), _dir("short", confirmed=False)),
        evaluator_wired=False, candle_fresh=False,
    )
    assert r.reason_code == "EVALUATOR_NOT_WIRED"


def test_the_reducer_cannot_refuse_a_candle_for_a_transient_failure():
    """A feed blip or a crashed evaluator must NOT become a recorded decision:
    a decision claims its candle permanently, so that would burn a candle the
    next 15s cycle could still have traded. Those paths report on the
    SIGNAL_EVALUATION event instead and never reach this reducer."""
    import inspect
    params = inspect.signature(dr.reduce_decision).parameters
    assert "feed_error_code" not in params
    assert "evaluator_error_code" not in params


def test_evidence_is_deterministic_and_carries_no_clock():
    a = _reduce(market_context={"closes": [1.0, 2.0]})
    b = _reduce(market_context={"closes": [1.0, 2.0]})
    assert a.evidence == b.evidence
    assert a.evidence["market"] == {"closes": [1.0, 2.0]}
    # No clock reading may enter the evidence: the hash must describe the
    # candle, not the moment the candle happened to be evaluated.
    assert not {"created_at", "evaluated_at", "observed_at", "now_ms"} & set(a.evidence)


def test_take_profit_levels_mirror_the_signer_geometry():
    # R = entry * stop_pct; TP = entry ± rr * R. Long above, short below.
    longs = dr.take_profit_levels(
        entry_price=100.0, stop_pct=0.02, direction="long", rr_multiples=[1.75, 2.0, 2.5],
    )
    assert longs == [103.5, 104.0, 105.0]
    shorts = dr.take_profit_levels(
        entry_price=100.0, stop_pct=0.02, direction="short", rr_multiples=[1.75, 2.0, 2.5],
    )
    assert shorts == [96.5, 96.0, 95.0]
    # Refuses rather than inventing a level from unusable inputs.
    assert dr.take_profit_levels(
        entry_price=0.0, stop_pct=0.02, direction="long", rr_multiples=[1.75],
    ) == []


def test_the_reducer_is_pure():
    src = open("decision_reducer.py").read()
    for forbidden in ("requests", "time.time", "datetime.now", "os.environ", "supabase"):
        assert forbidden not in src
