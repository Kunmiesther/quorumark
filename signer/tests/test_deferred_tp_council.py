"""Deferred take-profit lifecycle at the signer boundary.

Owner directive (2026-08-04): NO take-profit is attached or submitted at
entry. The entry carries its atomically-attached STOP and nothing else. TP
arrives later as a SEPARATE reduce-only order once the council has reviewed
the position after three fully closed candles.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.builder import BuildInput, build_order
from app.execution import (
    ExecutionRequest, PipelineError, Protection, create_order_pipeline,
)

BUILT = build_order(BuildInput(
    symbol="ETH-USDT", side="BUY", mark_price="3000", leverage=100,
    capital_baseline_usd="6", tick_size="0.1", step_size="0.01",
    decimals=8, l2_pair_id=2, taker_fee_rate="0.0005", maker_fee_rate="0.0002",
    size_override="0.05",
))

STOP = Protection(kind="STOP", trigger_price="2850", size="0.05",
                  order_type="STOP_MARKET")


class Rest:
    def __init__(self):
        self.created: list[dict] = []
        self.cancelled: list[str] = []
        self.positions: list[dict] = []
        self._i = 0

    def create_order(self, params):
        i = self._i
        self._i += 1
        self.created.append(params)
        resp = {"venue_order_id": f"V{i}", "client_order_id": params.get("clientId"),
                "status": "accepted"}
        if params.get("attached_sl"):
            resp["sl_venue_order_id"] = f"V{i}-SL"
        return resp

    def cancel_by_client_order_id(self, coid):
        self.cancelled.append(coid)
        return {"id": coid}

    def get_open_orders(self, symbol=None): return []
    def get_positions(self): return self.positions


def _entry(protections=(STOP,)):
    return ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id="coid-entry",
        environment="mainnet", built=BUILT, protections=protections,
    )


def _exit_req(coid="tpc:pos-1:1", protections=()):
    return ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id=coid,
        environment="mainnet", built=BUILT, protections=protections,
        reduce_only=True,
    )


# --- entry carries a stop and NOTHING else ------------------------------

def test_entry_places_exactly_one_order_with_attached_stop_and_no_tp():
    rest = Rest()
    result = create_order_pipeline(_entry(), rest, nonce_seed=1)
    assert len(rest.created) == 1, "entry only — no TP legs at entry"
    entry = rest.created[0]
    assert entry["reduceOnly"] == "false"
    assert entry["attached_sl"]["trigger_price"] == "2850"
    assert result.protection_venue_ids == {"STOP": "V0-SL"}
    # No take-profit was placed or recorded.
    assert not any(k.startswith("TP") for k in result.protection_venue_ids)


def test_entry_still_refuses_to_run_without_a_stop():
    """Deferring TP must not weaken invalidation: an entry with no exit plan
    is still refused."""
    rest = Rest()
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_entry(protections=()), rest, nonce_seed=1)
    assert e.value.code == "NO_EXIT_PLAN"
    assert rest.created == []


# --- deferred TP arrives as a separate reduce-only order ----------------

def test_council_tp_is_a_standalone_reduce_only_order():
    rest = Rest()
    result = create_order_pipeline(_exit_req(), rest, nonce_seed=1)
    assert len(rest.created) == 1
    order = rest.created[0]
    assert order["reduceOnly"] == "true", "REDUCE-ONLY IS ABSOLUTE"
    assert "attached_sl" not in order
    assert result.status == "submitted"
    assert result.protection_venue_ids == {}
    # A reduce-only exit never unwinds anything.
    assert rest.cancelled == []


def test_reduce_only_exit_refuses_to_carry_protections():
    rest = Rest()
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_exit_req(protections=(STOP,)), rest, nonce_seed=1)
    assert e.value.code == "REDUCE_ONLY_TAKES_NO_PROTECTIONS"
    assert rest.created == []


def test_reduce_only_submit_failure_surfaces_its_own_code():
    class Failing(Rest):
        def create_order(self, params):
            from app.orders_v3 import OrderRestError
            raise OrderRestError("UPSTREAM_REJECT")

    rest = Failing()
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_exit_req(), rest, nonce_seed=1)
    assert e.value.code.startswith("EXIT_SUBMIT_FAILED")
    # Failure to place a TP never unwinds or closes the position.
    assert rest.cancelled == []


def test_duplicate_review_reuses_the_same_client_order_id():
    """The council review key IS the client order id, so a duplicate review
    after a restart hits venue/idempotency-store dedupe instead of opening a
    second TP."""
    a = _exit_req()
    b = _exit_req()
    assert a.client_order_id == b.client_order_id == "tpc:pos-1:1"


def test_reduce_only_size_is_the_caller_size_not_a_resized_entry():
    assert Decimal(BUILT.size) == Decimal("0.05")
    rest = Rest()
    create_order_pipeline(_exit_req(), rest, nonce_seed=1)
    assert rest.created[0]["size"] == "0.05"
