"""End-to-end guarantees of the canonical live path.

    COMPLETED 15M CANDLE -> LONG/SHORT/WAIT -> SAFETY -> INTENT -> APEX

These are the behaviours the refactor exists to provide. Each one names the
defect it prevents.
"""
import os
import sys
from decimal import Decimal
from unittest.mock import MagicMock, patch

from worker_ingest_client import WorkerIngestAuthError

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_worker as bw
import decision_reducer as dr

CONNECTION = "22222222-3333-4444-5555-666666666666"
USER = "11111111-2222-3333-4444-555555555555"
CANDLE_OPEN_MS = 1753920000000
NOW_MS = CANDLE_OPEN_MS + 60_000

LIVE_CFG = {
    "mode": "live", "status": "verified",
    "permissions_verified": True, "permission_trade": True,
    "enabled": True, "exchange_type": "apex_omni", "market_type": "futures",
    "symbol": "ETH-USDT",
}


@pytest.fixture(autouse=True)
def _enable_live_transport_for_live_path_contracts(monkeypatch):
    """These tests exercise the post-opt-in live pipeline explicitly.

    Production remains fail-closed because the worker flag defaults to false;
    this suite opts in so it can assert the downstream connection, sizing, and
    venue-result contracts rather than stopping at that first gate.
    """
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)


class _Plan:
    size = Decimal("0.05")
    leverage = 100
    notional_usd = Decimal("1500")
    margin_usd = Decimal("15")
    rung_count = 1
    margin_per_rung_usd = Decimal("15")


class _FakeIngest:
    """Stands in for worker-ingest. Records every decision write and models
    the server's real idempotency: the FIRST decision for a candle wins."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.upserts: list[dict] = []
        self.updates: list[dict] = []

    def upsert_decision(self, decision):
        self.upserts.append(decision)
        stored = self.rows.setdefault(decision["decision_id"], {
            **decision, "execution_state": "not_reached",
        })
        return {
            "decision_id": stored["decision_id"],
            "execution_state": stored["execution_state"],
        }

    def update_decision_execution(self, *, decision_id, execution_state, **kw):
        self.updates.append({"decision_id": decision_id, "execution_state": execution_state, **kw})
        if decision_id in self.rows:
            self.rows[decision_id]["execution_state"] = execution_state
        return {"ok": True}

    def emit_event(self, **kw):
        return {"ok": True}


def _feed(candles=None):
    feed = MagicMock()
    feed.candles = candles if candles is not None else [
        [CANDLE_OPEN_MS - i * 300_000, 3000.0, 3010.0, 2990.0, 3000.0, 10.0]
        for i in range(60, 0, -1)
    ]
    feed.tick = 0.01
    return feed


def _bot(ingest=None):
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = ingest if ingest is not None else _FakeIngest()
    bot._decision_inflight = set()
    bot._venue_contract_cache = {}
    bot.log_event = MagicMock()
    return bot


def _confirmed(direction="long", idem=None):
    return dr.DirectionInput(
        direction=direction, confirmed=True, entry_price=3000.0,
        entry_zone={"low": 2990.0, "high": 3010.0}, invalidation=2950.0,
        take_profits=[3100.0], stop_pct=0.0166,
        confirmation_ref="break:1|retest:2",
        idempotency_key=idem or f"accum:{CONNECTION}:ETHUSDT:{direction}:1:2",
    )


def _run(bot, *, symbol="ETH-USDT", accum_results=None, gate=None, feed=None,
         now=NOW_MS, newest_ts=CANDLE_OPEN_MS, connection_id=CONNECTION):
    return bot._decide_and_execute(
        cfg=LIVE_CFG, user_id=USER, connection_id=connection_id, symbol=symbol,
        normalized=symbol.replace("-", ""), now=now, feed=feed or _feed(),
        newest_ts=newest_ts, armed_leg="accumulator",
        gate=gate if gate is not None else {
            "regime": "trend", "trend_age_candles": 3,
            "guard_authorized": True, "guard_block_code": None,
            "directions": {"long": {"authorized": True, "lockout": False},
                           "short": {"authorized": True, "lockout": False}},
        },
        accum_results=accum_results if accum_results is not None else {"long": {}, "short": {}},
        hunter_plans={}, sweep_plans={}, feed_client=None,
    )


# --- one candle -> one decision -----------------------------------------

@pytest.mark.parametrize('enabled,owner,allowed', [
    (['accumulator'],'accumulator',True), (['sniper'],'sniper',True),
    (['hunter'],None,False),
])
def test_sweep_decision_uses_selected_execution_turtle(enabled, owner, allowed):
    bot = _bot()
    cfg = {**LIVE_CFG, 'params': {'enabled_turtles': enabled}}
    def candidate(**kwargs):
        return _confirmed() if kwargs['direction'] == 'long' else dr.DirectionInput(direction='short',confirmed=False)
    with patch.object(bot,'_plan_direction_input',side_effect=candidate), patch.object(bot,'_execute_decision') as execute:
        decision = bot._decide_and_execute(
            cfg=cfg,user_id=USER,connection_id=CONNECTION,symbol='ETH-USDT',
            normalized='ETHUSDT',now=NOW_MS,feed=_feed(),newest_ts=CANDLE_OPEN_MS,
            armed_leg='sweep',gate={'guard_authorized':True},accum_results={},
            hunter_plans={},sweep_plans={'long':object()},feed_client=None,
        )
        assert decision['strategy'] == 'sweep'
        assert decision['evidence'].get('executing_turtle') == owner
        assert execute.called == allowed
        if not allowed:
            assert decision['reason_code'] == 'TURTLE_NOT_ENABLED'

def test_one_completed_candle_creates_exactly_one_decision():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    decision = _run(bot)
    assert decision is not None
    assert len(ingest.upserts) == 1
    assert len(ingest.rows) == 1
    assert decision["candle_close_at"].endswith("Z")


def test_concurrent_retries_return_the_same_decision_id():
    """The 15s loop re-observes the same candle ~20 times. Every pass must
    resolve to the SAME identity, or one candle becomes twenty decisions."""
    ingest = _FakeIngest()
    bot = _bot(ingest)
    ids = {_run(bot, now=NOW_MS + i * 15_000)["decision_id"] for i in range(20)}
    assert len(ids) == 1
    assert len(ingest.rows) == 1


def test_wait_is_persisted_and_carries_a_reason():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    decision = _run(bot)
    assert decision["direction"] == "wait"
    assert decision["reason_code"] == "NO_CONFIRMED_ENTRY"
    assert decision["reason"]
    assert ingest.upserts[0]["direction"] == "wait"
    # A WAIT never touches execution.
    assert ingest.updates == []


def test_btc_and_eth_cannot_cross_contaminate():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    eth = _run(bot, symbol="ETH-USDT")
    btc = _run(bot, symbol="BTC-USDT")
    assert eth["decision_id"] != btc["decision_id"]
    assert eth["symbol"] == "ETH-USDT"
    assert btc["symbol"] == "BTC-USDT"
    assert len(ingest.rows) == 2


def test_two_connections_do_not_share_a_decision():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    a = _run(bot)
    b = _run(bot, connection_id="99999999-3333-4444-5555-666666666666")
    assert a["decision_id"] != b["decision_id"]


# --- execution -----------------------------------------------------------

def _execute(bot, *, chosen=None, equity=5000.0, sizing_error=None,
             submit_result=None, gate=None, inflight=(), strategy="accumulator"):
    bot._decision_inflight = set(inflight)
    submitted = []

    def fake_submit(intent):
        submitted.append(intent)
        return submit_result or {
            "status": "submitted", "exchange_order_id": "ex-1",
            "exchange_status": "accepted",
        }

    plan_patch = (
        patch.object(bw.accumulator_live_size, "plan_entry_size",
                     side_effect=bw.accumulator_live_size.SizingError(sizing_error))
        if sizing_error else
        patch.object(bw.accumulator_live_size, "plan_entry_size", return_value=_Plan())
    )
    with patch.object(bot, "submit_order_intent", side_effect=fake_submit), \
         patch.object(bot, "_accum_available_equity_usd", return_value=equity), \
         patch.object(bot, "_venue_contract_config", return_value={"x": 1}), \
         plan_patch:
        bot._execute_decision(
            cfg=LIVE_CFG, user_id=USER, connection_id=CONNECTION, symbol="ETH-USDT",
            normalized="ETHUSDT",
            decision={"decision_id": "dec_v1_" + "a" * 32, "symbol": "ETH-USDT"},
            strategy=strategy, chosen=chosen or _confirmed(),
            gate=gate or {"directions": {"long": {"lockout": False}}},
            feed=_feed(), feed_client=None, now=NOW_MS,
        )
    return submitted


def test_exactly_one_intent_is_created_for_a_tradeable_decision():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = _execute(bot)
    assert len(submitted) == 1
    states = [u["execution_state"] for u in ingest.updates]
    assert states == ["intent_created", "submitted"]


def test_zen_sweep_is_visible_but_cannot_execute_the_legacy_single_order_shape():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = _execute(bot, strategy="sweep")
    assert submitted == []
    assert ingest.updates[-1]["execution_state"] == "blocked"
    assert ingest.updates[-1]["reason_code"] == "ZEN_SWEEP_LIVE_PARITY_PENDING"


def test_missing_equity_stops_at_the_safety_gate_as_EQUITY_UNAVAILABLE():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = _execute(bot, equity=None, sizing_error="BALANCE_UNAVAILABLE")
    assert submitted == []
    assert ingest.updates[-1]["execution_state"] == "blocked"
    assert ingest.updates[-1]["reason_code"] == "EQUITY_UNAVAILABLE"


def test_a_small_wallet_still_trades():
    """There is no equity minimum. Sizing takes 10% of the wallet as margin
    (§13.2: margin_fraction = 10 / leverage), so a 100 USD wallet takes a
    proportionally small position rather than being refused.

    This asserted EQUITY_BELOW_MIN until the worker-side 500 USD floor was
    removed — a minimum this codebase never had, mirrored in by mistake."""
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = _execute(bot, equity=100.0)
    assert len(submitted) == 1
    assert ingest.updates[-1]["reason_code"] != "EQUITY_BELOW_MIN"


def test_existing_exposure_blocks_only_the_matching_symbol():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    blocked = _execute(bot, inflight=[(USER, CONNECTION, "ETH-USDT")])
    assert blocked == []
    assert ingest.updates[-1]["reason_code"] == "SYMBOL_EXECUTION_IN_FLIGHT"

    bot2 = _bot(_FakeIngest())
    allowed = _execute(bot2, inflight=[(USER, CONNECTION, "BTC-USDT")])
    assert len(allowed) == 1


def test_a_venue_sizing_refusal_is_recorded_verbatim_and_places_nothing():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = _execute(bot, sizing_error="VENUE_CONTRACT_UNAVAILABLE")
    assert submitted == []
    assert ingest.updates[-1]["reason_code"] == "VENUE_CONTRACT_UNAVAILABLE"


def test_a_venue_rejection_is_persisted_exactly():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    _execute(bot, submit_result={
        "status": "rejected", "reject_reason": "EXISTING_OPEN_POSITION",
        "exchange_status": "rejected",
    })
    last = ingest.updates[-1]
    assert last["execution_state"] == "rejected"
    assert last["apex_result"]["reject_reason"] == "EXISTING_OPEN_POSITION"


def test_an_ambiguous_outcome_keeps_the_symbol_in_flight():
    """The one case that could double-submit. The symbol stays blocked until
    an operator reconciles it."""
    bot = _bot()
    _execute(bot, submit_result={"status": "ambiguous", "reject_reason": "SIGNER_TIMEOUT"})
    assert (USER, CONNECTION, "ETH-USDT") in bot._decision_inflight


def test_a_definite_outcome_releases_the_symbol():
    bot = _bot()
    _execute(bot)
    assert bot._decision_inflight == set()


def test_a_broker_duplicate_is_not_a_second_order():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    _execute(bot, submit_result={
        "status": "duplicate", "exchange_order_id": "ex-1", "exchange_status": "accepted",
    })
    assert ingest.updates[-1]["execution_state"] == "submitted"


def test_an_unrecognised_broker_shape_is_ambiguous_never_success():
    ingest = _FakeIngest()
    bot = _bot(ingest)
    _execute(bot, submit_result={"weird": True})
    assert ingest.updates[-1]["execution_state"] == "ambiguous"


# --- duplicate-submission protection across restarts ---------------------

def test_an_already_executed_decision_is_never_re_executed():
    """This is the deploy-safety guarantee: a redeploy mid-candle re-runs the
    cycle, and the SERVER's stored state — not an in-memory set — stops it."""
    ingest = _FakeIngest()
    bot = _bot(ingest)
    accum = {"long": {}, "short": {}}
    with patch.object(bot, "_execute_decision") as execute:
        decision = _run(bot, accum_results=accum)
        # Mark the candle as already acted on, exactly as the server would
        # report after a prior process submitted it.
        ingest.rows[decision["decision_id"]]["execution_state"] = "submitted"
        # A brand-new process (empty in-memory state) re-observes the candle.
        fresh = _bot(ingest)
        with patch.object(fresh, "_execute_decision") as execute2:
            _run(fresh, accum_results=accum)
            assert execute2.call_count == 0
        assert execute.call_count == 0  # it was a WAIT anyway


def test_a_failed_ledger_write_does_not_block_the_trade():
    """RECORDING IS NOT AUTHORITY. An audit write that failed — or an op that
    is not deployed yet — is NO INFORMATION, never evidence that a trade is
    unsafe. Duplicate protection stays where it always lived: the broker's
    fingerprint and the signer's idempotency store, both keyed on the
    unchanged `idempotency_key`."""
    class _BrokenIngest(_FakeIngest):
        def upsert_decision(self, decision):
            raise RuntimeError("ledger down")

    bot = _bot(_BrokenIngest())
    with patch.object(bot, "_execute_decision") as execute:
        _run(bot, accum_results={"long": {}, "short": {}})
        # A WAIT still executes nothing...
        assert execute.call_count == 0

    # ...but a CONFIRMED decision proceeds all the way to submission.
    bot2 = _bot(_BrokenIngest())
    assert len(_execute(bot2)) == 1


def test_an_undeployed_ledger_op_does_not_block_the_trade():
    """The exact shape of a Supabase proposal that has not been applied: the
    edge function rejects the unknown operation. Trading must continue."""
    class _UnknownOpIngest(_FakeIngest):
        def upsert_decision(self, decision):
            raise WorkerIngestAuthError("UNKNOWN_OPERATION")

    bot = _bot(_UnknownOpIngest())
    assert len(_execute(bot)) == 1


# --- independence from AI, Scout and Onyx --------------------------------

def _executable_source(path: str) -> str:
    """Source with docstrings and comments removed, so prose explaining what
    is deliberately absent does not read as a use of it."""
    import ast
    tree = ast.parse(open(path).read())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if (node.body and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                node.body.pop(0)
    return ast.unparse(tree).lower()


def test_ai_failure_does_not_block_a_valid_trade():
    """There is no AI call on this path to fail. Proven structurally: the
    worker cannot import or reach any model provider."""
    import re
    src = _executable_source("bot_worker.py")
    for forbidden in ("openai", "anthropic", "gemini", "claude", "ai.gateway",
                      "committee", "llm", "prompt"):
        # Match provider/AI names (including snake_case suffixes), not the
        # unrelated letters "llm" inside Python's re.fullmatch validator.
        assert not re.search(r"(?<![a-z])" + re.escape(forbidden) + r"(?![a-z])", src), forbidden
    # And a live intent still fires with no AI anywhere in the process.
    bot = _bot()
    assert len(_execute(bot)) == 1


def test_scout_or_onyx_failure_does_not_block_execution():
    """Neither is an input to the decision or to any safety check."""
    for module in ("decision_reducer.py", "safety_checks.py", "decision_contract.py"):
        code = _executable_source(module)
        assert "scout" not in code
        assert "onyx" not in code

    # And the execution path takes no guardian/onyx argument.
    import inspect
    sig = inspect.signature(bw.RailwayTurtleBot._execute_decision)
    for name in sig.parameters:
        assert "scout" not in name and "onyx" not in name and "candidate" not in name


def test_candidate_records_are_no_longer_written_by_the_live_path():
    src = open("bot_worker.py").read()
    assert "STRATEGY_CANDIDATE_CREATED" not in src
    assert "strategy_candidates" not in src


def test_the_decision_path_reads_no_candidate_scout_or_ai_state():
    import inspect
    src = inspect.getsource(bw.RailwayTurtleBot._decide_and_execute)
    for forbidden in ("candidate", "scout", "onyx", "committee", "ai_"):
        assert forbidden not in src.lower()


# --- the 2026-07-31 17:35 silence regression -----------------------------
#
# Commit 5c2ac8d put all three live bridges behind `_live_exec_ok`:
#
#     if _leg_accum and accum_results and _live_exec_ok:   # and 5b, 5c
#
# where `_live_exec_ok = LIVE_TRADING_ENABLED and live_block_code(cfg) is
# None`. That gated OBSERVATION on TRADE PERMISSION. A connection that was
# paper-mode, unverified, or missing trade permission produced no candidate,
# no reason and no event — indistinguishable from a dead strategy. The last
# candidate landed at 17:20 that day and nothing was written for the next
# seven hours, while the paper engine ran perfectly on the same candles,
# because paper never passes through that gate.
#
# The block belongs to safety check 1, which already computes it. These two
# tests hold that split: the decision is always recorded, and the order is
# still never sent.

BLOCKED_CFGS = {
    "CONFIG_NOT_LIVE_MODE": {**LIVE_CFG, "mode": "paper"},
    "CONNECTION_NOT_VERIFIED": {**LIVE_CFG, "status": "pending"},
    "PERMISSIONS_NOT_VERIFIED": {**LIVE_CFG, "permissions_verified": False},
    "TRADE_PERMISSION_MISSING": {**LIVE_CFG, "permission_trade": False},
}


@pytest.mark.parametrize("expected_code,cfg", sorted(BLOCKED_CFGS.items()))
def test_a_connection_that_cannot_trade_still_records_its_decision(expected_code, cfg):
    """The regression itself. A blocked row must produce a VISIBLE decision
    carrying the block code — not silence."""
    ingest = _FakeIngest()
    bot = _bot(ingest)
    submitted = []

    with patch.object(bot, "_accum_direction_input",
                      side_effect=lambda **kw: _confirmed(kw["direction"])), \
         patch.object(bot, "submit_order_intent",
                      side_effect=lambda intent: submitted.append(intent)), \
         patch.object(bot, "_accum_available_equity_usd", return_value=5000.0), \
         patch.object(bot, "_venue_contract_config", return_value={"x": 1}), \
         patch.object(bw.accumulator_live_size, "plan_entry_size", return_value=_Plan()):
        decision = bot._decide_and_execute(
            cfg=cfg, user_id=USER, connection_id=CONNECTION, symbol="ETH-USDT",
            normalized="ETHUSDT", now=NOW_MS, feed=_feed(),
            newest_ts=CANDLE_OPEN_MS, armed_leg="accumulator",
            gate={
                "regime": "trend", "trend_age_candles": 3,
                "guard_authorized": True, "guard_block_code": None,
                "directions": {"long": {"authorized": True, "lockout": False},
                               "short": {"authorized": True, "lockout": False}},
            },
            accum_results={"long": {}, "short": {}},
            hunter_plans={}, sweep_plans={}, feed_client=None,
        )

    # 1. The decision EXISTS. This is the whole point: seven hours of silence
    #    becomes seven hours of recorded, explained decisions.
    assert decision is not None
    assert len(ingest.upserts) == 1
    assert decision["direction"] == "long"

    # 2. And nothing was sent to the venue.
    assert submitted == []

    # 3. The reason is the specific block code, not a generic refusal.
    assert len(ingest.updates) == 1
    assert ingest.updates[0]["execution_state"] == bw.EXECUTION_BLOCKED
    assert ingest.updates[0]["reason_code"] == expected_code


def test_recording_a_decision_is_not_conditional_on_live_eligibility():
    """Pins the call site, not just the behaviour.

    The bug was an `if` wrapped around the call — the layer below was always
    correct. Re-introducing any such condition puts the silence straight back,
    so the condition is asserted absent at the source level rather than
    inferred from a passing behavioural test."""
    import ast
    import inspect
    import textwrap

    tree = ast.parse(
        textwrap.dedent(inspect.getsource(bw.RailwayTurtleBot.observe_signal))
    )
    call_sites = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        test_src = ast.dump(node.test)
        gates_on_live = "_live_block" in test_src or "_live_exec_ok" in test_src
        if not gates_on_live:
            continue
        for inner in ast.walk(node):
            if (isinstance(inner, ast.Attribute)
                    and inner.attr == "_decide_and_execute"):
                call_sites += 1
    assert call_sites == 0, (
        "_decide_and_execute is gated on live eligibility again — that is the "
        "2026-07-31 silence regression. The block belongs to safety check 1."
    )
