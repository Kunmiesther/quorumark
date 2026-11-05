"""Execution pipeline: preflight, protection failure -> fail-closed unwind,
reduce-only exits, and reconciliation by client_order_id."""
from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any

import pytest

from app.builder import BuildInput, build_order
from app.execution import (
    ExecutionRequest, PipelineError, Protection,
    create_campaign_pipeline, create_order_pipeline, preflight, reconcile,
)
from app.orders_v3 import OrderRestError


BUILT = build_order(BuildInput(
    symbol="BTC-USDT", side="BUY", mark_price="60000", leverage=100,
    capital_baseline_usd="6", tick_size="0.1", step_size="0.001",
    decimals=8, l2_pair_id=1, taker_fee_rate="0.0005", maker_fee_rate="0.0002",
))

PROTS = (
    Protection(kind="STOP", trigger_price="58800", size="0.005", order_type="STOP_MARKET"),
    Protection(kind="TP1",  trigger_price="61200", size="0.002", order_type="TAKE_PROFIT_MARKET"),
    Protection(kind="TP2",  trigger_price="62400", size="0.002", order_type="TAKE_PROFIT_MARKET"),
    Protection(kind="TP3",  trigger_price="63600", size="0.001", order_type="TAKE_PROFIT_MARKET"),
)


class FakeSigner:
    def __init__(self): self.calls = []
    def sign(self, **kw):
        self.calls.append(kw)
        return {"signature": "SIG-" + kw["client_order_id"]}


class FakeRest:
    def __init__(self, *, fail_protection_index=None, get_positions=None, get_orders=None):
        self.created: list[dict] = []
        self.cancelled: list[str] = []
        self._fail_idx = fail_protection_index
        self._positions = get_positions or []
        self._orders = get_orders or []
        self._create_calls = 0
    def create_order(self, params):
        i = self._create_calls
        self._create_calls += 1
        if self._fail_idx is not None and i == self._fail_idx:
            raise OrderRestError("UPSTREAM_REJECT")
        self.created.append(params)
        return {"venue_order_id": f"V{i}", "client_order_id": params.get("clientOrderId"), "status": "accepted"}
    def cancel_by_client_order_id(self, coid): self.cancelled.append(coid); return {"id": coid}
    def get_open_orders(self, symbol=None): return self._orders
    def get_positions(self): return self._positions


def _req():
    return ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id="coid-1",
        environment="mainnet", built=BUILT, protections=PROTS,
    )


# --- preflight ---------------------------------------------------------

def test_kill_switch_blocks_entry():
    with pytest.raises(PipelineError) as e:
        preflight(equity_usd=Decimal("1000"), open_orders_for_symbol=[],
                  open_positions_for_symbol=[], kill_switch_halted=True)
    assert e.value.code == "KILL_SWITCH_ACTIVE"


def test_there_is_no_wallet_size_minimum():
    """499 USD used to be refused outright by MIN_EQUITY_USD = 500. There is
    no wallet-size minimum: sizing is 10% of the wallet as margin (§13.2), so
    a small wallet takes a small position."""
    preflight(equity_usd=Decimal("499"), open_orders_for_symbol=[],
              open_positions_for_symbol=[], kill_switch_halted=False)
    preflight(equity_usd=Decimal("120"), open_orders_for_symbol=[],
              open_positions_for_symbol=[], kill_switch_halted=False)


def test_the_ratified_reserve_floor_still_binds():
    """What replaces it is not a minimum but a RESERVE: ACCOUNT_FLOOR_USD is
    `allocation_reserve_floor_usd` from shared/mainnet_parity_constants.json,
    whose stated rule is that the reserve NEVER goes on-desk. Changing it is
    a one-line edit to that shared JSON, not to the signer."""
    with pytest.raises(PipelineError) as e:
        preflight(equity_usd=Decimal("10"), open_orders_for_symbol=[],
                  open_positions_for_symbol=[], kill_switch_halted=False)
    assert e.value.code == "EQUITY_BELOW_FLOOR"


def test_funding_gate_uses_total_equity_not_locked_free_collateral():
    # Real owner state: $510.77 total, $369.03 free with margin locked in an
    # open BTC position. A funded account must not read as de-funded.
    preflight(
        equity_usd=Decimal("369.03"),
        total_equity_usd=Decimal("510.77"),
        required_margin_usd=Decimal("60"),
        open_orders_for_symbol=[], open_positions_for_symbol=[],
        kill_switch_halted=False,
    )


def test_free_collateral_must_cover_reserve_floor_plus_order_margin():
    with pytest.raises(PipelineError) as e:
        preflight(
            equity_usd=Decimal("120"),
            total_equity_usd=Decimal("900"),
            required_margin_usd=Decimal("60"),
            open_orders_for_symbol=[], open_positions_for_symbol=[],
            kill_switch_halted=False,
        )
    assert e.value.code == "INSUFFICIENT_FREE_COLLATERAL"


def test_free_collateral_below_reserve_floor_blocks():
    with pytest.raises(PipelineError) as e:
        preflight(
            equity_usd=Decimal("50"),
            total_equity_usd=Decimal("900"),
            open_orders_for_symbol=[], open_positions_for_symbol=[],
            kill_switch_halted=False,
        )
    assert e.value.code == "EQUITY_BELOW_FLOOR"



def test_existing_position_blocks_single_position_rule():
    with pytest.raises(PipelineError) as e:
        preflight(equity_usd=Decimal("1000"), open_orders_for_symbol=[],
                  open_positions_for_symbol=[{"symbol": "BTC-USDT"}], kill_switch_halted=False)
    assert e.value.code == "EXISTING_OPEN_POSITION"


def test_existing_order_blocks_by_default():
    with pytest.raises(PipelineError) as e:
        preflight(equity_usd=Decimal("1000"),
                  open_orders_for_symbol=[{"symbol": "BTC-USDT"}],
                  open_positions_for_symbol=[], kill_switch_halted=False)
    assert e.value.code == "EXISTING_OPEN_ORDER"


def test_proof_of_life_exemption_skips_existing_order_and_position():
    # Scoped bypass: proof-of-life may stack alongside existing exposure.
    preflight(
        equity_usd=Decimal("1000"),
        open_orders_for_symbol=[{"symbol": "BTC-USDT"}],
        open_positions_for_symbol=[{"symbol": "BTC-USDT"}],
        kill_switch_halted=False,
        allow_existing_exposure=True,
    )


def test_proof_of_life_exemption_still_enforces_kill_switch_and_equity():
    with pytest.raises(PipelineError) as e:
        preflight(equity_usd=Decimal("1000"),
                  open_orders_for_symbol=[], open_positions_for_symbol=[],
                  kill_switch_halted=True, allow_existing_exposure=True)
    assert e.value.code == "KILL_SWITCH_ACTIVE"
    with pytest.raises(PipelineError) as e2:
        preflight(equity_usd=Decimal("10"),
                  open_orders_for_symbol=[{"symbol": "BTC-USDT"}],
                  open_positions_for_symbol=[], kill_switch_halted=False,
                  allow_existing_exposure=True)
    assert e2.value.code == "EQUITY_BELOW_FLOOR"



# --- happy path --------------------------------------------------------

class AttachedSlRest(FakeRest):
    """FakeRest mirroring the SDK's atomic TP/SL attachment: when the entry
    carries `attached_sl`, the response includes `sl_venue_order_id`."""
    def create_order(self, params):
        i = self._create_calls
        self._create_calls += 1
        if self._fail_idx is not None and i == self._fail_idx:
            raise OrderRestError("UPSTREAM_REJECT")
        self.created.append(params)
        resp = {"venue_order_id": f"V{i}", "client_order_id": params.get("clientId"), "status": "accepted"}
        if params.get("attached_sl"):
            resp["sl_venue_order_id"] = f"V{i}-SL"
        return resp


def test_pipeline_attaches_stop_to_entry_and_places_tps():
    rest = AttachedSlRest()
    result = create_order_pipeline(_req(), rest, nonce_seed=1000)
    assert len(rest.created) == 4, "1 entry (with attached SL) + 3 TPs"
    entry = rest.created[0]
    assert entry["reduceOnly"] == "false"
    assert entry["attached_sl"]["side"] == "SELL"
    assert entry["attached_sl"]["trigger_price"] == "58800"
    for prot in rest.created[1:]:
        assert prot["reduceOnly"] == "true"
        assert prot["side"] == "SELL"
        assert prot["triggerPrice"]
    assert result.status == "submitted"
    assert result.protection_venue_ids["STOP"] == "V0-SL"
    assert {"STOP", "TP1", "TP2", "TP3"} <= set(result.protection_venue_ids)


def test_default_build_uses_shared_sixty_dollar_margin():
    rest = AttachedSlRest()
    create_order_pipeline(_req(), rest, nonce_seed=1)
    entry = rest.created[0]
    assert entry["size"] == BUILT.size == "0.1"
    assert Decimal(BUILT.notional_usd) == Decimal("6000")


# --- protection failure behavior --------------------------------------

def test_tp_failure_does_not_unwind_when_stop_is_attached():
    # STOP is armed atomically with entry, so a later TP failure must NOT
    # unwind — it degrades to log + reconcile.
    rest = AttachedSlRest(fail_protection_index=1)
    result = create_order_pipeline(_req(), rest, nonce_seed=1)
    assert result.status == "submitted"
    assert result.protection_venue_ids["STOP"] == "V0-SL"
    assert "TP1_FAILED" in result.protection_venue_ids
    assert rest.cancelled == []


def test_entry_reject_raises_without_unwind():
    rest = AttachedSlRest(fail_protection_index=0)
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_req(), rest, nonce_seed=1)
    assert e.value.code.startswith("ENTRY_SUBMIT_FAILED")


def test_missing_attached_stop_confirmation_unwinds_and_refuses():
    rest = FakeRest()
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_req(), rest, nonce_seed=1)
    assert e.value.code == "PROTECTION_UNCONFIRMED:STOP"
    assert e.value.accepted_orders == (("coid-1", "V0"),)
    assert "coid-1" in rest.cancelled


def _campaign_requests():
    limit_built = replace(BUILT, order_type="LIMIT")
    stop = (Protection(kind="STOP", trigger_price="58000", size=BUILT.size,
                       order_type="STOP_MARKET"),)
    return tuple(replace(
        _req(), intent_id=f"intent-{i}", client_order_id=f"campaign-r{i}",
        built=limit_built, protections=stop,
    ) for i in range(1, 6))


def test_five_rung_campaign_submits_every_rung_with_confirmed_stop():
    rest = AttachedSlRest()
    result = create_campaign_pipeline(_campaign_requests(), rest, nonce_seed=100)
    assert result.status == "submitted"
    assert len(result.orders) == 5
    assert all(order.protection_venue_ids.get("STOP") for order in result.orders)
    assert [row["clientId"] for row in rest.created] == [
        f"campaign-r{i}" for i in range(1, 6)
    ]


def test_campaign_keeps_accepted_id_when_first_rung_stop_is_unconfirmed():
    requests = _campaign_requests()
    with pytest.raises(PipelineError) as error:
        create_campaign_pipeline(requests, FakeRest(), nonce_seed=100)
    assert error.value.accepted_orders == (("campaign-r1", "V0"),)
    assert error.value.unattempted_client_ids == tuple(r.client_order_id for r in requests[1:])


def test_campaign_partial_failure_cancels_prior_rungs_and_closes_position():
    rest = AttachedSlRest(
        fail_protection_index=2,
        get_positions=[{"symbol": "BTC-USDT", "side": "LONG", "size": "0.2"}],
    )
    with pytest.raises(PipelineError) as e:
        create_campaign_pipeline(_campaign_requests(), rest, nonce_seed=100)
    assert e.value.code.startswith("CAMPAIGN_PARTIAL_FAILURE:")
    assert {"campaign-r1", "campaign-r1-stop", "campaign-r2", "campaign-r2-stop"} <= set(rest.cancelled)
    close = rest.created[-1]
    assert close["reduceOnly"] == "true"
    assert close["side"] == "SELL"
    assert close["size"] == "0.2"


# --- proof-of-life: entry-only, no protections, no unwind -------------

def _proof_req():
    return ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id="pol-1",
        environment="mainnet", built=BUILT, protections=(),
    )


def test_proof_of_life_submits_entry_only_no_protections_no_unwind():
    rest = AttachedSlRest()
    result = create_order_pipeline(_proof_req(), rest, nonce_seed=1,
                                   allow_no_protections=True)
    assert result.status == "submitted"
    assert result.venue_order_id == "V0"
    assert result.protection_venue_ids == {}
    # Exactly one order — the entry MARKET. No STOP, no TP ladder.
    assert len(rest.created) == 1
    entry = rest.created[0]
    assert entry["reduceOnly"] == "false"
    assert "attached_sl" not in entry
    # No unwind cancels.
    assert rest.cancelled == []


def test_proof_of_life_entry_reject_does_not_unwind():
    rest = AttachedSlRest(fail_protection_index=0)
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_proof_req(), rest, nonce_seed=1,
                              allow_no_protections=True)
    assert e.value.code.startswith("ENTRY_SUBMIT_FAILED")
    assert rest.cancelled == []


def test_strategy_purpose_still_requires_exit_plan():
    # allow_no_protections defaults to False → strategy orders MUST carry
    # an exit plan. Empty protections must be refused with NO_EXIT_PLAN.
    rest = AttachedSlRest()
    empty = ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id="s-1",
        environment="mainnet", built=BUILT, protections=(),
    )
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(empty, rest, nonce_seed=1)
    assert e.value.code == "NO_EXIT_PLAN"
    assert rest.created == []


def test_strategy_purpose_still_attaches_protections():
    # Positive control: with a populated protections tuple and the default
    # allow_no_protections=False, the pipeline still atomically attaches
    # the STOP and places the TP ladder.
    rest = AttachedSlRest()
    result = create_order_pipeline(_req(), rest, nonce_seed=1)
    assert result.protection_venue_ids["STOP"] == "V0-SL"
    assert {"TP1", "TP2", "TP3"} <= set(result.protection_venue_ids)
    entry = rest.created[0]
    assert entry["attached_sl"]["trigger_price"] == "58800"




# --- reconcile by client_order_id -------------------------------------

def test_reconcile_matches_by_client_order_id_not_venue_id():
    rest = FakeRest(get_orders=[
        {"id": "VX", "clientOrderId": "coid-1", "status": "OPEN", "symbol": "BTC-USDT"},
        {"id": "VY", "clientOrderId": "stray", "status": "OPEN", "symbol": "BTC-USDT"},
    ], get_positions=[{"symbol": "BTC-USDT", "size": "0.005", "side": "LONG"}])
    seen = []
    def on_match(coid, row): seen.append((coid, row["kind"]))
    report = reconcile(rest, known_client_ids=["coid-1"], on_match=on_match)
    assert report.matched == 1
    assert report.unknown_venue_orders == ["VY"]
    # Both the matched order and the position drove the callback.
    kinds = [k for _, k in seen]
    assert "order" in kinds and "position" in kinds


def test_reconcile_after_timeout_never_double_submits():
    # Simulates restart recovery: pipeline call timed out mid-submit; a
    # venue order exists. Reconcile must NOT try to re-create it.
    rest = FakeRest(get_orders=[
        {"id": "VX", "clientOrderId": "coid-1", "status": "OPEN", "symbol": "BTC-USDT"},
    ])
    reconcile(rest, known_client_ids=["coid-1"], on_match=lambda *_: None)
    assert rest.created == [], "reconcile MUST NOT create orders"


class ReceiptSlRest(FakeRest):
    """The adapter verified the venue's openSlParam; no child ID exists yet."""
    def create_order(self, params):
        response = super().create_order(params)
        if params.get("attached_sl"):
            response["sl_attachment_confirmed"] = True
        return response


def test_pipeline_accepts_verified_attachment_receipt_without_child_order_id():
    rest = ReceiptSlRest()
    result = create_order_pipeline(_req(), rest, nonce_seed=1)
    assert result.status == "submitted"
    assert result.stop_attachment_confirmed is True
    assert "STOP" not in result.protection_venue_ids
    assert rest.cancelled == []


def test_campaign_accepts_independently_verified_attachment_on_every_rung():
    rest = ReceiptSlRest()
    result = create_campaign_pipeline(_campaign_requests(), rest, nonce_seed=1)
    assert len(result.orders) == 5
    assert all(order.stop_attachment_confirmed for order in result.orders)
    assert all("STOP" not in order.protection_venue_ids for order in result.orders)
    assert rest.cancelled == []


def test_truthy_unverified_attachment_is_not_accepted():
    class UnverifiedRest(FakeRest):
        def create_order(self, params):
            response = super().create_order(params)
            response["sl_attachment_confirmed"] = "true"
            return response
    rest = UnverifiedRest()
    with pytest.raises(PipelineError, match="PROTECTION_UNCONFIRMED:STOP"):
        create_order_pipeline(_req(), rest, nonce_seed=1)
    assert "coid-1" in rest.cancelled


@pytest.mark.parametrize("failed_index", [0, 1, 2, 3, 4])
@pytest.mark.parametrize("unexpected", [False, True])
def test_campaign_preserves_never_submitted_rungs(monkeypatch, failed_index, unexpected):
    from app import execution
    requests = _campaign_requests()
    attempts = []
    def submit(req, *_a, **_kw):
        attempts.append(req.client_order_id)
        if len(attempts)-1 == failed_index:
            if unexpected:
                raise RuntimeError("private transport detail")
            raise PipelineError("PROTECTION_UNCONFIRMED:STOP")
        return execution.ExecutionResult("venue-"+req.client_order_id, {}, "submitted")
    monkeypatch.setattr(execution, "create_order_pipeline", submit)
    with pytest.raises(PipelineError) as error:
        create_campaign_pipeline(requests, FakeRest(), nonce_seed=1)
    assert error.value.unattempted_client_ids == tuple(r.client_order_id for r in requests[failed_index+1:])
    assert error.value.accepted_orders == tuple((r.client_order_id, "venue-"+r.client_order_id) for r in requests[:failed_index])
    assert len(attempts) == failed_index+1
    assert "private transport detail" not in error.value.code


def test_unsubmitted_campaign_is_not_counted_as_venue_rejection():
    from app.order_store import is_venue_rejection
    assert not is_venue_rejection('rejected','CAMPAIGN_NOT_SUBMITTED')
    assert not is_venue_rejection('rejected','CAMPAIGN_RESERVATION_INCOMPLETE')
    assert is_venue_rejection('rejected','VENUE_REJECTED')
