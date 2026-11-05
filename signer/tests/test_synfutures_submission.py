from unittest.mock import Mock

import pytest
from eth_account import Account
from eth_utils import keccak

from app.synfutures_submission import (
    SubmissionLimits, SynFuturesSubmissionError, encode_trade, submit_module_transaction,
)
from app.synfutures_reconciliation import validate_trade_input


@pytest.fixture
def execution():
    account = Account.from_key(bytes.fromhex("11" * 32))  # Test-only account.
    row = dict(user_id="00000000-0000-4000-8000-000000000001",
        connection_id="00000000-0000-4000-8000-000000000002",
        intent_id="00000000-0000-4000-8000-000000000003", chain_id=8453,
        operator_address=account.address.lower(), module_address="0x" + "22" * 20,
        safe_address="0x" + "33" * 20,
        instrument_address="0xec6c44e704eb1932ec5fe1e4aba58db6fee71460",
        operator_nonce="6", module_revision="2", module_nonce="4",
        signed_size="1000000000000000", margin="1000000000000000000", reduce_only=False,
        tx_hash="0x" + "00" * 32)
    events = []
    responses = {"eth_chainId": "0x2105", "eth_getBlockByNumber": {"timestamp": "0x3e8"},
        "eth_getTransactionCount": "0x6", "eth_call": "0x", "eth_estimateGas": "0x186a0",
        "eth_gasPrice": "0x64", "eth_getBalance": "0xffffffffff"}
    def rpc(method, params):
        events.append(method)
        if method == "eth_sendRawTransaction":
            raw = bytes.fromhex(params[0][2:])
            assert Account.recover_transaction(raw).lower() == account.address.lower()
            return "0x" + keccak(raw).hex()
        return responses[method]
    db = Mock()
    def reserve(**kwargs):
        events.append("reserve")
        assert "raw" not in str(kwargs)
        return {"created": True, "tx_hash": kwargs["transaction"]["tx_hash"]}
    db.reserve_synfutures_transaction.side_effect = reserve
    return dict(db=db, rpc=Mock(side_effect=rpc), account=account, row=row,
        limit_tick=-100, deadline=1100, session_valid_until=1200,
        limits=SubmissionLimits(200000, 200, 50000000),
        verified_account=True, protective_exit_ready=True), responses, events


def test_signs_real_transaction_and_commits_before_single_send(execution):
    args, _, events = execution
    result = submit_module_transaction(**args)
    assert result["status"] == "submitted"  # Never "filled" or "confirmed".
    assert events.index("eth_call") < events.index("reserve") < events.index("eth_sendRawTransaction")
    assert events.count("eth_sendRawTransaction") == 1
    args["db"].observe_synfutures_transaction.assert_called_once()
    assert args["db"].observe_synfutures_transaction.call_args.kwargs["state"] == "broadcast"


@pytest.mark.parametrize("flag,code", [
    ("verified_account", "ACCOUNT_UNVERIFIED"),
    ("protective_exit_ready", "PROTECTIVE_EXIT_REQUIRED"),
])
def test_unverified_authority_or_unprotected_entry_never_signs_or_sends(execution, flag, code):
    args, _, _ = execution
    args[flag] = False
    with pytest.raises(SynFuturesSubmissionError, match=code):
        submit_module_transaction(**args)
    args["rpc"].assert_not_called()
    args["db"].reserve_synfutures_transaction.assert_not_called()


@pytest.mark.parametrize("method,value,code", [
    ("eth_chainId", "0x1", "CHAIN_MISMATCH"),
    ("eth_getTransactionCount", "0x7", "NONCE_CHANGED"),
    ("eth_call", "0x00", "SIMULATION_UNCONFIRMED"),
    ("eth_estimateGas", "0xfffffff", "GAS_ABOVE_LIMIT"),
    ("eth_gasPrice", "0xfffffff", "GAS_ABOVE_LIMIT"),
    ("eth_getBalance", "0x0", "OPERATOR_GAS_REQUIRED"),
])
def test_preflight_failure_never_reserves_or_broadcasts(execution, method, value, code):
    args, responses, events = execution
    responses[method] = value
    with pytest.raises(SynFuturesSubmissionError, match=code):
        submit_module_transaction(**args)
    args["db"].reserve_synfutures_transaction.assert_not_called()
    assert "eth_sendRawTransaction" not in events


def test_reservation_timeout_never_grants_broadcast(execution):
    args, _, events = execution
    args["db"].reserve_synfutures_transaction.side_effect = TimeoutError("secret RPC URL")
    with pytest.raises(SynFuturesSubmissionError, match="^SYNFUTURES_RESERVATION_UNCONFIRMED$"):
        submit_module_transaction(**args)
    assert "eth_sendRawTransaction" not in events


def test_replay_does_not_send_again(execution):
    args, _, events = execution
    args["db"].reserve_synfutures_transaction.side_effect = lambda **kwargs: {
        "created": False, "tx_hash": kwargs["transaction"]["tx_hash"]}
    assert submit_module_transaction(**args)["broadcast_attempted"] is False
    assert "eth_sendRawTransaction" not in events


def test_rpc_timeout_after_send_preserves_unknown_without_retry(execution):
    args, _, events = execution
    original = args["rpc"].side_effect
    def timeout(method, params):
        if method == "eth_sendRawTransaction":
            events.append(method)
            raise TimeoutError("sensitive provider URL")
        return original(method, params)
    args["rpc"].side_effect = timeout
    result = submit_module_transaction(**args)
    assert result["status"] == "reconciliation_required"
    assert events.count("eth_sendRawTransaction") == 1
    assert args["db"].observe_synfutures_transaction.call_args.kwargs["state"] == "unknown"


def test_failed_post_send_journal_keeps_reserved_hash(execution):
    args, _, events = execution
    args["db"].observe_synfutures_transaction.side_effect = TimeoutError("sensitive")
    result = submit_module_transaction(**args)
    assert result["status"] == "reconciliation_required"
    assert result["reason"] == "SYNFUTURES_OBSERVATION_UNCONFIRMED"
    assert events.count("eth_sendRawTransaction") == 1


def test_reduce_only_requires_active_session_in_deployed_v1(execution):
    args, _, events = execution
    args["row"].update(reduce_only=True, margin="0", signed_size="-1000000000000000")
    args["protective_exit_ready"] = False
    args["session_valid_until"] = 1000
    with pytest.raises(SynFuturesSubmissionError, match="SESSION_DEADLINE_INVALID"):
        submit_module_transaction(**args)
    assert "eth_sendRawTransaction" not in events


def test_active_reduction_can_submit_without_entry_protection_flag(execution):
    args, _, _ = execution
    args["row"].update(reduce_only=True, margin="0", signed_size="-1000000000000000")
    args["protective_exit_ready"] = False
    assert submit_module_transaction(**args)["status"] == "submitted"


def test_negative_tick_and_size_are_sign_extended_without_rounding(execution):
    args, _, _ = execution
    row = args["row"]
    row.update(reduce_only=True, margin="0", signed_size="-1000000000000000")
    data = encode_trade(row, limit_tick=-100, deadline=1100)
    validate_trade_input(data, row)
    assert len(data) == 522


@pytest.mark.parametrize("key,value", [("signed_size", "1.5"), ("margin", "1e18"),
    ("operator_nonce", "06"), ("reduce_only", "true")])
def test_no_numeric_coercion_of_exact_abi_units(execution, key, value):
    args, _, events = execution
    args["row"][key] = value
    with pytest.raises(SynFuturesSubmissionError, match="PREFLIGHT_UNAVAILABLE"):
        submit_module_transaction(**args)
    assert "eth_sendRawTransaction" not in events
