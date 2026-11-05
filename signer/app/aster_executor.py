"""Durable, connection-scoped Aster campaign submission.

This module is intentionally separate from the ApeX execution pipeline. A
caller must perform signed-request authentication, credential ownership,
permission and venue preflight before invoking it. It never cancels all venue
orders as a compensation mechanism, because that could affect other trades.
"""
from __future__ import annotations

import hashlib
from decimal import Decimal, InvalidOperation
from typing import Any

from . import aster_v3
from .aster_campaign import AsterCampaign, prepare_aster_campaign


class AsterExecutionError(Exception):
    def __init__(self, code: str, *, ambiguous: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.ambiguous = ambiguous


def _strategy_id(user_id: str, connection_id: str, client_order_id: str, rung: int) -> str:
    digest = hashlib.sha256(
        f"{user_id}:{connection_id}:{client_order_id}:{rung}".encode("utf-8")
    ).hexdigest()[:30]
    return f"tb{digest}r{rung}"


def _matching_number(value: Any, expected: str) -> bool:
    try:
        return Decimal(str(value)) == Decimal(expected)
    except (InvalidOperation, TypeError, ValueError):
        return False


def _matching_bool(value: Any, expected: bool) -> bool:
    return value is expected or (isinstance(value, str) and value.lower() == str(expected).lower())


def _verify_linked_stop(
    confirmed: dict[str, Any], *, strategy_id: str, symbol: str,
    side: str, quantity: str, price: str, stop_price: str,
) -> None:
    """A strategy-level WORKING status alone is not proof of protection."""
    if confirmed.get("strategyType") != "OTO":
        raise AsterExecutionError("ASTER_STRATEGY_TYPE_UNCONFIRMED", ambiguous=True)
    children = confirmed.get("subOrders")
    if not isinstance(children, list) or len(children) != 2 or any(not isinstance(row, dict) for row in children):
        raise AsterExecutionError("ASTER_LINKED_STOP_UNCONFIRMED", ambiguous=True)
    by_id = {str(row.get("strategySubId")): row for row in children}
    if set(by_id) != {"1", "2"}:
        raise AsterExecutionError("ASTER_LINKED_STOP_UNCONFIRMED", ambiguous=True)
    entry, stop = by_id["1"], by_id["2"]
    opposite = "SELL" if side == "BUY" else "BUY"
    if not (
        entry.get("clientOrderId") == f"{strategy_id[:32]}-e"
        and entry.get("symbol") == symbol
        and entry.get("side") == side
        and entry.get("positionSide") == "BOTH"
        and entry.get("type") == "LIMIT"
        and entry.get("timeInForce") == "GTC"
        and _matching_number(entry.get("quantity"), quantity)
        and _matching_number(entry.get("price"), price)
        and _matching_bool(entry.get("closePosition"), False)
        and stop.get("clientOrderId") == f"{strategy_id[:32]}-s"
        and stop.get("symbol") == symbol
        and stop.get("side") == opposite
        and stop.get("positionSide") == "BOTH"
        and stop.get("type") == "STOP_MARKET"
        and _matching_number(stop.get("quantity"), quantity)
        and _matching_bool(stop.get("reduceOnly"), True)
        and _matching_bool(stop.get("closePosition"), False)
        and stop.get("workingType") == "MARK_PRICE"
        and _matching_number(stop.get("stopPrice"), stop_price)
        and str(stop.get("firstDrivenId")) == "1"
        and stop.get("firstDrivenOn") == "PARTIALLY_FILLED_OR_FILLED"
        and stop.get("firstTrigger") == "PLACE_ORDER"
        and entry.get("status") not in ("REJECTED", "CANCELED", "EXPIRED")
        and stop.get("status") not in ("REJECTED", "CANCELED", "EXPIRED")
    ):
        raise AsterExecutionError("ASTER_LINKED_STOP_UNCONFIRMED", ambiguous=True)


def submit_aster_campaign(
    *, db: Any, credentials: aster_v3.AsterCredentials,
    user_id: str, connection_id: str, client_order_id: str,
    symbol: str, side: str, leverage: int,
) -> dict[str, Any]:
    """Reserve five unique intents before sending the first linked order.

    Accepted rungs are never silently cancelled or retried. If any later rung
    fails, the returned partial/ambiguous outcome names only confirmed venue
    strategy IDs; the caller must reconcile the symbol before another entry.
    """
    if not client_order_id:
        raise AsterExecutionError("ASTER_CAMPAIGN_INVALID")
    if db.is_execution_halted(user_id, connection_id, require_live=True):
        raise AsterExecutionError("EXECUTION_HALTED")
    # The caller never supplies balance, margin, prices, or quantities. Every
    # submission starts from fresh authenticated venue state and venue rules.
    campaign: AsterCampaign = prepare_aster_campaign(
        credentials, symbol=symbol, side=side, leverage=leverage,
    )
    if len(campaign.rungs) != 5:
        raise AsterExecutionError("ASTER_CAMPAIGN_INVALID")
    reserved: list[tuple[str, str, Any]] = []
    try:
        for rung in campaign.rungs:
            strategy_id = _strategy_id(user_id, connection_id, client_order_id, rung.index)
            intent_id = db.insert_order_intent({
                "user_id": user_id,
                "connection_id": connection_id,
                "client_order_id": strategy_id,
                "aster_campaign_key": client_order_id,
                "automation_campaign_key": client_order_id,
                "environment": "mainnet",
                "venue": "aster",
                "symbol": campaign.symbol,
                "side": campaign.side,
                "order_type": "LIMIT",
                "size": float(rung.quantity),
                "price": float(rung.price),
                "reduce_only": False,
                "state": "signing",
            })
            if not intent_id:
                raise AsterExecutionError("ASTER_INTENT_RESERVATION_UNAVAILABLE")
            reserved.append((intent_id, strategy_id, rung))
    except Exception as exc:
        for intent_id, _, _ in reserved:
            try:
                db.transition_order_intent(
                    intent_id=intent_id, user_id=user_id, state="rejected",
                    state_reason="ASTER_CAMPAIGN_RESERVATION_INCOMPLETE",
                )
            except Exception:
                pass
        if "INTENT_DUPLICATE" in str(exc):
            raise AsterExecutionError("INTENT_ALREADY_RESERVED") from exc
        if isinstance(exc, AsterExecutionError):
            raise
        raise AsterExecutionError("ASTER_INTENT_RESERVATION_UNAVAILABLE") from exc

    # Venue leverage is account/symbol state. Sizing from a requested value
    # without confirming the venue setting makes the margin plan untrue.
    # Do this only after idempotent intent reservation, but before any entry.
    try:
        if db.is_execution_halted(user_id, connection_id, require_live=True):
            raise AsterExecutionError("EXECUTION_HALTED")
        aster_v3.set_leverage(credentials, campaign.symbol, campaign.leverage)
    except Exception as exc:
        reason = (
            exc.code if isinstance(exc, (aster_v3.AsterV3Error, AsterExecutionError))
            else "ASTER_LEVERAGE_SETUP_FAILED"
        )
        transition_failed = False
        for intent_id, _, _ in reserved:
            try:
                db.transition_order_intent(
                    intent_id=intent_id, user_id=user_id, state="rejected",
                    state_reason=reason,
                )
            except Exception:
                transition_failed = True
        return {
            "status": "ambiguous" if transition_failed else "rejected",
            "reject_reason": reason,
            "campaign_orders": [],
            "submitted_rungs": 0,
            "reconciliation_required": transition_failed,
        }

    submitted: list[dict[str, Any]] = []
    for index, (intent_id, strategy_id, rung) in enumerate(reserved):
        accepted = None
        submission_attempted = False
        try:
            if db.is_execution_halted(user_id, connection_id, require_live=True):
                raise AsterExecutionError("EXECUTION_HALTED")
            submission_attempted = True
            accepted = aster_v3.place_oto_entry_with_stop(
                credentials, symbol=campaign.symbol, side=campaign.side,
                quantity=rung.quantity, entry_price=rung.price,
                stop_price=campaign.hard_stop_price,
                client_strategy_id=strategy_id,
            )
            confirmed = aster_v3.read_strategy_order(credentials, strategy_id)
            if str(confirmed.get("strategyId")) != str(accepted["strategyId"]):
                raise AsterExecutionError("ASTER_STRATEGY_RECONCILIATION_MISMATCH", ambiguous=True)
            if confirmed.get("strategyStatus") not in ("WORKING", "NEW"):
                raise AsterExecutionError("ASTER_STRATEGY_STATUS_UNCONFIRMED", ambiguous=True)
            _verify_linked_stop(
                confirmed, strategy_id=strategy_id, symbol=campaign.symbol,
                side=campaign.side, quantity=rung.quantity, price=rung.price,
                stop_price=campaign.hard_stop_price,
            )
            db.transition_order_intent(
                intent_id=intent_id, user_id=user_id, state="submitted",
                exchange_order_id=str(accepted["strategyId"]),
            )
            submitted.append({
                "rung": rung.index,
                "client_strategy_id": strategy_id,
                "strategy_id": str(accepted["strategyId"]),
                "price": rung.price,
                "quantity": rung.quantity,
            })
        except Exception as exc:
            ambiguous = (
                isinstance(exc, aster_v3.AsterV3Error) and exc.ambiguous
            ) or (isinstance(exc, AsterExecutionError) and exc.ambiguous)
            # An unexpected exception after entering the mutating transport
            # is not proof that the venue rejected the order. Do not label
            # it retryable and risk opening the same exposure twice.
            if submission_attempted and not isinstance(exc, (aster_v3.AsterV3Error, AsterExecutionError)):
                ambiguous = True
            # A successful POST followed by failed read/DB transition is also
            # uncertain even when the thrown read error was not itself tagged.
            if accepted is not None:
                ambiguous = True
            reason = (
                exc.code if isinstance(exc, (aster_v3.AsterV3Error, AsterExecutionError))
                else "ASTER_SUBMISSION_UNEXPECTED"
            )
            try:
                accepted_id = (
                    str(accepted["strategyId"])
                    if isinstance(accepted, dict) and accepted.get("strategyId") is not None
                    else None
                )
                db.transition_order_intent(
                    intent_id=intent_id, user_id=user_id,
                    state="reconciliation_required" if ambiguous else "rejected",
                    state_reason=reason,
                    # Preserve a known venue ID even if verification or the
                    # preceding database transition failed. This remains
                    # uncertain, not part of the confirmed submitted count.
                    **({"exchange_order_id": accepted_id} if accepted_id is not None else {}),
                )
            except Exception:
                ambiguous = True
            for remaining_id, _, _ in reserved[index + 1:]:
                try:
                    db.transition_order_intent(
                        intent_id=remaining_id, user_id=user_id, state="rejected",
                        state_reason="ASTER_CAMPAIGN_STOPPED",
                    )
                except Exception:
                    ambiguous = True
            return {
                "status": "ambiguous" if ambiguous or submitted else "rejected",
                "reject_reason": reason,
                "campaign_orders": submitted,
                "submitted_rungs": len(submitted),
                "reconciliation_required": ambiguous or bool(submitted),
            }
    return {
        "status": "submitted",
        "exchange_order_id": submitted[0]["strategy_id"],
        "exchange_status": "accepted",
        "campaign_rung_count": 5,
        "campaign_orders": submitted,
        "campaign_margin_usd": campaign.actual_margin_usd,
        "wallet_equity_at_plan_usd": campaign.wallet_balance_usd,
        "hard_stop_price": campaign.hard_stop_price,
        "protections_attached": True,
    }
