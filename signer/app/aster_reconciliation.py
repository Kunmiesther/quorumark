"""Recover persisted Aster intents without placing or retrying any order."""
import re
from . import aster_v3
from .aster_lifecycle import ACTIVE, TERMINAL, _quantity, _entry_snapshot


class AsterReconciliationError(ValueError):
    pass


def venue_client_id(intent):
    client_id = intent.get("client_order_id", "")
    if intent.get("reduce_only") is False and intent.get("order_type") == "LIMIT":
        if not re.fullmatch(r"tb[0-9a-f]{30}r[1-5]", client_id):
            raise AsterReconciliationError("ASTER_INTENT_ID_INVALID")
        return f"{client_id[:32]}-e"
    if intent.get("reduce_only") is True and intent.get("order_type") == "MARKET":
        if not re.fullmatch(r"tbx[0-9a-f]{30}", client_id):
            raise AsterReconciliationError("ASTER_INTENT_ID_INVALID")
        return client_id
    raise AsterReconciliationError("ASTER_INTENT_TYPE_UNSUPPORTED")


def observe_intent(credentials, intent):
    client_id = venue_client_id(intent)
    row = aster_v3.read_order(credentials, intent["symbol"], client_id)
    if intent["reduce_only"] is False:
        snapshot = _entry_snapshot(row, symbol=intent["symbol"], entry_id=client_id)
    else:
        if (not isinstance(row, dict) or row.get("clientOrderId") != client_id
                or row.get("symbol") != intent["symbol"] or row.get("type") != "MARKET"
                or row.get("positionSide") != "BOTH" or not (row.get("reduceOnly") is True or row.get("reduceOnly") == "true")
                or row.get("orderId") in (None, "") or row.get("status") not in ACTIVE | TERMINAL):
            raise AsterReconciliationError("ASTER_EXIT_IDENTITY_UNCONFIRMED")
        total, filled = _quantity(row.get("origQty")), _quantity(row.get("executedQty"))
        status = row["status"]
        if (total <= 0 or filled > total or (status == "NEW" and filled != 0)
                or (status == "FILLED" and filled != total)
                or (status == "PARTIALLY_FILLED" and not 0 < filled < total)):
            raise AsterReconciliationError("ASTER_EXIT_FILL_UNCONFIRMED")
        snapshot = {"client_order_id": client_id, "exchange_order_id": str(row["orderId"]),
                    "symbol": row["symbol"], "side": row.get("side"), "exchange_status": status,
                    "quantity": str(total), "executed_quantity": str(filled)}
    if (snapshot["side"] != intent["side"]
            or _quantity(snapshot["quantity"]) != _quantity(intent["size"])
            or _quantity(snapshot["executed_quantity"]) < _quantity(intent.get("filled_size", 0))):
        raise AsterReconciliationError("ASTER_LEDGER_VENUE_MISMATCH")
    known_id = intent.get("aster_order_id")
    if known_id and known_id != snapshot["exchange_order_id"]:
        raise AsterReconciliationError("ASTER_ORDER_ID_CHANGED")
    return snapshot


def persist_snapshot(db, intent, snapshot):
    db.reconcile_aster_order(user_id=intent["user_id"], connection_id=intent["connection_id"],
        intent_id=intent["id"], order_id=snapshot["exchange_order_id"],
        status=snapshot["exchange_status"], filled=snapshot["executed_quantity"])


def reconcile_connection(*, db, credentials, user_id, connection_id):
    # Oldest last-observed first prevents one ambiguous intent starving newer
    # orders. One bounded batch per normal reconciliation cycle; restart-safe.
    intents = db.list_aster_intents(user_id=user_id, connection_id=connection_id)
    observed, unknown = 0, 0
    for intent in intents:
        try:
            snapshot = observe_intent(credentials, intent)
            persist_snapshot(db, intent, snapshot)
            observed += 1
        except Exception:
            unknown += 1
            db.reconcile_aster_order(user_id=user_id, connection_id=connection_id,
                intent_id=intent["id"], order_id=None, status="UNKNOWN", filled=None)
    return {"status": "reconciled" if unknown == 0 else "ambiguous",
            "reconciliation_required": unknown > 0, "observed": observed, "unknown": unknown}


def cancel_pending_entries(*, db, credentials, user_id, connection_id, symbol, allow_cancel=True):
    """Cancel only exact ledger-owned entry IDs, preserving stops/manual orders.

    Validate the entire cancellation set before the first DELETE. Query again
    after every cancellation and before returning; uncertain fills never lead
    to a blind close or a mutation retry.
    """
    open_orders = aster_v3.read_open_orders(credentials, symbol)
    pending = [r for r in open_orders if r.get("symbol") != symbol or not (r.get("reduceOnly") is True or r.get("reduceOnly") == "true")]
    if not pending:
        return
    if not allow_cancel:
        raise AsterReconciliationError("CANCEL_ORDER_DISABLED")
    intents = db.list_aster_intents(user_id=user_id, connection_id=connection_id, symbol=symbol)
    if len(intents) >= 100:
        raise AsterReconciliationError("ASTER_CANCEL_LEDGER_INCOMPLETE")
    if any(i.get("state") == "signing" for i in intents):
        raise AsterReconciliationError("ASTER_CAMPAIGN_SUBMISSION_IN_PROGRESS")
    owned = {venue_client_id(i): i for i in intents if i.get("reduce_only") is False}
    selected = []
    for order in pending:
        intent = owned.get(order.get("clientOrderId"))
        if (not intent or order.get("symbol") != symbol
                or intent.get("user_id") != user_id or intent.get("connection_id") != connection_id):
            raise AsterReconciliationError("ASTER_EXIT_ENTRY_ORDERS_PENDING")
        before = observe_intent(credentials, intent)
        persist_snapshot(db, intent, before)
        selected.append((intent, before))
    for intent, before in selected:
        if before["exchange_status"] not in ACTIVE:
            continue
        try:
            aster_v3.cancel_order(credentials, symbol=symbol, client_order_id=before["client_order_id"])
        except aster_v3.AsterV3Error as exc:
            if exc.code != "ASTER_2011":
                raise
        after = observe_intent(credentials, {**intent, "filled_size": before["executed_quantity"],
                                            "aster_order_id": before["exchange_order_id"]})
        persist_snapshot(db, intent, after)
        if after["exchange_status"] not in TERMINAL:
            raise AsterReconciliationError("ASTER_CANCEL_RECONCILIATION_REQUIRED")
    remaining = aster_v3.read_open_orders(credentials, symbol)
    if any(r.get("symbol") != symbol or not (r.get("reduceOnly") is True or r.get("reduceOnly") == "true") for r in remaining):
        raise AsterReconciliationError("ASTER_EXIT_ENTRY_ORDERS_PENDING")
