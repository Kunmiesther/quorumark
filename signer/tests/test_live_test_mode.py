"""LIVE TEST MODE — owner's no-SL/no-TP entry phase.

Guards the two invariants that make this branch safe to run against real
money: it is OFF by default (standard policy keeps its attached stop), and
it never selects isolated margin.
"""
from __future__ import annotations

import pytest

from app.builder import BuildInput, build_order
from app.execution import (
    ExecutionRequest, PipelineError, Protection, create_order_pipeline,
)
from app.test_mode import (
    LIVE_TEST_MODE_ENV, MarginModeViolation, assert_cross_margin,
    entry_without_protections, live_test_mode_enabled,
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
    def get_positions(self): return []


def _req(protections=()):
    return ExecutionRequest(
        intent_id="i", user_id="u", connection_id="c", client_order_id="coid-test",
        environment="mainnet", built=BUILT, protections=protections,
    )


# --- the switch ---------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("1", True), ("true", True), ("TRUE", True), ("yes", True), ("on", True),
    ("0", False), ("false", False), ("", False), ("maybe", False),
])
def test_flag_parsing_is_strict(raw, expected):
    assert live_test_mode_enabled({LIVE_TEST_MODE_ENV: raw}) is expected


def test_off_by_default_absent_env():
    assert live_test_mode_enabled({}) is False


def test_reduce_only_and_proof_paths_are_never_relabelled_as_test_mode():
    env = {LIVE_TEST_MODE_ENV: "1"}
    assert entry_without_protections(reduce_only=True, proof_exempt=False, env=env) is False
    assert entry_without_protections(reduce_only=False, proof_exempt=True, env=env) is False
    assert entry_without_protections(reduce_only=False, proof_exempt=False, env=env) is True


def test_flag_off_leaves_standard_policy_alone():
    assert entry_without_protections(reduce_only=False, proof_exempt=False, env={}) is False


def test_automated_entries_keep_stop_even_when_manual_test_mode_is_on():
    env = {LIVE_TEST_MODE_ENV: "1"}
    assert entry_without_protections(
        reduce_only=False, proof_exempt=False, purpose="AUTOMATED_ENTRY", env=env,
    ) is False
    assert entry_without_protections(
        reduce_only=False, proof_exempt=False, purpose="CREATE_ORDER", env=env,
    ) is True


# --- entry shape under test mode ---------------------------------------

def test_test_mode_entry_has_no_stop_and_no_take_profit():
    """The pipeline call the endpoint makes in test mode: empty protections
    plus allow_no_protections=True → exactly one bare entry order."""
    rest = Rest()
    result = create_order_pipeline(_req(), rest, nonce_seed=1, allow_no_protections=True)
    assert len(rest.created) == 1
    entry = rest.created[0]
    assert "attached_sl" not in entry, "NO stop-loss attached at entry"
    assert entry["reduceOnly"] == "false"
    assert result.protection_venue_ids == {}, "no TP, no SL recorded"
    assert rest.cancelled == []


def test_standard_policy_still_refuses_a_bare_entry_when_flag_is_off():
    """Regression fence: nothing about test mode weakens the default path."""
    rest = Rest()
    with pytest.raises(PipelineError) as e:
        create_order_pipeline(_req(), rest, nonce_seed=1)
    assert e.value.code == "NO_EXIT_PLAN"
    assert rest.created == []


def test_standard_policy_still_attaches_the_stop_when_flag_is_off():
    rest = Rest()
    result = create_order_pipeline(_req(protections=(STOP,)), rest, nonce_seed=1)
    assert rest.created[0]["attached_sl"]["trigger_price"] == "2850"
    assert result.protection_venue_ids["STOP"] == "V0-SL"


# --- CROSS ONLY ---------------------------------------------------------

def test_entry_payload_names_no_margin_mode_at_all():
    rest = Rest()
    create_order_pipeline(_req(), rest, nonce_seed=1, allow_no_protections=True)
    entry = rest.created[0]
    for key in ("marginMode", "margin_mode", "isIsolated", "isolated", "positionMode"):
        assert key not in entry


@pytest.mark.parametrize("params", [
    {"marginMode": "ISOLATED"},
    {"margin_mode": "isolated"},
    {"isIsolated": "true"},
    {"isolated": True},
])
def test_isolated_margin_is_refused(params):
    with pytest.raises(MarginModeViolation) as e:
        assert_cross_margin(params)
    assert "ISOLATED_MARGIN_FORBIDDEN" in str(e.value)


@pytest.mark.parametrize("params", [
    {}, {"marginMode": "CROSS"}, {"margin_mode": "cross"}, {"isIsolated": "false"},
])
def test_cross_margin_passes(params):
    assert_cross_margin(params)
