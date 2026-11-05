"""ApeX Omni SDK-backed order submission.

This module is the only live order-signing surface. It delegates STARK
contract construction, scaling, nonce/slot derivation, and signing to the
pinned `apexomni` SDK instead of reimplementing those internals locally.
"""
from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from .orders_v3 import OrderRestError, RestCreds

log = logging.getLogger("apex.sdk_order")


def _env_constants(environment: str) -> tuple[str, int, int]:
    env = (environment or "").strip().lower()
    try:
        from apexomni.constants import (
            APEX_OMNI_HTTP_MAIN,
            APEX_OMNI_HTTP_TEST,
            NETWORKID_MAIN,
            NETWORKID_TEST,
            REGISTER_ENVID_MAIN,
            REGISTER_ENVID_TEST,
        )
    except Exception as exc:  # pragma: no cover - exercised only without SDK installed
        raise OrderRestError("SDK_UNAVAILABLE") from exc
    if env in {"mainnet", "production", "prod", "live"}:
        return APEX_OMNI_HTTP_MAIN, NETWORKID_MAIN, REGISTER_ENVID_MAIN
    if env in {"testnet", "qa", "sandbox", "dev", "development"}:
        return APEX_OMNI_HTTP_TEST, NETWORKID_TEST, REGISTER_ENVID_TEST
    raise OrderRestError("BAD_ENVIRONMENT")


def _bool_param(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return bool(value)


def _matches_attached_stop(data: dict, requested: dict) -> bool:
    """Verify ApeX's server-returned attachment, never the submitted request alone.

    The v3 response documents openSlParam rather than a child slOrderId.
    A resting entry's attachment is a distinct receipt, not a fabricated
    protective order ID.
    """
    if not (_bool_param(data.get("isOpenTpslOrder", False))
            and _bool_param(data.get("isSetOpenSl", False))):
        return False
    accepted = data.get("openSlParam")
    if not isinstance(accepted, dict):
        return False
    if accepted.get("side") != requested.get("slSide"):
        return False
    accepted_client_id = accepted.get("clientOrderId") or accepted.get("clientId")
    if not accepted_client_id or str(accepted_client_id) != str(requested.get("slClientId")):
        return False
    if data.get("symbol") != requested.get("symbol") or data.get("side") != requested.get("side"):
        return False
    if data.get("triggerPriceType") != requested.get("triggerPriceType"):
        return False
    if str(data.get("status") or "").upper() not in {
        "PENDING", "OPEN", "NEW", "UNTRIGGERED", "PARTIALLY_FILLED", "FILLED",
    }:
        return False
    try:
        pairs = [(data.get("size"), requested.get("size"))]
        pairs.extend((accepted.get(key), requested.get(request_key)) for key, request_key in (
            ("size", "slSize"), ("price", "slPrice"), ("triggerPrice", "slTriggerPrice"),
        ))
        for actual, expected in pairs:
            actual_num, expected_num = Decimal(str(actual)), Decimal(str(expected))
            if not actual_num.is_finite() or not expected_num.is_finite():
                return False
            if actual_num <= 0 or actual_num != expected_num:
                return False
    except (InvalidOperation, ValueError, TypeError):
        return False
    return True


class SdkOrderClient:
    def __init__(self, environment: str, creds: RestCreds, *, zk_seeds: str, zk_l2_key: str) -> None:
        endpoint, network_id, env_id = _env_constants(environment)
        try:
            from apexomni.http_private_sign import HttpPrivateSign
        except Exception as exc:  # pragma: no cover - exercised only without SDK installed
            raise OrderRestError("SDK_UNAVAILABLE") from exc
        self._client = HttpPrivateSign(
            endpoint,
            network_id=network_id,
            env_id=env_id,
            zk_seeds=str(zk_seeds).removeprefix("0x"),
            zk_l2Key=zk_l2_key,
            api_key_credentials={
                "key": creds.api_key,
                "secret": creds.api_secret,
                "passphrase": creds.passphrase or "",
            },
            request_timeout=8,
            max_retries=1,
        )

    def _account_fee_rates(
        self, fallback_taker: Any, fallback_maker: Any
    ) -> tuple[Any, Any]:
        """Authoritative taker/maker rates for THIS account.

        DEFECT THIS FIXES: `apex_omni_rest.get_symbol_config()` reads
        `takerFeeRate`/`defaultTakerFeeRate` off the perpetual-contract row —
        fields ApeX does NOT publish there. Every order therefore carried a
        hardcoded guess ("0.0005"/"0.0002"). The SDK turns that rate into the
        absolute `limitFee` it signs into the STARK contract, so whenever the
        account's real rate is higher than the guess the venue sees a fee
        allowance below what it will charge and rejects the order.

        The venue's own answer lives on the account snapshot
        (`contractAccount.takerFeeRate` / `makerFeeRate`). Prefer it; fall
        back to the caller's value only if the snapshot is unreadable so a
        transient account-read failure cannot block execution outright.
        """
        try:
            account = self._client._ensure_account_snapshot() or {}
            contract_account = account.get("contractAccount") or {}
            taker = contract_account.get("takerFeeRate")
            maker = contract_account.get("makerFeeRate")
            if taker is not None and maker is not None:
                log.info("apex fee rates source=account")
                return taker, maker
            log.warning("apex fee rates source=fallback reason=account_rates_missing")
        except Exception as exc:
            log.warning("apex fee rates source=fallback class=%s", type(exc).__name__)
        return fallback_taker, fallback_maker

    def create_order(self, params: dict[str, Any]) -> dict[str, Any]:

        """Submit an order via the pinned SDK.

        Optional `attached_sl` (and future `attached_tp`) on `params` requests
        the SDK's atomic TP/SL attachment (`isOpenTpslOrder=True`). This is
        the ONLY safe way to arm a protective stop on a MARKET entry — a
        separate reduce-only STOP submitted immediately after a MARKET is
        rejected by ApeX (code 20016) because the position row does not yet
        exist when the second order is signed.

        Shape expected for `attached_sl`:
            {"trigger_price": str, "price": str, "size": str,
             "side": "BUY"|"SELL", "client_id": str,
             "trigger_price_type": "INDEX"|"MARK_PRICE"|"LAST_PRICE"}
        """
        from .client_order_id import venue_client_id

        sl = params.get("attached_sl") or None
        tp = params.get("attached_tp") or None
        taker_rate, maker_rate = self._account_fee_rates(
            params.get("limitFee"), params.get("makerFeeRate")
        )
        kwargs: dict[str, Any] = dict(
            symbol=params["symbol"],
            side=params["side"],
            type=params["type"],
            size=str(params["size"]),
            price=str(params["price"]),
            clientId=venue_client_id(params.get("clientId") or params.get("clientOrderId")),
            reduceOnly=_bool_param(params.get("reduceOnly", False)),
            triggerPrice=params.get("triggerPrice"),
            triggerPriceType=params.get("triggerPriceType"),
            takerFeeRate=taker_rate,
            makerFeeRate=maker_rate,
        )

        # Maker-only resting orders. The SDK defaults to GOOD_TIL_CANCEL; only
        # override when the caller explicitly asked for a time-in-force.
        if params.get("timeInForce"):
            kwargs["timeInForce"] = str(params["timeInForce"])

        if sl or tp:
            # Attached TP/SL share a single triggerPriceType in the SDK; default
            # to INDEX to match the SDK's stark_key_sign default.
            kwargs["isOpenTpslOrder"] = True
            kwargs["triggerPriceType"] = (
                (sl or {}).get("trigger_price_type")
                or (tp or {}).get("trigger_price_type")
                or kwargs.get("triggerPriceType")
                or "INDEX"
            )
            if sl:
                kwargs.update(dict(
                    isSetOpenSl=True,
                    slClientId=venue_client_id(sl.get("client_id")),
                    slPrice=str(sl["price"]),
                    slSide=sl["side"],
                    slSize=str(sl["size"]),
                    slTriggerPrice=str(sl["trigger_price"]),
                ))
            if tp:
                kwargs.update(dict(
                    isSetOpenTp=True,
                    tpClientId=venue_client_id(tp.get("client_id")),
                    tpPrice=str(tp["price"]),
                    tpSide=tp["side"],
                    tpSize=str(tp["size"]),
                    tpTriggerPrice=str(tp["trigger_price"]),
                ))
        from .venue_reject import record_raw_reject
        try:
            payload = self._client.create_order_v3(**kwargs)
        except OrderRestError:
            raise
        except Exception as exc:
            log.warning("apex sdk order exception class=%s", type(exc).__name__)
            # The SDK raises plain Exceptions for its own pre-flight failures
            # ("the price must Multiple of tickSize", "Failed to fetch
            # configV3", missing fee rates). Those never reach the venue, so
            # without capturing them here the operator cannot tell a local
            # build defect from a venue reject.
            record_raw_reject(source=f"SDK_{type(exc).__name__}", code="SDK", message=str(exc))
            raise OrderRestError("SDK_ORDER_FAILED") from exc
        if not isinstance(payload, dict):
            raise OrderRestError("BAD_RESPONSE_JSON")
        code = payload.get("code")
        if code not in (0, "0", None):
            from .venue_reject import classify_venue_reject, extract_venue_message
            raw_message = extract_venue_message(payload)
            if raw_message is None:
                # Nothing matched the known message fields — record the body's
                # shape so the next iteration knows where ApeX put the text.
                raw_message = "keys=" + ",".join(sorted(str(k) for k in payload)[:20])
            # Pair the venue's answer with exactly what we asked for. Without
            # this the operator sees "code 3" and no way to tell which field
            # the venue objected to.
            sent = (
                f"sent symbol={kwargs['symbol']} side={kwargs['side']} type={kwargs['type']} "
                f"size={kwargs['size']} price={kwargs['price']} "
                f"tif={kwargs.get('timeInForce', 'default')} "
                f"reduceOnly={kwargs['reduceOnly']} taker={taker_rate} maker={maker_rate}"
            )
            record_raw_reject(source="CREATE_ORDER", code=code, message=f"{raw_message} | {sent}")

            safe, category, _safe_msg = classify_venue_reject(code, raw_message)
            log.warning("apex sdk reject endpoint=/api/v3/order code=%s category=%s", safe, category)
            raise OrderRestError(f"UPSTREAM_REJECT:{safe}:{category}")


        data = payload.get("data") or {}
        if not isinstance(data, dict):
            raise OrderRestError("ORDER_SHAPE_UNEXPECTED")
        venue_id = data.get("id") or data.get("orderId")
        if not venue_id:
            raise OrderRestError("ORDER_ID_MISSING")
        return {
            "venue_order_id": str(venue_id),
            "client_order_id": data.get("clientOrderId") or data.get("clientId") or params.get("clientId"),
            "status": data.get("status") or data.get("state"),
            "sl_venue_order_id": (data.get("slOrderId") or data.get("slId")),
            "sl_attachment_confirmed": bool(sl) and _matches_attached_stop(data, kwargs),
            "tp_venue_order_id": (data.get("tpOrderId") or data.get("tpId")),
        }


    def cancel_by_client_order_id(self, _client_order_id: str) -> dict:
        raise OrderRestError("SDK_CANCEL_NOT_IMPLEMENTED")

    def get_open_orders(self, _symbol: str | None = None) -> list[dict]:
        raise OrderRestError("SDK_QUERY_NOT_IMPLEMENTED")

    def get_positions(self) -> list[dict]:
        raise OrderRestError("SDK_QUERY_NOT_IMPLEMENTED")