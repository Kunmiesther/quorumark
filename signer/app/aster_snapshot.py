"""Read-only, allowlisted Aster account snapshots. Never fabricate a flat account."""
from decimal import Decimal, InvalidOperation
import re
import time

from . import aster_v3


def number(value, *, positive=False, nonnegative=False):
    try:
        result = Decimal(str(value))
    except (ValueError, InvalidOperation) as exc:
        raise aster_v3.AsterV3Error("ASTER_SNAPSHOT_INVALID_NUMBER") from exc
    if not result.is_finite() or (positive and result <= 0) or (nonnegative and result < 0):
        raise aster_v3.AsterV3Error("ASTER_SNAPSHOT_INVALID_NUMBER")
    return result


def symbol(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Z0-9]+USDT", value):
        raise aster_v3.AsterV3Error("ASTER_SNAPSHOT_INVALID_SYMBOL")
    return value[:-4] + "-USDT"


def boolean(value):
    if value is True or value == "true":
        return True
    if value is False or value == "false":
        return False
    raise aster_v3.AsterV3Error("ASTER_SNAPSHOT_INVALID_BOOLEAN")


def equity(credentials):
    account = aster_v3.read_account(credentials)
    return {
        "total_equity": str(number(account.get("totalMarginBalance"))),
        "available_balance": str(number(account.get("availableBalance"), nonnegative=True)),
        "wallet_balance": str(number(account.get("totalWalletBalance"))),
        "currency": "USDT",
    }


def positions(credentials):
    raw_positions = aster_v3.read_positions(credentials)
    # All symbols, not just those with positions: resting entries also matter.
    raw_orders = aster_v3.read_open_orders(credentials)
    normalized = []
    seen = set()
    for row in raw_positions:
        quantity = number(row.get("positionAmt"))
        if quantity == 0:
            continue
        # positionRisk includes flat contracts outside our normalized USDT
        # universe. A zero quantity is no exposure and needs no symbol mapping.
        # Nonzero unsupported exposure still fails explicitly; never hide it.
        pair = symbol(row.get("symbol"))
        side = "LONG" if quantity > 0 else "SHORT"
        if row.get("positionSide") not in ("BOTH", side) or (pair, side) in seen:
            raise aster_v3.AsterV3Error("ASTER_POSITION_IDENTITY_UNCONFIRMED")
        seen.add((pair, side))
        normalized.append({
            "symbol": pair, "side": side, "size": str(abs(quantity)),
            "entry_price": str(number(row.get("entryPrice"), positive=True)),
            "mark_price": str(number(row.get("markPrice"), positive=True)),
            "unrealized_pnl": str(number(row.get("unRealizedProfit"))),
            "liquidation_price": str(number(row.get("liquidationPrice"), nonnegative=True)),
            "leverage": str(number(row.get("leverage"), positive=True)),
            "margin_type": row.get("marginType"),
            "isolated_margin": str(number(row.get("isolatedMargin"), nonnegative=True)),
        })
    orders = []
    for row in raw_orders:
        if row.get("orderId") in (None, "") or row.get("side") not in ("BUY", "SELL"):
            raise aster_v3.AsterV3Error("ASTER_OPEN_ORDER_IDENTITY_UNCONFIRMED")
        total = number(row.get("origQty"), nonnegative=True)
        executed = number(row.get("executedQty"), nonnegative=True)
        if executed > total:
            raise aster_v3.AsterV3Error("ASTER_OPEN_ORDER_QUANTITY_UNCONFIRMED")
        orders.append({
            "symbol": symbol(row.get("symbol")), "id": str(row["orderId"]),
            "clientOrderId": row.get("clientOrderId"), "side": row["side"],
            "type": row.get("type"), "status": row.get("status"),
            "price": str(number(row.get("price"), nonnegative=True)),
            "triggerPrice": str(number(row.get("stopPrice"), nonnegative=True)),
            "size": str(total - executed), "reduceOnly": boolean(row.get("reduceOnly")),
        })
    return {"positions": normalized, "open_orders": orders}


def fills(credentials, *, since_ts_ms=None, until_ts_ms=None):
    """Complete bounded window across the four supported symbols, or an error.

    Recursively split saturated time windows instead of advancing a global
    cursor past unseen trades. A single saturated millisecond is explicitly
    incomplete, never a successful truncated history.
    """
    end = int(time.time() * 1000) if until_ts_ms is None else until_ts_ms
    start = end - 7 * 86400000 if since_ts_ms is None else since_ts_ms
    if type(start) is not int or type(end) is not int or start < 0 or end < start:
        raise aster_v3.AsterV3Error("ASTER_FILL_WINDOW_INVALID")
    end = min(end, start + 7 * 86400000)
    calls = 0

    def read_window(market, lo, hi):
        nonlocal calls
        calls += 1
        if calls > 32:
            raise aster_v3.AsterV3Error("ASTER_FILL_WINDOW_INCOMPLETE")
        rows = aster_v3.request("GET", "/fapi/v3/userTrades", credentials, [
            ("symbol", market), ("startTime", lo), ("endTime", hi), ("limit", 1000),
        ])
        if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
            raise aster_v3.AsterV3Error("ASTER_INVALID_FILLS_RESPONSE")
        if len(rows) >= 1000:
            if lo == hi:
                raise aster_v3.AsterV3Error("ASTER_FILL_WINDOW_INCOMPLETE")
            mid = (lo + hi) // 2
            return read_window(market, lo, mid) + read_window(market, mid + 1, hi)
        for row in rows:
            if (row.get("symbol") != market or type(row.get("time")) is not int
                    or not lo <= row["time"] <= hi):
                raise aster_v3.AsterV3Error("ASTER_FILL_WINDOW_MISMATCH")
        return rows

    result = []
    seen = set()
    for market in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"):
        for row in read_window(market, start, end):
            if (row.get("id") in (None, "") or row.get("orderId") in (None, "")
                    or row.get("side") not in ("BUY", "SELL")
                    or row.get("commissionAsset") != "USDT"
                    or row.get("positionSide") != "BOTH"):
                raise aster_v3.AsterV3Error("ASTER_FILL_IDENTITY_UNCONFIRMED")
            key = f"{market}:{row['id']}"
            if key in seen:
                raise aster_v3.AsterV3Error("ASTER_FILL_DUPLICATE")
            seen.add(key)
            result.append({
                "venue_fill_id": key, "venue_order_id": str(row["orderId"]),
                "symbol": symbol(market), "side": row["side"],
                "price": str(number(row.get("price"), positive=True)),
                "size": str(number(row.get("qty"), positive=True)),
                # Aster account trades report commission as a signed cash flow.
                # FIFO expects costs positive and rebates negative.
                "fee": str(-number(row.get("commission"))), "fee_currency": "USDT",
                "liquidity": "MAKER" if boolean(row.get("maker")) else "TAKER",
                "fill_ts_ms": row["time"],
            })
    result.sort(key=lambda row: (row["fill_ts_ms"], row["venue_fill_id"]))
    return {"fills": result, "complete_through_ms": end}
