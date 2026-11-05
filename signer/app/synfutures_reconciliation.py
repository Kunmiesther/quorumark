"""SynFutures Base receipt recovery. Never signs, sends, replaces or cancels.

The module emits TradeExecuted only after checking the actual position delta.
A successful Ethereum receipt alone does not prove a trade. Require the exact
module/revision/nonce/instrument/size/margin/reduce-only event AND Base finality.
No confirmations-count shortcut; unavailable finality remains unknown.
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

CHAIN_ID = 8453
TRADE_EVENT = "0xd30fc077f557f3bd2c3d33492ca9e2fdc07c706e9c63cd06cd4af18be61062fb"
HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
MARKETS = {"0xec6c44e704eb1932ec5fe1e4aba58db6fee71460", "0x04d72fb4803b4e02f14971e5bd092375eb330749"}
# executeTrade((uint256,uint256,address,int128,uint128,int24,uint32,bool))
EXECUTE_TRADE_SELECTOR = "a901d1e3"


class SynFuturesObservationError(Exception):
    pass


def require(condition):
    if not condition:
        raise SynFuturesObservationError("SYNFUTURES_RECEIPT_UNCONFIRMED")


def quantity(value):
    require(isinstance(value, str) and re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value) is not None)
    return int(value, 16)


def same_hex(a, b, pattern):
    return isinstance(a, str) and isinstance(b, str) and bool(pattern.fullmatch(a)) and a.lower() == b.lower()


def exact_integer(value):
    require(isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value) is not None)
    return int(value)


class BaseReadRpc:
    """Read-only allowlist. The URL is server configuration, never request input."""
    METHODS = {"eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"}

    def __init__(self, endpoint=None):
        self._endpoint = endpoint or os.environ.get("TURTLEBOT_BASE_RPC_URL")
        parsed = urlparse(self._endpoint or "")
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise SynFuturesObservationError("SYNFUTURES_BASE_RPC_NOT_CONFIGURED")

    def __call__(self, method, params):
        require(method in self.METHODS)
        import requests
        try:
            response = requests.post(self._endpoint, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                                     timeout=(3, 8), allow_redirects=False)
            response.raise_for_status()
            body = response.json()
            require(isinstance(body, dict) and body.get("id") == 1 and body.get("jsonrpc") == "2.0"
                    and "error" not in body and "result" in body)
            return body["result"]
        except Exception:
            # RPC URLs may contain API keys. Never surface exception/response text.
            raise SynFuturesObservationError("SYNFUTURES_RPC_UNAVAILABLE") from None


def validate_transaction(row):
    require(row.get("chain_id") == CHAIN_ID and row.get("instrument_address") in MARKETS)
    for key in ("operator_address", "module_address", "safe_address"):
        require(isinstance(row.get(key), str) and ADDRESS.fullmatch(row[key]) is not None and int(row[key], 16) != 0)
    require(len({row[k].lower() for k in ("operator_address", "module_address", "safe_address")}) == 3)
    require(isinstance(row.get("tx_hash"), str) and HASH.fullmatch(row["tx_hash"]) is not None)
    for key, maximum in (("operator_nonce", 2**64 - 1), ("module_revision", 2**256 - 1),
                         ("module_nonce", 2**256 - 1), ("margin", 2**127 - 1)):
        require(0 <= exact_integer(row.get(key)) <= maximum)
    require(0 < abs(exact_integer(row.get("signed_size"))) <= 2**127 - 1)
    require(type(row.get("reduce_only")) is bool and (not row["reduce_only"] or row["margin"] == "0"))


def validate_trade_input(data, row):
    """Bind the mined call to the journal, including canonical ABI encoding.

    The tuple is static: exactly eight words, no offsets or trailing calls.
    Price tick/deadline aren't stored by the legacy journal, so validate their
    ABI widths, not an invented expected price/time. The signed hash binds them;
    the module enforces these fields and the on-chain session when executing.
    """
    require(isinstance(data, str) and re.fullmatch(r"0x[0-9a-fA-F]{520}", data) is not None)
    require(data[2:10].lower() == EXECUTE_TRADE_SELECTOR)
    words = [int(data[i:i+64], 16) for i in range(10, len(data), 64)]
    require(words[:5] == [exact_integer(row["module_revision"]), exact_integer(row["module_nonce"]),
                         int(row["instrument_address"], 16), exact_integer(row["signed_size"]) % 2**256,
                         exact_integer(row["margin"])])
    # int24 must be sign-extended to 256 bits, not merely masked to 24 bits.
    tick = words[5] if words[5] < 2**255 else words[5] - 2**256
    require(-(2**23) <= tick < 2**23 and 0 < words[6] < 2**32 and words[7] == int(row["reduce_only"]))


def observe_transaction(row, rpc, *, include_provisional=False):
    validate_transaction(row)
    require(quantity(rpc("eth_chainId", [])) == CHAIN_ID)
    receipt = rpc("eth_getTransactionReceipt", [row["tx_hash"]])
    if receipt is None:
        return {"state": "unknown"}
    require(isinstance(receipt, dict) and same_hex(receipt.get("transactionHash"), row["tx_hash"], HASH))
    require(same_hex(receipt.get("from"), row["operator_address"], ADDRESS)
            and same_hex(receipt.get("to"), row["module_address"], ADDRESS))
    block_number = quantity(receipt.get("blockNumber"))
    block_hash = receipt.get("blockHash")
    require(isinstance(block_hash, str) and HASH.fullmatch(block_hash) is not None)
    finalized = rpc("eth_getBlockByNumber", ["finalized", False])
    require(isinstance(finalized, dict) and HASH.fullmatch(str(finalized.get("hash", ""))) is not None)
    is_finalized = quantity(finalized.get("number")) >= block_number
    if not is_finalized and not include_provisional:
        return {"state": "unknown"}
    canonical = rpc("eth_getBlockByNumber", [hex(block_number), False])
    require(isinstance(canonical, dict) and quantity(canonical.get("number")) == block_number
            and same_hex(canonical.get("hash"), block_hash, HASH))
    tx = rpc("eth_getTransactionByHash", [row["tx_hash"]])
    require(isinstance(tx, dict) and same_hex(tx.get("hash"), row["tx_hash"], HASH)
            and same_hex(tx.get("from"), row["operator_address"], ADDRESS)
            and same_hex(tx.get("to"), row["module_address"], ADDRESS)
            and quantity(tx.get("nonce")) == exact_integer(row["operator_nonce"])
            and quantity(tx.get("chainId")) == CHAIN_ID
            and quantity(tx.get("value")) == 0
            and quantity(tx.get("blockNumber")) == block_number
            and same_hex(tx.get("blockHash"), block_hash, HASH))
    validate_trade_input(tx.get("input"), row)
    status = quantity(receipt.get("status"))
    require(status in (0, 1))
    if status == 1:
        logs = receipt.get("logs")
        require(isinstance(logs, list))
        events = [log for log in logs if isinstance(log, dict)
                  and same_hex(log.get("address"), row["module_address"], ADDRESS)
                  and isinstance(log.get("topics"), list) and log["topics"]
                  and same_hex(log["topics"][0], TRADE_EVENT, HASH)]
        require(len(events) == 1)
        event = events[0]
        topics = event["topics"]
        require(event.get("removed") is False and len(topics) == 4
                and all(isinstance(t, str) and HASH.fullmatch(t) for t in topics)
                and same_hex(event.get("transactionHash"), row["tx_hash"], HASH)
                and same_hex(event.get("blockHash"), block_hash, HASH)
                and quantity(event.get("blockNumber")) == block_number)
        require(int(topics[1], 16) == exact_integer(row["module_revision"])
                and int(topics[2], 16) == exact_integer(row["module_nonce"])
                and int(topics[3], 16) == int(row["instrument_address"], 16))
        data = event.get("data")
        require(isinstance(data, str) and re.fullmatch(r"0x[0-9a-fA-F]{192}", data) is not None)
        words = [int(data[2+i:2+i+64], 16) for i in (0, 64, 128)]
        # ABI int128 is sign-extended to 256 bits. Comparison of the complete
        # word also rejects noncanonical signed encodings and extra data.
        require(words == [exact_integer(row["signed_size"]) % (2**256), exact_integer(row["margin"]), int(row["reduce_only"])])
    if not is_finalized:
        # A fully bound, canonical but unfinalized success may authorize only
        # risk-reducing protection. Never report it as a finalized fill or
        # release entry capacity. Recheck this proof on every monitor pass.
        return {"state": "mined", "block": block_number, "block_hash": block_hash.lower()} if status else {"state": "unknown"}
    return {"state": "confirmed" if status else "reverted", "block": block_number, "block_hash": block_hash.lower()}


def reconcile_connection(*, db, rpc, user_id, connection_id):
    rows = db.list_synfutures_transactions(user_id=user_id, connection_id=connection_id)
    require(isinstance(rows, list) and len(rows) <= 20)
    unknown = 0
    for row in rows:
        require(isinstance(row, dict) and row.get("user_id") == user_id and row.get("connection_id") == connection_id)
        try:
            observation = observe_transaction(row, rpc)
        except (SynFuturesObservationError, KeyError, TypeError, ValueError):
            observation = {"state": "unknown"}
        # Persistence failure is not swallowed or reported as successful sync.
        db.observe_synfutures_transaction(user_id=user_id, connection_id=connection_id,
            intent_id=row["intent_id"], tx_hash=row["tx_hash"], **observation)
        unknown += observation["state"] == "unknown"
    return {"status": "reconciled", "reconciliation_required": unknown > 0, "observed": len(rows), "unknown": unknown}
