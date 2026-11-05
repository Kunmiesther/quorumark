"""Connection-scoped Aster entry observation and cancellation.

No new position or close order can be created here. IDs are derived with the
same user/connection/campaign/rung formula used by the entry executor. A
missing venue row is unknown, never permission to resubmit an entry.
"""
from decimal import Decimal, InvalidOperation
from typing import Any

from . import aster_v3
from .aster_executor import _strategy_id


class AsterLifecycleError(Exception):
    def __init__(self, code: str, *, ambiguous: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.ambiguous = ambiguous


ACTIVE = frozenset({"NEW", "PARTIALLY_FILLED"})
TERMINAL = frozenset({"FILLED", "CANCELED", "EXPIRED", "REJECTED", "EXPIRED_IN_MATCH"})


def _false(value: Any) -> bool:
    return value is False or (isinstance(value, str) and value == "false")


def _quantity(value: Any) -> Decimal:
    try:
        result = Decimal(str(value))
    except (ValueError, InvalidOperation) as exc:
        raise AsterLifecycleError("ASTER_ORDER_QUANTITY_UNREADABLE") from exc
    if not result.is_finite() or result < 0:
        raise AsterLifecycleError("ASTER_ORDER_QUANTITY_UNREADABLE")
    return result


def entry_identity(*, user_id: str, connection_id: str, client_order_id: str,
                   symbol: str, rung: int) -> tuple[str, str]:
    if (not user_id or not connection_id or not client_order_id
            or type(rung) is not int or rung not in range(1, 6)
            or symbol not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}):
        raise AsterLifecycleError("ASTER_LIFECYCLE_TARGET_INVALID")
    strategy_id = _strategy_id(user_id, connection_id, client_order_id, rung)
    return strategy_id, f"{strategy_id[:32]}-e"


def _entry_snapshot(row: dict, *, symbol: str, entry_id: str) -> dict:
    if (not isinstance(row, dict) or row.get("symbol") != symbol
            or row.get("clientOrderId") != entry_id
            or row.get("type") != "LIMIT" or row.get("positionSide") != "BOTH"
            or row.get("side") not in {"BUY", "SELL"}
            or not _false(row.get("reduceOnly"))
            or not _false(row.get("closePosition"))
            or row.get("status") not in ACTIVE | TERMINAL
            or row.get("orderId") in (None, "")):
        raise AsterLifecycleError("ASTER_ENTRY_IDENTITY_UNCONFIRMED")
    total = _quantity(row.get("origQty"))
    filled = _quantity(row.get("executedQty"))
    if total <= 0 or filled > total:
        raise AsterLifecycleError("ASTER_ORDER_QUANTITY_UNREADABLE")
    status = row["status"]
    if ((status == "NEW" and filled != 0)
            or (status == "FILLED" and filled != total)
            or (status == "PARTIALLY_FILLED" and not 0 < filled < total)):
        raise AsterLifecycleError("ASTER_ORDER_STATUS_INCONSISTENT")
    return {
        "client_order_id": entry_id, "exchange_order_id": str(row["orderId"]),
        "symbol": symbol, "side": row["side"], "exchange_status": status,
        "quantity": str(total), "executed_quantity": str(filled),
        "remaining_quantity": str(total - filled) if status in ACTIVE else "0",
    }


def observe_entry(credentials: aster_v3.AsterCredentials, **target) -> dict:
    strategy_id, entry_id = entry_identity(**target)
    row = aster_v3.read_order(credentials, target["symbol"], entry_id)
    snapshot = _entry_snapshot(row, symbol=target["symbol"], entry_id=entry_id)
    return {"status": "observed", "connection_id": target["connection_id"],
            "exchange": "aster", "campaign_orders": [
                {**snapshot, "rung": target["rung"], "client_strategy_id": strategy_id},
            ]}


def cancel_entry(credentials: aster_v3.AsterCredentials, **target) -> dict:
    """Cancel an exact entry's remainder, leaving its stop and fills untouched.

    The exchange can fill an order between the read and DELETE. Always read
    again afterwards; no cancel receipt is treated as proof of a flat position.
    """
    before = observe_entry(credentials, **target)
    entry = before["campaign_orders"][0]
    if entry["exchange_status"] in TERMINAL:
        return {**before, "status": "noop"}
    try:
        aster_v3.cancel_order(
            credentials, symbol=target["symbol"], client_order_id=entry["client_order_id"],
        )
    except aster_v3.AsterV3Error as exc:
        # Unknown-order rejection can race a terminal fill. Re-read once;
        # never retry the mutation and never delete the linked stop.
        if exc.code != "ASTER_2011":
            raise
    except Exception as exc:
        raise AsterLifecycleError("ASTER_CANCEL_EXECUTION_UNKNOWN", ambiguous=True) from exc
    try:
        after = observe_entry(credentials, **target)
    except Exception as exc:
        raise AsterLifecycleError("ASTER_CANCEL_RECONCILIATION_REQUIRED", ambiguous=True) from exc
    updated = after["campaign_orders"][0]
    if (updated["exchange_order_id"] != entry["exchange_order_id"]
            or updated["side"] != entry["side"]
            or _quantity(updated["quantity"]) != _quantity(entry["quantity"])
            or _quantity(updated["executed_quantity"]) < _quantity(entry["executed_quantity"])
            or updated["exchange_status"] not in TERMINAL):
        raise AsterLifecycleError("ASTER_CANCEL_RECONCILIATION_REQUIRED", ambiguous=True)
    return {**after, "status": "cancelled" if updated["exchange_status"] == "CANCELED" else "observed"}
