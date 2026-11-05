"""Base module transaction submission; never interprets acceptance as a fill.

This transport is intentionally not an activation endpoint. The account adapter
must first verify ownership, registered bytecode, current session, position and
protective-exit coverage. No user wallet key or raw bytes cross worker-ingest.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from eth_utils import keccak, to_checksum_address

from .synfutures_reconciliation import (
    CHAIN_ID, EXECUTE_TRADE_SELECTOR, HASH, validate_transaction,
    validate_trade_input, BaseReadRpc,
)


class SynFuturesSubmissionError(ValueError):
    pass


class BaseSubmissionRpc(BaseReadRpc):
    """Signer-only transport; no generic RPC method or request-selected URL."""
    METHODS = BaseReadRpc.METHODS | {
        "eth_call", "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice",
        "eth_getBalance", "eth_sendRawTransaction",
    }


@dataclass(frozen=True)
class SubmissionLimits:
    max_gas: int
    max_fee_per_gas: int
    max_total_gas_cost: int

    def validate(self):
        if any(type(v) is not int or v <= 0 for v in (
            self.max_gas, self.max_fee_per_gas, self.max_total_gas_cost
        )):
            raise SynFuturesSubmissionError("SYNFUTURES_GAS_LIMITS_REQUIRED")


def encode_trade(row: dict[str, Any], *, limit_tick: int, deadline: int) -> str:
    """Encode exactly the deployed module's static Trade tuple, with no rounding."""
    validate_transaction(row)
    if type(limit_tick) is not int or not -(2**23) <= limit_tick < 2**23:
        raise SynFuturesSubmissionError("SYNFUTURES_PRICE_BOUND_INVALID")
    if type(deadline) is not int or not 0 < deadline < 2**32:
        raise SynFuturesSubmissionError("SYNFUTURES_DEADLINE_INVALID")
    words = [int(row["module_revision"]), int(row["module_nonce"]),
             int(row["instrument_address"], 16), int(row["signed_size"]) % 2**256,
             int(row["margin"]), limit_tick % 2**256, deadline, int(row["reduce_only"])]
    data = "0x" + EXECUTE_TRADE_SELECTOR + "".join(format(word, "064x") for word in words)
    validate_trade_input(data, row)
    return data


def _quantity(value: Any) -> int:
    # RPC quantities must be canonical integers; bool/float are never accepted.
    from .synfutures_reconciliation import quantity
    return quantity(value)


def submit_module_transaction(*, db, rpc, account, row: dict[str, Any],
                              limit_tick: int, deadline: int, session_valid_until: int,
                              limits: SubmissionLimits,
                              verified_account: bool = False,
                              protective_exit_ready: bool = False):
    """Simulate, sign locally, durably reserve, then attempt exactly one broadcast.

    `account` is a private-signer-local eth_account account, not request input.
    Verification flags must be supplied by the account adapter, never a browser
    or worker payload. A database reservation replay cannot grant another send.
    """
    if verified_account is not True:
        raise SynFuturesSubmissionError("SYNFUTURES_ACCOUNT_UNVERIFIED")
    if row.get("reduce_only") is not True and protective_exit_ready is not True:
        raise SynFuturesSubmissionError("SYNFUTURES_PROTECTIVE_EXIT_REQUIRED")
    limits.validate()
    record = dict(row)
    # The signed hash is computed below; a caller cannot select it.
    record["tx_hash"] = "0x" + "00" * 32
    try:
        validate_transaction(record)
        if _quantity(rpc("eth_chainId", [])) != CHAIN_ID:
            raise SynFuturesSubmissionError("SYNFUTURES_RPC_CHAIN_MISMATCH")
        if account.address.lower() != record["operator_address"].lower():
            raise SynFuturesSubmissionError("SYNFUTURES_OPERATOR_MISMATCH")
        block = rpc("eth_getBlockByNumber", ["latest", False])
        if not isinstance(block, dict):
            raise SynFuturesSubmissionError("SYNFUTURES_BLOCK_UNAVAILABLE")
        timestamp = _quantity(block.get("timestamp"))
        # v1 requires an active session for reductions too. Never claim an
        # expired-session exit can execute through this deployed module.
        if (type(session_valid_until) is not int or
                not timestamp < deadline <= min(session_valid_until, timestamp + 300)):
            raise SynFuturesSubmissionError("SYNFUTURES_SESSION_DEADLINE_INVALID")
        pending_nonce = _quantity(rpc("eth_getTransactionCount", [account.address, "pending"]))
        if pending_nonce != int(record["operator_nonce"]):
            raise SynFuturesSubmissionError("SYNFUTURES_OPERATOR_NONCE_CHANGED")
        data = encode_trade(record, limit_tick=limit_tick, deadline=deadline)
        call = {"from": account.address, "to": to_checksum_address(record["module_address"]),
                "value": "0x0", "data": data}
        # executeTrade has no return value. Unexpected ABI data is not success.
        if rpc("eth_call", [call, "pending"]) != "0x":
            raise SynFuturesSubmissionError("SYNFUTURES_SIMULATION_UNCONFIRMED")
        estimate = _quantity(rpc("eth_estimateGas", [call]))
        gas = (estimate * 120 + 99) // 100
        gas_price = _quantity(rpc("eth_gasPrice", []))
        if (estimate <= 0 or gas_price <= 0 or gas > limits.max_gas or
                gas_price > limits.max_fee_per_gas or gas * gas_price > limits.max_total_gas_cost):
            raise SynFuturesSubmissionError("SYNFUTURES_GAS_ABOVE_LIMIT")
        if _quantity(rpc("eth_getBalance", [account.address, "pending"])) < gas * gas_price:
            raise SynFuturesSubmissionError("SYNFUTURES_OPERATOR_GAS_REQUIRED")
        signed = account.sign_transaction({"chainId": CHAIN_ID, "nonce": pending_nonce,
            "to": call["to"], "value": 0, "data": data, "gas": gas, "gasPrice": gas_price})
        # eth-account version compatibility; raw bytes remain in this process.
        raw = getattr(signed, "raw_transaction", None)
        if raw is None:
            raw = signed.rawTransaction
        tx_hash = "0x" + keccak(raw).hex()
        if bytes(signed.hash) != bytes(keccak(raw)):
            raise SynFuturesSubmissionError("SYNFUTURES_SIGNED_HASH_MISMATCH")
        record["tx_hash"] = tx_hash
    except SynFuturesSubmissionError:
        raise
    except Exception:
        # Provider/key errors can carry secrets. Return a bounded code only.
        raise SynFuturesSubmissionError("SYNFUTURES_PREFLIGHT_UNAVAILABLE") from None

    transaction = {key: record[key] for key in (
        "operator_address", "module_address", "safe_address", "instrument_address",
        "operator_nonce", "module_revision", "module_nonce", "signed_size", "margin",
        "reduce_only", "tx_hash")}
    scope = {key: record[key] for key in ("user_id", "connection_id", "intent_id")}
    try:
        reservation = db.reserve_synfutures_transaction(**scope, transaction=transaction)
    except Exception:
        # The commit might have succeeded. No broadcast without an exact receipt.
        raise SynFuturesSubmissionError("SYNFUTURES_RESERVATION_UNCONFIRMED") from None
    if (not isinstance(reservation, dict) or reservation.get("tx_hash") != tx_hash or
            type(reservation.get("created")) is not bool):
        raise SynFuturesSubmissionError("SYNFUTURES_RESERVATION_UNCONFIRMED")
    if reservation["created"] is False:
        return {"status": "reconciliation_required", "tx_hash": tx_hash, "broadcast_attempted": False}

    try:
        observed_hash = rpc("eth_sendRawTransaction", ["0x" + bytes(raw).hex()])
        accepted = (isinstance(observed_hash, str) and HASH.fullmatch(observed_hash) is not None
                    and observed_hash.lower() == tx_hash)
    except Exception:
        accepted = False
    state = "broadcast" if accepted else "unknown"
    try:
        db.observe_synfutures_transaction(**scope, tx_hash=tx_hash, state=state)
    except Exception:
        # Reservation already preserves the signed hash and in-flight lock.
        return {"status": "reconciliation_required", "tx_hash": tx_hash,
                "broadcast_attempted": True, "reason": "SYNFUTURES_OBSERVATION_UNCONFIRMED"}
    return {"status": "submitted" if accepted else "reconciliation_required",
            "tx_hash": tx_hash, "broadcast_attempted": True}
