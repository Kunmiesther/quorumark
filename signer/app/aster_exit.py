"""Connection-scoped reduce-only Aster exits. No entry, leverage or broad cancel.

An accepted close is not necessarily a fill. Preserve unknown outcomes and
reserve a durable request ID before the only POST; never automatically retry.
"""
import hashlib
from decimal import Decimal, InvalidOperation
from . import aster_v3
from .aster_reconciliation import cancel_pending_entries, AsterReconciliationError


class AsterExitError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def reduce_only(value):
    return value is True or value == "true"


def amount(raw):
    try:
        value = Decimal(str(raw))
        if not value.is_finite():
            raise ValueError()
        return value
    except (InvalidOperation, ValueError, TypeError):
        raise AsterExitError("ASTER_EXIT_QUANTITY_INVALID") from None


def close_position(*, db, credentials, user_id, connection_id, client_order_id,
                   symbol, side, quantity, allow_cancel=False):
    if symbol not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"} or side not in {"BUY", "SELL"}:
        raise AsterExitError("ASTER_EXIT_TARGET_INVALID")
    size = amount(quantity)
    if size <= 0 or not client_order_id:
        raise AsterExitError("ASTER_EXIT_QUANTITY_INVALID")
    if aster_v3.read_position_mode(credentials) != "one_way":
        raise AsterExitError("ASTER_EXIT_POSITION_MODE_UNSUPPORTED")
    rows = aster_v3.read_positions(credentials, symbol)
    positions = [row for row in rows if row.get("symbol") == symbol and amount(row.get("positionAmt")) != 0]
    if len(positions) != 1 or positions[0].get("positionSide") != "BOTH":
        raise AsterExitError("ASTER_EXIT_POSITION_UNCONFIRMED")
    position = amount(positions[0]["positionAmt"])
    if side != ("SELL" if position > 0 else "BUY") or size > abs(position):
        raise AsterExitError("ASTER_EXIT_EXPOSURE_MISMATCH")
    try:
        cancel_pending_entries(db=db, credentials=credentials, user_id=user_id,
                               connection_id=connection_id, symbol=symbol, allow_cancel=allow_cancel)
    except AsterReconciliationError as exc:
        raise AsterExitError(str(exc)) from None
    # Entries or protective exits may fill during cancellation. Re-read, never
    # increase the user-requested close size or infer flat from a missing read.
    refreshed = [r for r in aster_v3.read_positions(credentials, symbol)
                 if r.get("symbol") == symbol and amount(r.get("positionAmt")) != 0]
    if (len(refreshed) != 1 or refreshed[0].get("positionSide") != "BOTH"
            or (amount(refreshed[0]["positionAmt"]) > 0) != (position > 0)
            or size > abs(amount(refreshed[0]["positionAmt"]))):
        raise AsterExitError("ASTER_EXIT_EXPOSURE_CHANGED")
    exit_id = "tbx" + hashlib.sha256(f"{user_id}:{connection_id}:{client_order_id}".encode()).hexdigest()[:30]
    try:
        intent_id = db.insert_order_intent({
            "user_id": user_id, "connection_id": connection_id, "client_order_id": exit_id,
            "environment": "mainnet", "venue": "aster", "symbol": symbol, "side": side,
            "order_type": "MARKET", "size": float(size), "reduce_only": True, "state": "signing",
        })
        if not intent_id:
            raise AsterExitError("ASTER_EXIT_RESERVATION_FAILED")
    except AsterExitError:
        raise
    except Exception:
        raise AsterExitError("ASTER_EXIT_RESERVATION_FAILED") from None
    receipt = None
    try:
        receipt = aster_v3.place_order(credentials, symbol=symbol, side=side,
            order_type="MARKET", quantity=str(size), client_order_id=exit_id, reduce_only=True)
        observed = aster_v3.read_order(credentials, symbol, exit_id)
        if (observed.get("clientOrderId") != exit_id or observed.get("symbol") != symbol
                or observed.get("side") != side or observed.get("positionSide") != "BOTH"
                or observed.get("type") != "MARKET"
                or not reduce_only(observed.get("reduceOnly"))
                or str(observed.get("orderId")) != str(receipt.get("orderId"))
                or observed.get("orderId") in (None, "")
                or amount(observed.get("origQty")) != size
                or observed.get("status") not in {"NEW", "PARTIALLY_FILLED", "FILLED"}):
            raise AsterExitError("ASTER_EXIT_UNCONFIRMED")
        filled = amount(observed.get("executedQty"))
        status = observed["status"]
        if (not 0 <= filled <= size or (status == "FILLED" and filled != size)
                or (status == "NEW" and filled != 0)
                or (status == "PARTIALLY_FILLED" and not 0 < filled < size)):
            raise AsterExitError("ASTER_EXIT_UNCONFIRMED")
        db.transition_order_intent(intent_id=intent_id, user_id=user_id, state="submitted",
                                   exchange_order_id=str(observed["orderId"]))
        db.reconcile_aster_order(user_id=user_id, connection_id=connection_id,
            intent_id=intent_id, order_id=str(observed["orderId"]), status=status, filled=str(filled))
        return {"status": "submitted", "exchange_order_id": str(observed["orderId"]),
                "exchange_status": status.lower(), "filled_size": str(filled),
                "reduce_only": True, "reconciliation_required": status != "FILLED"}
    except Exception as exc:
        # Only a definite venue rejection before a receipt is a rejection.
        uncertain = not (isinstance(exc, aster_v3.AsterV3Error) and not exc.ambiguous and receipt is None)
        reason = exc.code if isinstance(exc, aster_v3.AsterV3Error) else "ASTER_EXIT_UNCONFIRMED"
        try:
            db.transition_order_intent(intent_id=intent_id, user_id=user_id,
                state="reconciliation_required" if uncertain else "rejected", state_reason=reason,
                exchange_order_id=str(receipt["orderId"]) if isinstance(receipt, dict) and receipt.get("orderId") else None)
        except Exception:
            uncertain = True
        return {"status": "ambiguous" if uncertain else "rejected", "reject_reason": reason,
                "reconciliation_required": uncertain}
