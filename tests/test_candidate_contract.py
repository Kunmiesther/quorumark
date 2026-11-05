"""Candidate-contract parity + determinism (Python side).

The same fixture is asserted by src/lib/candidate/__tests__/contract.test.ts, so
a drift between the two implementations fails a test instead of silently
producing two different identities for one real confirmation.
"""
import json
import os

import candidate_contract as cc

FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tests", "fixtures", "candidate", "contract_v1.json",
)


def _fixture():
    with open(FIXTURE) as fh:
        return json.load(fh)


def _build(inp):
    return cc.build_candidate(
        strategy=inp["strategy"],
        connection_id=inp["connection_id"],
        symbol=inp["symbol"],
        timeframe=inp["timeframe"],
        direction=inp["direction"],
        candle_close_ms=inp["candle_close_ms"],
        confirmation_ref=inp["confirmation_ref"],
        market_data_ts_ms=inp["market_data_ts_ms"],
        evidence=inp["evidence"],
        entry_zone=inp["entry_zone"],
        invalidation=inp["invalidation"],
        tp_ladder=inp["tp_ladder"],
    )


def test_contract_matches_fixture():
    fx = _fixture()
    assert _build(fx["input"]) == fx["expected"]


def test_canonical_evidence_matches_fixture():
    fx = _fixture()
    assert cc.canonical_json(fx["input"]["evidence"]) == fx["expected_canonical_evidence"]


def test_candidate_id_is_idempotent_and_normalized():
    fx = _fixture()
    inp = fx["input"]
    first = _build(inp)["candidate_id"]
    second = _build(inp)["candidate_id"]
    upper = dict(inp, symbol=inp["symbol"].lower(), strategy=inp["strategy"].upper())
    assert first == second == fx["expected"]["candidate_id"]
    assert _build(upper)["candidate_id"] == first


def test_candidate_id_changes_with_candle_or_direction():
    fx = _fixture()
    inp = fx["input"]
    base = fx["expected"]["candidate_id"]
    assert _build(dict(inp, candle_close_ms=inp["candle_close_ms"] + 300_000))["candidate_id"] != base
    assert _build(dict(inp, direction="short"))["candidate_id"] != base


def test_candidate_id_carries_no_identifiers():
    fx = _fixture()
    cid = fx["expected"]["candidate_id"]
    assert cid.startswith("cand_v1_") and len(cid) == len("cand_v1_") + 32
    assert fx["input"]["connection_id"] not in cid


def test_evidence_hash_is_order_independent_but_value_sensitive():
    fx = _fixture()
    ev = fx["input"]["evidence"]
    reordered = {k: ev[k] for k in reversed(list(ev))}
    assert cc.evidence_hash(reordered) == fx["expected"]["evidence_hash"]
    assert cc.evidence_hash(dict(ev, regime="chop")) != fx["expected"]["evidence_hash"]


def test_candidate_event_is_allowlisted():
    import worker_ingest_client
    assert "STRATEGY_CANDIDATE_CREATED" in worker_ingest_client.ALLOWED_EVENT_CODES


def test_the_live_path_no_longer_writes_candidates():
    """`strategy_candidates` is HISTORICAL. The live worker records a
    decision per completed candle instead (decision_contract.py); keeping
    both would be two lifecycles for one candle."""
    src = open("bot_worker.py").read()
    assert "STRATEGY_CANDIDATE_CREATED" not in src
    assert "candidate_contract" not in src
    assert "decision_contract" in src


def test_decision_emission_cannot_touch_the_intent_body():
    """The decision-recording seam is additive: it never mutates an intent
    and never submits. Recording is an audit trail, not an authority."""
    src = open("bot_worker.py").read()
    start = src.index("def _emit_decision")
    end = src.index("def _accum_direction_input")
    body = src[start:end]
    for forbidden in ("submit_order_intent", "intent[", "requests.post"):
        assert forbidden not in body
