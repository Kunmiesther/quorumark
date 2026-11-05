"""Aster Futures V3 authenticated transport.

Aster uses an EVM agent wallet, not ApeX HMAC/STARK credentials.  This module
keeps that boundary explicit: callers provide the master wallet address, the
approved agent address, and the agent private key decrypted for the duration of
one signer request.  Nothing in this file logs or returns key material.

Official protocol reference:
https://github.com/asterdex/api-docs/blob/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md
"""
from __future__ import annotations

import threading
import time
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable
from urllib.parse import urlencode

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data


BASE_URL = "https://fapi.asterdex.com"
MAX_LEVERAGE = 125  # Futures V3 ceiling; authenticated symbol brackets may be lower.
TIMEOUT_SECONDS = 10
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

_nonce_lock = threading.Lock()
_last_nonce = 0


class AsterV3Error(Exception):
    """Stable error safe to return from the private signer."""

    def __init__(self, code: str, *, ambiguous: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.ambiguous = ambiguous


@dataclass(frozen=True)
class AsterCredentials:
    user: str
    signer: str
    private_key: str

    def validated(self) -> "AsterCredentials":
        user = self.user.strip()
        signer = self.signer.strip()
        private_key = self.private_key.strip()
        if not _is_address(user) or not _is_address(signer):
            raise AsterV3Error("INVALID_ASTER_ADDRESS")
        try:
            derived = Account.from_key(private_key).address
        except Exception as exc:
            raise AsterV3Error("INVALID_ASTER_AGENT_KEY") from exc
        if derived.lower() != signer.lower():
            raise AsterV3Error("ASTER_AGENT_KEY_MISMATCH")
        return AsterCredentials(user=user, signer=signer, private_key=private_key)


def _is_address(value: str) -> bool:
    if len(value) != 42 or not value.startswith("0x"):
        return False
    try:
        int(value[2:], 16)
    except ValueError:
        return False
    return True


def next_nonce() -> int:
    """Return a process-monotonic microsecond nonce.

    Aster rejects reused nonces at the agent-address level.  A lock plus a
    monotonic floor prevents collisions between concurrent signer requests.
    """
    global _last_nonce
    with _nonce_lock:
        candidate = time.time_ns() // 1_000
        _last_nonce = max(candidate, _last_nonce + 1)
        return _last_nonce


def _typed_message(message: str) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Message": [{"name": "msg", "type": "string"}],
        },
        "primaryType": "Message",
        "domain": {
            "name": "AsterSignTransaction",
            "version": "1",
            "chainId": 1666,
            "verifyingContract": ZERO_ADDRESS,
        },
        "message": {"msg": message},
    }


def signed_fields(
    credentials: AsterCredentials,
    params: Iterable[tuple[str, Any]] = (),
    *,
    nonce: int | None = None,
) -> list[tuple[str, str]]:
    """Build the exact URL-encoded message and append its EIP-712 signature."""
    creds = credentials.validated()
    fields = [(key, str(value)) for key, value in params if value is not None]
    fields.extend(
        [
            ("nonce", str(nonce if nonce is not None else next_nonce())),
            ("user", creds.user),
            ("signer", creds.signer),
        ],
    )
    message = urlencode(fields)
    signable = encode_typed_data(full_message=_typed_message(message))
    signature = Account.sign_message(signable, private_key=creds.private_key).signature.hex()
    fields.append(("signature", signature))
    return fields


def _map_status(status: int, *, mutating: bool = False) -> AsterV3Error:
    if status == 503 or (mutating and status >= 500):
        return AsterV3Error("ASTER_EXECUTION_UNKNOWN", ambiguous=True)
    if status in (401, 403):
        return AsterV3Error("ASTER_AUTH_OR_REGION_REJECTED")
    if status in (418, 429):
        return AsterV3Error("ASTER_RATE_LIMITED")
    if status >= 500:
        return AsterV3Error("ASTER_UNAVAILABLE")
    return AsterV3Error("ASTER_REQUEST_REJECTED")


def _aster_error(body: Any) -> AsterV3Error | None:
    """Map documented venue codes without returning the provider response body."""
    if not isinstance(body, dict) or not isinstance(body.get("code"), int):
        return None
    if body["code"] == -5050:
        return AsterV3Error("ASTER_MAIN_WALLET_DEPOSIT_REQUIRED")
    if body["code"] < 0:
        return AsterV3Error(f"ASTER_{abs(body['code'])}")
    return None


def request(
    method: str,
    path: str,
    credentials: AsterCredentials,
    params: Iterable[tuple[str, Any]] = (),
) -> Any:
    method = method.upper()
    if method not in {"GET", "POST", "DELETE"}:
        raise AsterV3Error("ASTER_METHOD_NOT_ALLOWED")
    fields = signed_fields(credentials, params)
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "TurtleBot-Signer/1.0",
    }
    try:
        response = requests.request(
            method,
            f"{BASE_URL}{path}",
            params=fields if method == "GET" else None,
            data=fields if method != "GET" else None,
            headers=headers,
            timeout=TIMEOUT_SECONDS,
        )
    except requests.Timeout as exc:
        # A timeout after a mutating request is ambiguous.  Reconciliation,
        # never blind retry, must decide whether the venue accepted it.
        raise AsterV3Error(
            "ASTER_EXECUTION_UNKNOWN" if method != "GET" else "ASTER_TIMEOUT",
            ambiguous=method != "GET",
        ) from exc
    except requests.RequestException as exc:
        raise AsterV3Error("ASTER_NETWORK_ERROR", ambiguous=method != "GET") from exc
    if not response.ok:
        # A mutating 5xx is always uncertain, even if it has a JSON body.
        # Never reclassify it as a safe-to-retry venue validation response.
        if response.status_code < 500:
            try:
                venue_error = _aster_error(response.json())
            except (ValueError, AttributeError):
                venue_error = None
            if venue_error is not None:
                raise venue_error
        raise _map_status(response.status_code, mutating=method != "GET")
    try:
        body = response.json()
    except ValueError as exc:
        raise AsterV3Error("ASTER_INVALID_RESPONSE", ambiguous=method != "GET") from exc
    venue_error = _aster_error(body)
    if venue_error is not None:
        raise venue_error
    return body


def read_account(credentials: AsterCredentials) -> dict[str, Any]:
    body = request("GET", "/fapi/v3/accountWithJoinMargin", credentials)
    if not isinstance(body, dict):
        raise AsterV3Error("ASTER_INVALID_ACCOUNT_RESPONSE")
    return body


def read_positions(credentials: AsterCredentials, symbol: str | None = None) -> list[dict[str, Any]]:
    params = [("symbol", symbol)] if symbol else []
    body = request("GET", "/fapi/v3/positionRisk", credentials, params)
    if not isinstance(body, list):
        raise AsterV3Error("ASTER_INVALID_POSITIONS_RESPONSE")
    if any(not isinstance(row, dict) for row in body):
        raise AsterV3Error("ASTER_INVALID_POSITIONS_RESPONSE")
    return body


def read_open_orders(credentials: AsterCredentials, symbol: str | None = None) -> list[dict[str, Any]]:
    body = request("GET", "/fapi/v3/openOrders", credentials, [("symbol", symbol)] if symbol else [])
    if not isinstance(body, list):
        raise AsterV3Error("ASTER_INVALID_OPEN_ORDERS_RESPONSE")
    if any(not isinstance(row, dict) for row in body):
        raise AsterV3Error("ASTER_INVALID_OPEN_ORDERS_RESPONSE")
    return body


def read_position_mode(credentials: AsterCredentials) -> str:
    body = request("GET", "/fapi/v3/positionSide/dual", credentials)
    if not isinstance(body, dict) or not isinstance(body.get("dualSidePosition"), bool):
        raise AsterV3Error("ASTER_INVALID_POSITION_MODE_RESPONSE")
    return "hedge" if body["dualSidePosition"] else "one_way"


def max_initial_leverage(credentials: AsterCredentials, symbol: str, notional: Decimal) -> int:
    body = request("GET", "/fapi/v3/leverageBrackets", credentials, [("symbol", symbol)])
    if not isinstance(body, dict) or body.get("symbol") != symbol or not isinstance(body.get("brackets"), list):
        raise AsterV3Error("ASTER_INVALID_LEVERAGE_BRACKETS")
    for bracket in body["brackets"]:
        if not isinstance(bracket, dict):
            continue
        try:
            floor = Decimal(str(bracket["notionalFloor"]))
            cap = Decimal(str(bracket["notionalCap"]))
            leverage = int(bracket["initialLeverage"])
        except (KeyError, ValueError, InvalidOperation, TypeError) as exc:
            raise AsterV3Error("ASTER_INVALID_LEVERAGE_BRACKETS") from exc
        if floor <= notional < cap and leverage >= 1:
            return leverage
    raise AsterV3Error("ASTER_NOTIONAL_OUTSIDE_BRACKETS")


def set_leverage(credentials: AsterCredentials, symbol: str, leverage: int) -> dict[str, Any]:
    if type(leverage) is not int or not 1 <= leverage <= MAX_LEVERAGE:
        raise AsterV3Error("ASTER_INVALID_LEVERAGE")
    body = request(
        "POST", "/fapi/v3/leverage", credentials,
        [("symbol", symbol), ("leverage", leverage)],
    )
    if not isinstance(body, dict) or body.get("symbol") != symbol or body.get("leverage") != leverage:
        raise AsterV3Error("ASTER_LEVERAGE_UNCONFIRMED", ambiguous=True)
    return body


def read_order(credentials: AsterCredentials, symbol: str, client_order_id: str) -> dict[str, Any]:
    body = request(
        "GET", "/fapi/v3/order", credentials,
        [("symbol", symbol), ("origClientOrderId", client_order_id)],
    )
    if not isinstance(body, dict) or body.get("clientOrderId") != client_order_id:
        raise AsterV3Error("ASTER_INVALID_ORDER_LOOKUP")
    return body


def read_strategy_order(
    credentials: AsterCredentials, client_strategy_id: str, *, history: bool = False,
) -> dict[str, Any]:
    path = "/fapi/v3/strategyHistoryOrder" if history else "/fapi/v3/strategyOpenOrder"
    body = request(
        "GET", path, credentials,
        [("clientStrategyId", client_strategy_id), ("strategyType", "OTO")],
    )
    if not isinstance(body, dict) or body.get("clientStrategyId") != client_strategy_id:
        raise AsterV3Error("ASTER_INVALID_STRATEGY_LOOKUP")
    return body


def public_request(path: str, params: Iterable[tuple[str, Any]] = ()) -> Any:
    """Public venue data; never sends a wallet identifier or signing material."""
    try:
        response = requests.get(
            f"{BASE_URL}{path}", params=list(params), timeout=TIMEOUT_SECONDS,
            headers={"user-agent": "TurtleBot-Signer/1.0"},
        )
    except requests.RequestException as exc:
        raise AsterV3Error("ASTER_PUBLIC_DATA_UNAVAILABLE") from exc
    if not response.ok:
        raise _map_status(response.status_code)
    try:
        return response.json()
    except ValueError as exc:
        raise AsterV3Error("ASTER_INVALID_PUBLIC_DATA") from exc


def symbol_rules(symbol: str) -> dict[str, str]:
    """Extract Aster's actual LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL constraints."""
    body = public_request("/fapi/v3/exchangeInfo")
    if not isinstance(body, dict) or not isinstance(body.get("symbols"), list):
        raise AsterV3Error("ASTER_INVALID_EXCHANGE_INFO")
    for row in body["symbols"]:
        if not isinstance(row, dict) or row.get("symbol") != symbol:
            continue
        if row.get("status") != "TRADING":
            raise AsterV3Error("ASTER_SYMBOL_NOT_TRADING")
        filters = {
            item.get("filterType"): item
            for item in row.get("filters", [])
            if isinstance(item, dict)
        }
        lot = filters.get("LOT_SIZE")
        market_lot = filters.get("MARKET_LOT_SIZE")
        price = filters.get("PRICE_FILTER")
        notional = filters.get("MIN_NOTIONAL")
        if not all(isinstance(item, dict) for item in (lot, market_lot, price, notional)):
            raise AsterV3Error("ASTER_SYMBOL_FILTERS_MISSING")
        result = {
            "symbol": symbol,
            "step_size": str(lot.get("stepSize", "")),
            "min_quantity": str(lot.get("minQty", "")),
            "max_quantity": str(lot.get("maxQty", "")),
            "market_step_size": str(market_lot.get("stepSize", "")),
            "market_min_quantity": str(market_lot.get("minQty", "")),
            "market_max_quantity": str(market_lot.get("maxQty", "")),
            "tick_size": str(price.get("tickSize", "")),
            "min_notional": str(notional.get("notional", "")),
        }
        try:
            if any(Decimal(value) <= 0 for key, value in result.items() if key != "symbol"):
                raise ValueError("nonpositive filter")
        except (InvalidOperation, ValueError) as exc:
            raise AsterV3Error("ASTER_INVALID_SYMBOL_FILTERS") from exc
        return result
    raise AsterV3Error("ASTER_SYMBOL_NOT_FOUND")


def mark_price(symbol: str) -> Decimal:
    body = public_request("/fapi/v3/premiumIndex", [("symbol", symbol)])
    if not isinstance(body, dict):
        raise AsterV3Error("ASTER_INVALID_MARK_PRICE")
    try:
        value = Decimal(str(body["markPrice"]))
    except (KeyError, InvalidOperation) as exc:
        raise AsterV3Error("ASTER_INVALID_MARK_PRICE") from exc
    if not value.is_finite() or value <= 0:
        raise AsterV3Error("ASTER_INVALID_MARK_PRICE")
    return value


def place_oto_entry_with_stop(
    credentials: AsterCredentials,
    *, symbol: str, side: str, quantity: str, entry_price: str,
    stop_price: str, client_strategy_id: str,
) -> dict[str, Any]:
    """Submit a LIMIT rung and its conditional STOP as one venue strategy.

    TurtleBot intentionally does not emulate attachment with two independent
    POSTs: an accepted entry followed by a failed stop would leave live risk
    naked. Aster's OTO strategy is the venue's linked-order primitive.
    """
    if side not in ("BUY", "SELL"):
        raise AsterV3Error("ASTER_INVALID_SIDE")
    opposite = "SELL" if side == "BUY" else "BUY"
    sub_orders = [
        {
            "strategySubId": "1", "securityType": "USDT_FUTURES",
            "symbol": symbol, "side": side, "positionSide": "BOTH",
            "type": "LIMIT", "quantity": quantity, "price": entry_price,
            "timeInForce": "GTC", "clientOrderId": f"{client_strategy_id[:32]}-e",
        },
        {
            "strategySubId": "2", "securityType": "USDT_FUTURES",
            "symbol": symbol, "side": opposite, "positionSide": "BOTH",
            # Each of the five rungs shares one symbol-level position. A
            # closePosition=true stop would close ALL filled rungs, not this
            # rung's allocation. Scope the protection to its own quantity.
            "type": "STOP_MARKET", "quantity": quantity,
            "reduceOnly": "true", "closePosition": "false",
            "stopPrice": stop_price, "workingType": "MARK_PRICE",
            "clientOrderId": f"{client_strategy_id[:32]}-s",
            "firstDrivenId": "1", "firstDrivenOn": "PARTIALLY_FILLED_OR_FILLED",
            "firstTrigger": "PLACE_ORDER",
        },
    ]
    body = request(
        "POST", "/fapi/v3/placeStrategyOrder", credentials,
        [
            ("clientStrategyId", client_strategy_id[:36]),
            ("strategyType", "OTO"),
            ("subOrderList", json.dumps(sub_orders, separators=(",", ":"))),
        ],
    )
    if not isinstance(body, dict) or not body.get("strategyId"):
        raise AsterV3Error("ASTER_INVALID_STRATEGY_RESPONSE", ambiguous=True)
    if body.get("strategyStatus") not in ("WORKING", "NEW") or body.get("failureCode") not in (None, 0):
        raise AsterV3Error("ASTER_STRATEGY_NOT_WORKING", ambiguous=True)
    return body


def account_summary(credentials: AsterCredentials) -> dict[str, Any]:
    body = read_account(credentials)

    def number(name: str) -> float:
        try:
            value = Decimal(str(body.get(name, "0")))
            return float(value) if value.is_finite() else 0.0
        except (InvalidOperation, ValueError):
            return 0.0

    total = number("totalWalletBalance")
    available = number("availableBalance")
    initial_margin = number("totalInitialMargin")
    return {
        "totalEquity": number("totalMarginBalance") or total,
        "walletBalance": total,
        "availableBalance": available,
        "inTrades": initial_margin,
        "openPnl": number("totalUnrealizedProfit"),
        "permissions": {
            "read": True,
            "trade": body.get("canTrade") is True,
            # canWithdraw is an account capability, not proof that this agent
            # key is authorized to withdraw. TurtleBot never invokes Aster
            # withdrawal endpoints.
            "withdraw": False,
        },
    }


def place_order(
    credentials: AsterCredentials,
    *,
    symbol: str,
    side: str,
    order_type: str,
    quantity: str,
    client_order_id: str,
    price: str | None = None,
    reduce_only: bool = False,
) -> dict[str, Any]:
    params: list[tuple[str, Any]] = [
        ("symbol", symbol),
        ("side", side),
        ("type", order_type),
        ("quantity", quantity),
        ("newClientOrderId", client_order_id[:36]),
        ("reduceOnly", "true" if reduce_only else "false"),
    ]
    if order_type == "LIMIT":
        params.extend([("timeInForce", "GTC"), ("price", price)])
    body = request("POST", "/fapi/v3/order", credentials, params)
    if not isinstance(body, dict):
        raise AsterV3Error("ASTER_INVALID_ORDER_RESPONSE", ambiguous=True)
    return body


def cancel_order(
    credentials: AsterCredentials, *, symbol: str, client_order_id: str,
) -> dict[str, Any]:
    """Cancel only one identified order, never every order on the symbol."""
    if not symbol or not client_order_id:
        raise AsterV3Error("ASTER_CANCEL_TARGET_REQUIRED")
    body = request(
        "DELETE", "/fapi/v3/order", credentials,
        [("symbol", symbol), ("origClientOrderId", client_order_id)],
    )
    if (
        not isinstance(body, dict)
        or body.get("symbol") != symbol
        or body.get("clientOrderId") != client_order_id
        or body.get("status") != "CANCELED"
    ):
        raise AsterV3Error("ASTER_CANCEL_UNCONFIRMED", ambiguous=True)
    return body


def cancel_all(credentials: AsterCredentials, *, symbol: str) -> dict[str, Any]:
    body = request("DELETE", "/fapi/v3/allOpenOrders", credentials, [("symbol", symbol)])
    if not isinstance(body, dict):
        raise AsterV3Error("ASTER_INVALID_CANCEL_RESPONSE", ambiguous=True)
    return body
