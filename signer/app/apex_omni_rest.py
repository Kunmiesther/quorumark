"""ApeX Omni REST read-only client.

Signing scheme mirrors
`src/lib/exchanges/apex-omni-sign.ts` and the reference
`ApeX-Protocol/apexomni-connector-node PrivateApi.sign()`:

    messageString = str(ts_ms) + METHOD + requestPath + params
    keyString     = base64(secret_utf8)          # base64 of the raw secret
    signature     = base64( HMAC_SHA256(keyString, messageString) )

For GET/DELETE, `requestPath` already includes the `?query`, and `params`
is "". This module ONLY implements two read endpoints:

  - `GET /api/v3/account`  → account snapshot
  - `GET /api/v3/user`     → user identity ping (used by VERIFY_CREDENTIALS)

There is no POST/PUT/DELETE helper on purpose. Adding one requires
touching this file, which requires a code review — that is the guard.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx


class RestError(Exception):
    """Opaque, stable error code. Never carries response bodies or headers."""


# Defaults are the documented ApeX Omni public hosts. Overridable via env
# to support QA / staging without a code change.
_DEFAULT_MAINNET = "https://omni.apex.exchange"
_DEFAULT_TESTNET = "https://qa.omni.apex.exchange"

# Bounded timeout is a hard requirement of this module. A signer that
# blocks on an unresponsive upstream is a liveness bug.
_TIMEOUT_SECONDS = 8.0
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def _canon_env(environment: str) -> str:
    e = (environment or "").strip().lower()
    if e in {"mainnet", "production", "prod", "live"}:
        return "mainnet"
    if e in {"testnet", "sandbox", "staging", "qa", "dev", "development"}:
        return "testnet"
    return e


def base_url(environment: str) -> str:
    env = _canon_env(environment)
    if env == "mainnet":
        return os.environ.get("APEX_OMNI_BASE_URL_MAINNET", _DEFAULT_MAINNET).rstrip("/")
    if env == "testnet":
        return os.environ.get("APEX_OMNI_BASE_URL_TESTNET", _DEFAULT_TESTNET).rstrip("/")
    raise RestError("BAD_ENVIRONMENT")



def sign(method: str, request_path: str, ts_ms: int, params: str, secret: str) -> str:
    """Compute the base64 HMAC-SHA256 signature per the ApeX Omni SDK."""
    message = f"{ts_ms}{method.upper()}{request_path}{params or ''}".encode("utf-8")
    key_string = base64.b64encode(secret.encode("utf-8"))
    mac = hmac.new(key_string, message, hashlib.sha256).digest()
    return base64.b64encode(mac).decode("ascii")


def _auth_headers(api_key: str, passphrase: str, ts_ms: int, signature: str) -> dict:
    return {
        "APEX-API-KEY": api_key,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": str(ts_ms),
        "APEX-PASSPHRASE": passphrase or "",
    }


@dataclass(frozen=True)
class AccountSnapshot:
    account_id: int | None
    total_equity: float | None
    available_balance: float | None
    currency: str | None
    permission_read: bool
    permission_trade: bool
    permission_withdraw: bool

    def as_sanitized(self) -> dict:
        return {
            "accountId": self.account_id,
            "totalEquity": self.total_equity,
            "availableBalance": self.available_balance,
            "currency": self.currency,
            "permissions": {
                "read": self.permission_read,
                "trade": self.permission_trade,
                "withdraw": self.permission_withdraw,
            },
        }


def _num(x: Any) -> float | None:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _bool(x: Any, default: bool = False) -> bool:
    if isinstance(x, bool):
        return x
    if isinstance(x, str):
        return x.strip().lower() in {"true", "1", "yes"}
    if isinstance(x, (int, float)):
        return bool(x)
    return default


def parse_account(payload: dict) -> AccountSnapshot:
    """Extract only the whitelisted fields. Ignore everything else.

    ApeX response shape varies; we tolerate common variants without ever
    forwarding raw fields to the caller.
    """
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        raise RestError("ACCOUNT_SHAPE_UNEXPECTED")
    contract = data.get("contractAccount") if isinstance(data.get("contractAccount"), dict) else {}
    total = _num(
        data.get("totalEquityValue")
        or data.get("totalEquity")
        or data.get("equity")
        or contract.get("totalEquityValue")
        or contract.get("totalEquity")
        or contract.get("equity")
    )
    avail = _num(
        data.get("availableBalance")
        or data.get("available")
        or contract.get("availableBalance")
        or contract.get("available")
    )
    currency = data.get("currency") or data.get("quoteCurrency") or "USDT"
    permissions = data.get("permissions") if isinstance(data.get("permissions"), dict) else {}
    return AccountSnapshot(
        account_id=_to_int(data.get("accountId") or data.get("id")),
        total_equity=total,
        available_balance=avail,
        currency=str(currency) if currency else None,
        permission_read=_bool(permissions.get("read"), default=True),
        permission_trade=_bool(permissions.get("trade"), default=False),
        permission_withdraw=_bool(permissions.get("withdraw"), default=False),
    )


def _http_client() -> httpx.Client:
    # Explicit connect + read + write timeouts. No pool retries — a hung
    # upstream must surface fast so the signer stays responsive.
    return httpx.Client(
        timeout=httpx.Timeout(_TIMEOUT_SECONDS, connect=_TIMEOUT_SECONDS),
        follow_redirects=False,
    )


def _do_get(environment: str, path: str, api_key: str, api_secret: str, passphrase: str) -> dict:
    if not path.startswith("/"):
        raise RestError("BAD_PATH")
    ts_ms = int(time.time() * 1000)
    sig = sign("GET", path, ts_ms, "", api_secret)
    headers = _auth_headers(api_key, passphrase, ts_ms, sig)
    url = base_url(environment) + path
    try:
        with _http_client() as c:
            r = c.get(url, headers=headers)
    except httpx.TimeoutException:
        raise RestError("UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        raise RestError("UPSTREAM_UNREACHABLE")
    if r.status_code == 401 or r.status_code == 403:
        raise RestError("INVALID_CREDENTIALS")
    if r.status_code == 429:
        raise RestError("RATE_LIMITED")
    if r.status_code >= 500:
        raise RestError("UPSTREAM_UNAVAILABLE")
    if r.status_code != 200:
        raise RestError("UPSTREAM_ERROR")
    body = r.content[:_MAX_RESPONSE_BYTES]
    try:
        import json as _json
        raw = body.decode("utf-8", errors="replace")
        payload = _json.loads(raw)
    except Exception:
        raise RestError("BAD_RESPONSE_JSON")
    if not isinstance(payload, dict):
        raise RestError("BAD_RESPONSE_JSON")
    code = payload.get("code")
    if code not in (0, "0", None):
        try:
            import logging as _log
            _log.getLogger("apex.rest").warning(
                "apex reject endpoint=%s code=%s body=%s", path, code, raw[:512]
            )
        except Exception:
            pass
    return payload


def verify_credentials(environment: str, api_key: str, api_secret: str, passphrase: str) -> bool:
    """Return True iff the credentials authenticate a read call.

    Uses `/api/v3/user` for the smallest possible check.
    """
    payload = _do_get(environment, "/api/v3/user", api_key, api_secret, passphrase)
    # ApeX wraps success as {code: 0, data: {...}}. Anything else is a failure.
    code = payload.get("code")
    if code not in (0, "0", None):
        raise RestError("INVALID_CREDENTIALS")
    return True


def read_account(environment: str, api_key: str, api_secret: str, passphrase: str) -> AccountSnapshot:
    payload = _do_get(environment, "/api/v3/account", api_key, api_secret, passphrase)
    code = payload.get("code")
    if code not in (0, "0", None):
        raise RestError("INVALID_CREDENTIALS")
    return parse_account(payload)


def read_account_balance(environment: str, api_key: str, api_secret: str, passphrase: str) -> AccountSnapshot:
    """Read margin/equity from ApeX's balance endpoint.

    `/api/v3/account` is the identity source for account id. ApeX can return
    sparse or zero balance data there while `/api/v3/account-balance` shows the
    funded Perps margin account. Use this only for balances/preflight.
    """
    payload = _do_get(environment, "/api/v3/account-balance", api_key, api_secret, passphrase)
    code = payload.get("code")
    if code not in (0, "0", None):
        raise RestError("INVALID_CREDENTIALS")
    return parse_account(payload)


# --- Order-metadata helpers (used by /v1/orders staging) ---------------

@dataclass(frozen=True)
class UserStarkContext:
    """STARK identity for the caller's account, sourced from /api/v3/user.
    account_id + sub_account_id + slot_id are the only fields the SDK
    Contract builder needs beyond the seed."""
    account_id: int
    sub_account_id: int
    slot_id: int


@dataclass(frozen=True)
class SymbolConfig:
    """Contract config for one perp symbol, sourced from /api/v3/symbols.
    l2_pair_id + decimals are STARK-critical; tick/step/fees drive the
    builder's rounding."""
    symbol: str
    l2_pair_id: int
    decimals: int
    tick_size: str
    step_size: str
    taker_fee_rate: str
    maker_fee_rate: str
    min_order_size: str
    max_order_size: str
    max_leverage: int


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None or v == "":
            return None
        return int(v)
    except (TypeError, ValueError):
        return None


def get_user_stark_context(
    environment: str,
    api_key: str,
    api_secret: str,
    passphrase: str,
    apex_account_id: Optional[str] = None,
) -> UserStarkContext:
    """Fetch account/sub_account/slot from /api/v3/user.

    ApeX Omni response shape (as documented in the SDK v3 client) exposes
    `accountId`, `subAccounts[].subAccountId`, and `subAccounts[].slotId`
    within `data`. We take the FIRST sub-account (canonical trading
    sub-account). Fresh Omni registrations can return sparse user data before
    subAccounts is populated; in that narrow case, use the persisted account id
    returned by `new-onboarding` and Omni's default account-as-sub-account /
    slot-1 convention. NEVER default to zero, which would sign the wrong account.
    """
    payload = _do_get(environment, "/api/v3/user", api_key, api_secret, passphrase)
    code = payload.get("code")
    if code not in (0, "0", None):
        raise RestError("INVALID_CREDENTIALS")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        raise RestError("USER_SHAPE_UNEXPECTED")
    account_id = _to_int(data.get("accountId") or data.get("id") or apex_account_id)
    subs = data.get("subAccounts") or data.get("subAccountList") or []
    sub_account_id: Optional[int] = None
    slot_id: Optional[int] = None
    if isinstance(subs, list) and subs and isinstance(subs[0], dict):
        first = subs[0]
        sub_account_id = _to_int(first.get("subAccountId") or first.get("id"))
        slot_id = _to_int(first.get("slotId") or first.get("slot"))
    # Fallbacks: some tenants expose these at top-level.
    if sub_account_id is None:
        sub_account_id = _to_int(data.get("subAccountId"))
    if slot_id is None:
        slot_id = _to_int(data.get("slotId"))
    if account_id is not None and apex_account_id and sub_account_id is None:
        sub_account_id = account_id
    if account_id is not None and apex_account_id and slot_id is None:
        slot_id = 1
    if account_id is None or sub_account_id is None or slot_id is None:
        raise RestError("STARK_CONTEXT_MISSING")
    return UserStarkContext(account_id=account_id, sub_account_id=sub_account_id, slot_id=slot_id)


def get_symbol_config(environment: str, symbol: str) -> SymbolConfig:
    """Fetch perp contract config from /api/v3/symbols.

    Public endpoint — no auth. We resolve by canonical `symbol` (e.g.
    BTC-USDT). Missing fields fail-closed; the caller MUST NOT default
    l2_pair_id or decimals, which would sign against the wrong contract.
    """
    if not isinstance(symbol, str) or not symbol:
        raise RestError("BAD_SYMBOL")
    url = base_url(environment) + "/api/v3/symbols"
    try:
        with _http_client() as c:
            r = c.get(url, headers={"accept": "application/json"})
    except httpx.TimeoutException:
        raise RestError("UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        raise RestError("UPSTREAM_UNREACHABLE")
    if r.status_code != 200:
        raise RestError("UPSTREAM_ERROR")
    try:
        import json as _json
        payload = _json.loads(r.content[:_MAX_RESPONSE_BYTES].decode("utf-8", errors="replace"))
    except Exception:
        raise RestError("BAD_RESPONSE_JSON")
    data = payload.get("data") if isinstance(payload, dict) else {}
    contracts = ((data or {}).get("contractConfig") or {}).get("perpetualContract") or []
    match = None
    want = symbol.upper()
    for row in contracts:
        if not isinstance(row, dict):
            continue
        if str(row.get("symbol", "")).upper() == want:
            match = row
            break
    if not match:
        raise RestError("SYMBOL_NOT_LISTED")
    l2_pair_id = _to_int(match.get("l2PairId") or match.get("pairId") or match.get("starkPairId"))
    tick_size = match.get("tickSize")
    step_size = match.get("stepSize")
    # STARK-CRITICAL: the ApeX SDK scales size AND price by the SETTLE
    # ASSET's decimals (USDT = 6), NOT by the symbol's base-asset step.
    # See `apexomni.http_private_sign.create_order_v3` lines 136-180:
    #     for v2 in contractConfig.assets:
    #         if v2.token == symbolData.settleAssetId: currency = v2
    #     priceStr = price * 10^currency.decimals   # ROUND_DOWN
    #     sizeStr  = size  * 10^currency.decimals   # ROUND_DOWN
    # Using step-derived decimals (3 for BTC) signs a completely
    # different contract than the venue verifies and reject 20016
    # "Failed to check signature" is the exact symptom.
    settle_asset_id = match.get("settleAssetId") or match.get("quoteTokenId")
    assets = ((data or {}).get("contractConfig") or {}).get("assets") or []
    decimals = None
    for a in assets:
        if isinstance(a, dict) and a.get("token") == settle_asset_id:
            decimals = _to_int(a.get("decimals"))
            break
    taker = match.get("takerFeeRate") or match.get("defaultTakerFeeRate") or "0.0005"
    maker = match.get("makerFeeRate") or match.get("defaultMakerFeeRate") or "0.0002"
    min_order_size = match.get("minOrderSize")
    max_order_size = match.get("maxOrderSize")
    max_leverage = _to_int(match.get("displayMaxLeverage") or match.get("maxLeverage"))
    if (
        l2_pair_id is None or decimals is None or not tick_size or not step_size
        or not min_order_size or not max_order_size or max_leverage is None
    ):
        raise RestError("SYMBOL_CONFIG_INCOMPLETE")
    return SymbolConfig(
        symbol=want, l2_pair_id=l2_pair_id, decimals=decimals,
        tick_size=str(tick_size), step_size=str(step_size),
        taker_fee_rate=str(taker), maker_fee_rate=str(maker),
        min_order_size=str(min_order_size), max_order_size=str(max_order_size),
        max_leverage=max_leverage,
    )



def get_mark_price(environment: str, symbol: str) -> str:
    """Fetch a mark price for `symbol` from the public /api/v3/ticker.
    Returned as a string so no float rounding sneaks into the builder."""
    if not isinstance(symbol, str) or not symbol:
        raise RestError("BAD_SYMBOL")
    url = base_url(environment) + "/api/v3/ticker"
    # ApeX Omni /api/v3/ticker expects the RAW symbol (e.g. "BTCUSDT"),
    # not the canonical dashed form ("BTC-USDT"). Passing the dashed form
    # returns an empty {"data":[]} envelope → TICKER_SHAPE_UNEXPECTED.
    raw_symbol = symbol.replace("-", "")
    try:
        with _http_client() as c:
            r = c.get(url, params={"symbol": raw_symbol}, headers={"accept": "application/json"})
    except httpx.TimeoutException:
        raise RestError("UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        raise RestError("UPSTREAM_UNREACHABLE")
    if r.status_code != 200:
        raise RestError("UPSTREAM_ERROR")
    try:
        import json as _json
        payload = _json.loads(r.content[:_MAX_RESPONSE_BYTES].decode("utf-8", errors="replace"))
    except Exception:
        raise RestError("BAD_RESPONSE_JSON")
    rows = payload.get("data") if isinstance(payload, dict) else None
    want_raw = raw_symbol.upper()
    row: dict | None = None
    if isinstance(rows, list):
        # ApeX /api/v3/ticker can return multiple rows even when a `symbol`
        # query param is supplied. Never trust rows[0] blindly — that's how
        # canary sizing ends up computed against the wrong symbol's mark.
        for r in rows:
            if isinstance(r, dict) and str(r.get("symbol", "")).upper() == want_raw:
                row = r
                break
        if row is None and len(rows) == 1 and isinstance(rows[0], dict):
            row = rows[0]
    elif isinstance(rows, dict):
        if str(rows.get("symbol", "")).upper() in ("", want_raw):
            row = rows
    if row is None:
        raise RestError("TICKER_SHAPE_UNEXPECTED")
    for k in ("markPrice", "lastPrice", "indexPrice", "oraclePrice"):
        v = row.get(k)
        if v not in (None, "", 0, "0"):
            return str(v)
    raise RestError("TICKER_PRICE_MISSING")
