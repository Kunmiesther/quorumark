"""ApeX Omni v3 REST — signed write and query surface.

Signing scheme is the CANONICAL SDK form used by `apexomni.http_private.sign`:

    dataString    = "&".join(f"{k}={v}" for k,v in sorted(data.items()) if v is not None)
    messageString = str(ts_ms) + METHOD + request_path + dataString
    keyString     = base64(secret_utf8)
    signature     = base64( HMAC_SHA256(keyString, messageString) )

For POST/DELETE, `data` is sent as `application/x-www-form-urlencoded`.
`request_path` NEVER contains a query string when a POST body is present.
For GET/DELETE without a body, params are appended to the URL AS WELL as
signed in dataString (the ApeX server accepts both orderings).

This module is used only under CREATE_ORDER / CANCEL_ORDER / CLOSE_POSITION
/ RECONCILE, all of which are OFF by default via `app.operations`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from .apex_omni_rest import base_url  # reuse env host resolution


class OrderRestError(Exception):
    """Opaque, stable error code. Never carries response bodies or headers."""


_TIMEOUT_SECONDS = 8.0
_MAX_RESPONSE_BYTES = 256 * 1024


@dataclass(frozen=True)
class RestCreds:
    api_key: str
    api_secret: str
    passphrase: str


def _sorted_data_string(data: dict[str, Any]) -> str:
    items = sorted(((k, v) for k, v in data.items() if v is not None), key=lambda x: x[0])
    return "&".join(f"{k}={v}" for k, v in items)


def sign_canonical(method: str, request_path: str, ts_ms: int, data: dict[str, Any], secret: str) -> str:
    """Canonical ApeX Omni SDK signature."""
    data_string = _sorted_data_string(data or {})
    message = f"{ts_ms}{method.upper()}{request_path}{data_string}".encode("utf-8")
    key = base64.b64encode(secret.encode("utf-8"))
    mac = hmac.new(key, message, hashlib.sha256).digest()
    return base64.b64encode(mac).decode("ascii")


def _auth_headers(api_key: str, passphrase: str, ts_ms: int, signature: str, is_form: bool) -> dict:
    h = {
        "APEX-API-KEY": api_key,
        "APEX-SIGNATURE": signature,
        "APEX-TIMESTAMP": str(ts_ms),
        "APEX-PASSPHRASE": passphrase or "",
    }
    if is_form:
        h["Content-Type"] = "application/x-www-form-urlencoded"
    return h


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(_TIMEOUT_SECONDS, connect=_TIMEOUT_SECONDS),
        follow_redirects=False,
    )


def _map_status(status: int) -> Optional[str]:
    if status in (401, 403):
        return "INVALID_CREDENTIALS"
    if status == 429:
        return "RATE_LIMITED"
    if status >= 500:
        return "UPSTREAM_UNAVAILABLE"
    if status != 200:
        return "UPSTREAM_ERROR"
    return None


def _parse(body: bytes, endpoint: str = "?") -> dict:
    try:
        import json as _json
        raw = body[:_MAX_RESPONSE_BYTES].decode("utf-8", errors="replace")
        p = _json.loads(raw)
    except Exception:
        raise OrderRestError("BAD_RESPONSE_JSON")
    if not isinstance(p, dict):
        raise OrderRestError("BAD_RESPONSE_JSON")
    code = p.get("code")
    if code not in (0, "0", None):
        # stdout is NOT durable (Railway containers rotate). The classified
        # category travels back to the caller and into `order_audit`.
        from .venue_reject import classify_venue_reject, extract_venue_message
        safe, category, _safe_msg = classify_venue_reject(code, extract_venue_message(p))
        try:
            import logging as _log
            _log.getLogger("apex.orders_v3").warning(
                "apex reject endpoint=%s code=%s category=%s", endpoint, safe, category
            )
        except Exception:
            pass
        raise OrderRestError(f"UPSTREAM_REJECT:{safe}:{category}")
    return p



def _do(method: str, environment: str, path: str, data: dict[str, Any], creds: RestCreds) -> dict:
    if not path.startswith("/"):
        raise OrderRestError("BAD_PATH")
    ts_ms = int(time.time() * 1000)
    m = method.upper()
    is_form = m in {"POST", "PUT"}

    # SDK parity (apexomni-connector-node PrivateApi.request):
    #   GET/DELETE with params  -> sign_path = path + "?" + sortedQuery, body = ""
    #   POST/PUT                -> sign_path = path,                   body = sortedQuery
    # The signature message is always: ts + METHOD + sign_path + body.
    query = _sorted_data_string(data or {})
    if not is_form and query:
        sign_path = f"{path}?{query}"
        sign_body = ""
        url = base_url(environment) + sign_path
    else:
        sign_path = path
        sign_body = query if is_form else ""
        url = base_url(environment) + path

    ts_ms_sig = ts_ms
    signature = sign_canonical(m, sign_path, ts_ms_sig, {}, creds.api_secret) if not sign_body \
        else sign_canonical(m, sign_path, ts_ms_sig, data, creds.api_secret)
    headers = _auth_headers(creds.api_key, creds.passphrase, ts_ms_sig, signature, is_form)

    try:
        with _client() as c:
            if is_form:
                r = c.request(m, url, headers=headers, content=urlencode(
                    sorted(((k, v) for k, v in (data or {}).items() if v is not None), key=lambda x: x[0])
                ).encode("utf-8"))
            else:
                r = c.request(m, url, headers=headers)
    except httpx.TimeoutException:
        raise OrderRestError("UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        raise OrderRestError("UPSTREAM_UNREACHABLE")

    err = _map_status(r.status_code)
    if err:
        raise OrderRestError(err)
    return _parse(r.content, endpoint=path)


# --- Order write surface -------------------------------------------------

def create_order(environment: str, creds: RestCreds, params: dict[str, Any]) -> dict:
    """POST /api/v3/order — returns parsed envelope. Caller pulls order id."""
    from .client_order_id import venue_client_id
    params = dict(params)
    for key in ("clientId", "clientOrderId"):
        if params.get(key):
            params[key] = venue_client_id(params[key])
    payload = _do("POST", environment, "/api/v3/order", params, creds)
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise OrderRestError("ORDER_SHAPE_UNEXPECTED")
    venue_id = data.get("id") or data.get("orderId")
    if not venue_id:
        raise OrderRestError("ORDER_ID_MISSING")
    return {
        "venue_order_id": str(venue_id),
        "client_order_id": data.get("clientOrderId") or data.get("clientId") or params.get("clientOrderId"),
        "status": data.get("status") or data.get("state"),
    }


def cancel_by_client_order_id(environment: str, creds: RestCreds, client_order_id: str) -> dict:
    from .client_order_id import venue_client_id
    client_order_id = venue_client_id(client_order_id) or client_order_id
    payload = _do(
        "POST", environment, "/api/v3/delete-client-order-id",
        {"clientOrderId": client_order_id}, creds,
    )
    return payload.get("data") or {}


_OPEN_ORDER_STATES = {
    "PENDING", "NEW", "OPEN", "UNTRIGGERED", "PARTIALLY_FILLED",
    "PARTIAL_FILLED", "ACCEPTED", "WORKING",
}


def _is_open_order(row: object) -> bool:
    """True only for orders the venue considers resting/active.

    ApeX Omni /api/v3/open-orders can (and does) return historical rows
    with terminal states like FILLED/CANCELED/EXPIRED mixed in when the
    envelope is polled without server-side filtering. Preflight MUST count
    only truly open rows or it fabricates EXISTING_OPEN_ORDER blocks.
    """
    if not isinstance(row, dict):
        return False
    status = str(row.get("status") or row.get("state") or "").strip().upper()
    if not status:
        # No status field at all → treat as open (conservative).
        return True
    if status in _OPEN_ORDER_STATES:
        return True
    # Anything else (FILLED, CANCELED, CANCELLED, EXPIRED, REJECTED, …)
    return False


def get_open_orders(environment: str, creds: RestCreds, symbol: Optional[str] = None) -> list[dict]:
    payload = _do("GET", environment, "/api/v3/open-orders", {"symbol": symbol} if symbol else {}, creds)
    data = payload.get("data")
    rows: list[dict] = []
    if isinstance(data, list):
        rows = [r for r in data if isinstance(r, dict)]
    elif isinstance(data, dict):
        for key in ("orders", "openOrders", "list"):
            v = data.get(key)
            if isinstance(v, list):
                rows = [r for r in v if isinstance(r, dict)]
                break
    return [r for r in rows if _is_open_order(r)]


def get_fills(
    environment: str,
    creds: RestCreds,
    symbol: Optional[str] = None,
    begin_ts_ms: Optional[int] = None,
    limit: int = 100,
) -> list[dict]:
    """GET /api/v3/fills — chronological trade fills for this account.

    Uses ApeX Omni's private fills endpoint. Returns raw fill dicts; caller
    is responsible for sanitization and cursor advancement. `begin_ts_ms`
    filters fills at-or-after that server-side timestamp (incremental).
    """
    params: dict[str, Any] = {"limit": int(max(1, min(limit, 500)))}
    if symbol:
        params["symbol"] = symbol
    if begin_ts_ms:
        params["beginTimeInclusive"] = int(begin_ts_ms)
    payload = _do("GET", environment, "/api/v3/fills", params, creds)
    data = payload.get("data")
    rows: list[dict] = []
    if isinstance(data, list):
        rows = [r for r in data if isinstance(r, dict)]
    elif isinstance(data, dict):
        for key in ("fills", "orders", "list", "trades"):
            v = data.get(key)
            if isinstance(v, list):
                rows = [r for r in v if isinstance(r, dict)]
                break
    return rows




def _position_size(row: dict) -> Decimal:
    for k in ("size", "openSize", "positionSize", "quantity", "qty"):
        v = row.get(k)
        if v in (None, ""):
            continue
        try:
            return abs(Decimal(str(v)))
        except (InvalidOperation, ValueError):
            continue
    return Decimal(0)


def get_positions(environment: str, creds: RestCreds) -> list[dict]:
    """Positions on ApeX Omni are returned in the account payload.

    ApeX keeps a position row for every symbol the account has ever traded,
    with size='0' after the position is flat. Preflight MUST filter those
    out or the very first live trade of a symbol permanently blocks the
    account from ever trading that symbol again.
    """
    payload = _do("GET", environment, "/api/v3/account", {}, creds)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        return []
    raw: list[dict] = []
    for key in ("openPositions", "positions", "accountPositions"):
        v = data.get(key)
        if isinstance(v, list):
            raw = [r for r in v if isinstance(r, dict)]
            break
    if not raw:
        ca = data.get("contractAccount") or {}
        if isinstance(ca, dict) and isinstance(ca.get("openPositions"), list):
            raw = [r for r in ca["openPositions"] if isinstance(r, dict)]
    out: list[dict] = []
    for row in raw:
        if _position_size(row) <= 0:
            continue
        status = str(row.get("status") or "").strip().upper()
        if status in {"CLOSED", "CLOSE"}:
            continue
        out.append(row)
    return out

