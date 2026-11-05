"""Signer-owned, block-pinned Base account and quote adapter. Read-only preflight.

The deployed immediate-trade module cannot implement the current five-rung
campaign or native stops. This adapter never fabricates either capability.
"""
import time
from eth_abi import encode, decode
from eth_utils import keccak
from .synfutures_reconciliation import quantity, ADDRESS, HASH
from .synfutures_submission import BaseSubmissionRpc
from .synfutures_entry import require, plan_entry, SynFuturesEntryError
from shared.synfutures_math import WAD, decimal_wad

OBSERVER = "0xdb166a6e454d2a273cd50ccd6420703564b2a830"
GATE = "0x208b443983d8bcc8578e9d86db23fba547071270"
CONFIG = "0xb63902d38738e353f3f52add203c418a0bfea172"
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
SINGLETON = "0x29fcb43b46531bca003ddc8fcb67ffe91900c762"
SINGLETON_HASH = "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff"
MARKETS = {"BTC-USDC": "0xec6c44e704eb1932ec5fe1e4aba58db6fee71460",
           "ETH-USDC": "0x04d72fb4803b4e02f14971e5bd092375eb330749"}
QUOTE = "(uint256,uint160,int24,uint256,uint256,uint256,uint256,uint160,int24)"
POSITION = "(int128,int128,uint128,uint128,int128)"
SETTING = "(string,address,address,address,address,uint8,uint16,uint16,(uint128,uint16,uint16,uint64,uint8,uint128))"


def preflight_entry(*, db, rpc, user_id, connection_id, symbol, margin_usdc, leverage, long, now=None):
    require(symbol in MARKETS, "SYNFUTURES_SYMBOL_UNSUPPORTED")
    context = db.synfutures_account_context(user_id=user_id, connection_id=connection_id)
    require(isinstance(context, dict) and context.get("chain_id") == 8453,
            "SYNFUTURES_BINDING_UNCONFIRMED")
    require(context.get("live_entry_allowed") is True, "SYNFUTURES_LIVE_PERMISSION_REQUIRED")
    require(db.is_execution_halted(user_id, connection_id, require_live=True) is False,
            "SYNFUTURES_EXECUTION_HALTED")
    require(quantity(rpc("eth_chainId", [])) == 8453, "SYNFUTURES_CHAIN_MISMATCH")
    block = rpc("eth_getBlockByNumber", ["latest", False])
    clock = int(time.time()) if now is None else now
    require(isinstance(block, dict) and isinstance(block.get("hash"), str) and HASH.fullmatch(block["hash"])
            and 0 <= clock - quantity(block.get("timestamp")) <= 30, "SYNFUTURES_BLOCK_STALE")
    at = {"blockHash": block["hash"], "requireCanonical": True}
    safe, module, owner = (context.get(k) for k in ("safe_address", "module_address", "owner_address"))
    require(all(isinstance(x, str) and ADDRESS.fullmatch(x) and int(x, 16) != 0 for x in (safe, module, owner)),
            "SYNFUTURES_BINDING_UNCONFIRMED")
    for address, field in ((safe, "safe_proxy_code_hash"), (module, "module_code_hash")):
        code = rpc("eth_getCode", [address, at])
        require(isinstance(code, str) and code != "0x"
                and "0x" + keccak(bytes.fromhex(code[2:])).hex() == context.get(field),
                "SYNFUTURES_CODE_CHANGED")
    slot = rpc("eth_getStorageAt", [safe, "0x" + "00" * 32, at])
    singleton_code = rpc("eth_getCode", [SINGLETON, at])
    require(slot == "0x" + "00" * 12 + SINGLETON[2:] and isinstance(singleton_code, str)
            and "0x" + keccak(bytes.fromhex(singleton_code[2:])).hex() == SINGLETON_HASH,
            "SYNFUTURES_SAFE_IMPLEMENTATION_CHANGED")
    def call(address, signature, types=(), args=(), outputs=()):
        data = "0x" + (keccak(text=signature)[:4] + encode(types, args)).hex()
        result = rpc("eth_call", [{"to": address, "data": data}, at])
        require(isinstance(result, str) and result.startswith("0x"), "SYNFUTURES_CALL_UNCONFIRMED")
        return decode(outputs, bytes.fromhex(result[2:]))
    owners = call(safe, "getOwners()", outputs=["address[]"])[0]
    require(len(owners) == 1 and owners[0].lower() == owner
            and call(safe, "getThreshold()", outputs=["uint256"])[0] == 1
            and call(module, "safe()", outputs=["address"])[0].lower() == safe,
            "SYNFUTURES_OWNER_CHANGED")
    enabled = call(safe, "isModuleEnabled(address)", ["address"], [module], ["bool"])[0]
    session = call(module, "session()", outputs=["address", "uint48", "uint128", "uint128", "uint16"])
    require(enabled and int(session[0], 16) != 0 and session[1] > clock,
            "SYNFUTURES_OPERATOR_SESSION_REQUIRED")
    require(session[2] >= session[3], "SYNFUTURES_SESSION_INVALID")
    instrument = MARKETS[symbol]
    limits = call(module, "marketLimits(address)", ["address"], [instrument], ["uint128", "uint128", "uint128", "uint16"])
    require(all(x > 0 for x in limits), "SYNFUTURES_MARKET_DISABLED")
    setting = call(OBSERVER, "getSetting(address)", ["address"], [instrument], [SETTING])[0]
    require(setting[1].lower() == CONFIG and setting[2].lower() == GATE and setting[4].lower() == USDC
            and setting[5] == 6 and 0 < setting[6] <= 10_000, "SYNFUTURES_VENUE_MISMATCH")
    require(call(GATE, "config()", outputs=["address"])[0].lower() == CONFIG, "SYNFUTURES_VENUE_MISMATCH")
    reserve = call(GATE, "reserveOf(address,address)", ["address", "address"], [USDC, safe], ["uint256"])[0]
    positions, portfolio_notional = {}, 0
    for market in MARKETS.values():
        position = call(OBSERVER, "getPosition(address,uint32,address)", ["address", "uint32", "address"],
                        [market, 2**32-1, safe], [POSITION])[0]
        positions[market] = position
        if position[1]:
            valuation = call(market, "inquire(uint32,int256)", ["uint32", "int256"],
                             [2**32-1, position[1]], [QUOTE])[0]
            require(valuation[3] > 0, "SYNFUTURES_POSITION_VALUE_UNCONFIRMED")
            portfolio_notional += max(position[2], abs(position[1]) * valuation[3] // WAD)
    journals = db.list_synfutures_transactions(user_id=user_id, connection_id=connection_id)
    require(isinstance(journals, list) and not any(r.get("state") in ("prepared", "broadcast", "unknown") for r in journals),
            "SYNFUTURES_TRANSACTION_IN_FLIGHT")
    margin = decimal_wad(margin_usdc)
    require(type(leverage) is int and 1 <= leverage <= min(33, limits[3]), "SYNFUTURES_LEVERAGE_ABOVE_LIMIT")
    def quote(notional):
        size, q = call(OBSERVER, "inquireByNotional(address,uint32,uint256,bool)",
                       ["address", "uint32", "uint256", "bool"], [instrument, 2**32-1, notional, long], ["int256", QUOTE])
        return {"size": size, "mark": q[3], "entry_notional": q[4], "fee": q[5], "min_amount": q[6]}
    q = quote(margin * leverage)
    position = positions[instrument]
    # Fees consume margin; request a smaller native quote rather than increasing
    # collateral or executing above the selected leverage. Never round size.
    net = position[0] + margin - q["fee"]
    require(net > 0, "SYNFUTURES_FEE_EXCEEDS_MARGIN")
    notional_limit = min(net * leverage, net * 10_000 // setting[6])
    if q["entry_notional"] > notional_limit:
        q = quote(notional_limit)
    account = {"available_margin": reserve * 10**12, "budget_remaining": session[2] - session[3],
               "max_size": limits[0], "max_notional": limits[1], "max_margin": limits[2], "max_leverage": limits[3],
               "minimum_margin": setting[8][0], "initial_margin_ratio": setting[6],
               "portfolio_notional": portfolio_notional, "portfolio_limit": session[2] * leverage,
               "slippage_bps": session[4], "position_balance": position[0], "position_size": position[1],
               "position_notional": position[2]}
    plan = plan_entry(margin_usdc=margin_usdc, leverage=leverage, long=long, quote=q, account=account)
    canonical = rpc("eth_getBlockByNumber", [block["number"], False])
    require(isinstance(canonical, dict) and canonical.get("hash") == block["hash"], "SYNFUTURES_BLOCK_CHANGED")
    return {**plan, "observed_block": str(quantity(block["number"])), "operator_address": session[0],
            "session_valid_until": session[1]}


class BaseAccountRpc(BaseSubmissionRpc):
    METHODS = BaseSubmissionRpc.METHODS | {"eth_getCode", "eth_getStorageAt", "eth_getLogs"}


def evaluate_entry_request(*, db, rpc, **request):
    plan = preflight_entry(db=db, rpc=rpc, **request)
    # #3 has no verified protective-exit adapter yet. Caller flags never
    # substitute for it. Do not insert an intent or consume a daily campaign.
    return {"status": "rejected", "reject_reason": "SYNFUTURES_PROTECTIVE_EXIT_REQUIRED",
            "preflight": {k: plan[k] for k in ("signed_size", "margin", "entry_notional", "fee", "observed_block")}}
