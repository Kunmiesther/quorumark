"""Decision identity, evidence hashing and the WAIT contract."""
import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import decision_contract as dc

FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "decision", "contract_v1.json"
)


def _fixture() -> dict:
    with open(FIXTURE) as fh:
        return json.load(fh)


def test_fixture_round_trips():
    fx = _fixture()
    built = dc.build_decision(**fx["input"])
    assert built["decision_id"] == fx["expected"]["decision_id"]
    assert built["evidence_hash"] == fx["expected"]["evidence_hash"]
    assert built["candle_close_at"] == fx["expected"]["candle_close_at"]
    assert dc.canonical_json(fx["input"]["evidence"]) == fx["expected"]["canonical_evidence"]


def test_identity_is_stable_across_repeated_builds():
    """Retries must return the same decision_id. This is the whole contract."""
    fx = _fixture()
    ids = {dc.build_decision(**fx["input"])["decision_id"] for _ in range(50)}
    assert len(ids) == 1


def test_identity_ignores_direction_and_strategy():
    """Both are OUTPUTS of, or determined by, the candle. Seeding identity
    with either lets one candle mint two decisions."""
    fx = _fixture()
    base = dc.build_decision(**fx["input"])
    waiting = dc.build_decision(**{
        **fx["input"],
        "direction": "wait",
        "reason_code": "NO_CONFIRMED_ENTRY",
        "strategy": "unrouted",
        "entry_zone": None,
        "invalidation": None,
        "take_profits": [],
    })
    assert waiting["decision_id"] == base["decision_id"]


def test_identity_separates_symbols_connections_and_candles():
    fx = _fixture()
    base = dc.decision_id(
        connection_id=fx["input"]["connection_id"],
        symbol="BTC-USDT",
        candle_close_ms=1753920000000,
    )
    # BTC and ETH can never collide — the single most important isolation.
    assert base != dc.decision_id(
        connection_id=fx["input"]["connection_id"],
        symbol="ETH-USDT",
        candle_close_ms=1753920000000,
    )
    assert base != dc.decision_id(
        connection_id="99999999-2222-3333-4444-555555555555",
        symbol="BTC-USDT",
        candle_close_ms=1753920000000,
    )
    assert base != dc.decision_id(
        connection_id=fx["input"]["connection_id"],
        symbol="BTC-USDT",
        candle_close_ms=1753920300000,
    )


def test_symbol_case_and_whitespace_do_not_fork_identity():
    a = dc.decision_id(connection_id="c", symbol="eth-usdt", candle_close_ms=1)
    b = dc.decision_id(connection_id="c", symbol="  ETH-USDT ", candle_close_ms=1)
    assert a == b


def test_evidence_hash_is_key_order_independent_but_value_sensitive():
    fx = _fixture()
    ev = fx["input"]["evidence"]
    reordered = {k: ev[k] for k in reversed(list(ev))}
    assert dc.evidence_hash(reordered) == fx["expected"]["evidence_hash"]
    assert dc.evidence_hash(dict(ev, regime="chop")) != fx["expected"]["evidence_hash"]


def test_wait_is_a_valid_recorded_decision():
    built = dc.build_decision(
        connection_id="11111111-2222-3333-4444-555555555555",
        symbol="ETH-USDT", strategy="sweep", candle_close_ms=1753920000000,
        direction="wait", reason_code="NO_CONFIRMED_ENTRY",
        reason="No liquidity sweep and reclaim on the newest 5m candle",
        evidence={"strategy": "sweep"}, created_at_ms=1753920012000,
    )
    assert built["direction"] == "wait"
    assert built["decision_id"].startswith("dec_v1_")
    assert built["take_profits"] == []


def test_direction_and_reason_code_must_agree():
    common = dict(
        connection_id="c", symbol="ETH-USDT", strategy="sweep",
        candle_close_ms=1, evidence={}, created_at_ms=1, reason="x",
    )
    with pytest.raises(ValueError):
        dc.build_decision(direction="long", reason_code="NO_CONFIRMED_ENTRY", **common)
    with pytest.raises(ValueError):
        dc.build_decision(direction="wait", reason_code="LONG_CONFIRMED", **common)
    with pytest.raises(ValueError):
        dc.build_decision(direction="sideways", reason_code="LONG_CONFIRMED", **common)
    with pytest.raises(ValueError):
        dc.build_decision(direction="wait", reason_code="INVENTED_CODE", **common)


def test_every_reason_code_is_in_the_closed_set():
    """A reader may switch on reason_code, so the set must be closed."""
    assert "LONG_CONFIRMED" in dc.REASON_CODES
    assert "SHORT_CONFIRMED" in dc.REASON_CODES
    assert "NO_CONFIRMED_ENTRY" in dc.REASON_CODES
    assert "CANDLE_STALE" in dc.REASON_CODES
    # No code for a transient feed or evaluator failure: those must not become
    # a recorded decision, because a decision claims its candle permanently.
    assert "MARKET_DATA_UNAVAILABLE" not in dc.REASON_CODES
    assert "EVALUATOR_ERROR" not in dc.REASON_CODES
    # No generic bucket: every refusal has to name itself.
    assert not any(c in dc.REASON_CODES for c in ("BLOCKED", "UNKNOWN", "ERROR", "OTHER"))


def test_every_reason_code_is_reachable():
    """A code nothing can emit is a dead branch for anyone switching on this
    set. Re-entry lockout is the cautionary example: it lived here until it
    moved to safety check 3, where it belongs."""
    # The sweep HTF gate is the second emitter: its static refusal codes travel
    # through DirectionInput.refusal_code and are recorded verbatim by the
    # reducer, so a code defined there is reachable.
    sources = (
        open("decision_reducer.py").read()
        + open("sweep_htf_gate.py").read()
    )
    emitted = set(re.findall(r'"([A-Z0-9_]{4,})"', sources))
    unreachable = dc.REASON_CODES - emitted
    assert unreachable == set(), unreachable


def test_the_contract_holds_no_credential_and_no_io():
    src = open("decision_contract.py").read()
    for forbidden in ("requests", "http", "SUPABASE", "api_key", "secret", "signer", "broker"):
        assert forbidden not in src.replace("# ", "").split('"""')[2]
