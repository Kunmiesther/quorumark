"""Pure Aster five-rung plan using the owner's wallet-compounding contract.

No order is sent here. The signer must still check the authenticated account,
position mode, existing exposure, execution halt, and durable idempotency
before handing any rung to the Aster transport.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_UP

from . import aster_v3
from shared.parity_constants import get_decimal


class AsterPlanError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AsterRung:
    index: int
    price: str
    quantity: str
    notional_usd: str
    margin_usd: str


@dataclass(frozen=True)
class AsterCampaign:
    symbol: str
    side: str
    leverage: int
    wallet_balance_usd: str
    target_margin_usd: str
    actual_margin_usd: str
    hard_stop_price: str
    rungs: tuple[AsterRung, ...]


def validate_entry_preflight(
    *, symbol: str, account: dict, positions: list[dict],
    open_orders: list[dict], position_mode: str,
) -> tuple[Decimal, Decimal]:
    """Reject ambiguous venue state before an Aster entry is reserved.

    This is connection-account scoped. It never treats another wallet's
    balance or an app database snapshot as authority for live exposure.
    """
    if position_mode != "one_way":
        raise AsterPlanError("ASTER_CAMPAIGN_POSITION_MODE_UNSUPPORTED")
    if account.get("canTrade") is not True:
        raise AsterPlanError("ASTER_CAMPAIGN_ACCOUNT_CANNOT_TRADE")
    balance = _dec(account.get("totalWalletBalance"), "ASTER_CAMPAIGN_BAD_BALANCE")
    available = _dec(account.get("availableBalance"), "ASTER_CAMPAIGN_BAD_BALANCE")
    if balance <= 0 or available < 0:
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_BALANCE")
    for position in positions:
        if not isinstance(position, dict) or position.get("symbol") != symbol:
            continue
        amount = _dec(position.get("positionAmt"), "ASTER_CAMPAIGN_POSITION_UNREADABLE")
        if amount != 0:
            raise AsterPlanError("ASTER_CAMPAIGN_EXISTING_POSITION")
    if any(not isinstance(order, dict) or order.get("symbol") == symbol for order in open_orders):
        raise AsterPlanError("ASTER_CAMPAIGN_EXISTING_ORDER")
    return balance, available


def _dec(value: object, code: str) -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise AsterPlanError(code) from exc
    if not number.is_finite():
        raise AsterPlanError(code)
    return number


def _grid(value: Decimal, step: Decimal, *, up: bool = False) -> Decimal:
    return (value / step).to_integral_value(rounding=ROUND_UP if up else ROUND_DOWN) * step


def _s(value: Decimal) -> str:
    return format(value.normalize(), "f")


def build_aster_campaign(
    *, symbol: str, side: str, wallet_balance_usd: object,
    available_collateral_usd: object, mark_price: object, leverage: int,
    venue_max_leverage: int, rules: dict[str, str],
) -> AsterCampaign:
    if symbol not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}:
        raise AsterPlanError("ASTER_CAMPAIGN_SYMBOL_UNSUPPORTED")
    if side not in ("BUY", "SELL"):
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_SIDE")
    if type(leverage) is not int or leverage < 1 or leverage > min(aster_v3.MAX_LEVERAGE, venue_max_leverage):
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_LEVERAGE")
    if rules.get("symbol") != symbol:
        raise AsterPlanError("ASTER_CAMPAIGN_RULES_MISMATCH")

    balance = _dec(wallet_balance_usd, "ASTER_CAMPAIGN_BAD_BALANCE")
    available = _dec(available_collateral_usd, "ASTER_CAMPAIGN_BAD_BALANCE")
    mark = _dec(mark_price, "ASTER_CAMPAIGN_BAD_MARK")
    step = _dec(rules.get("step_size"), "ASTER_CAMPAIGN_BAD_RULES")
    min_qty = _dec(rules.get("min_quantity"), "ASTER_CAMPAIGN_BAD_RULES")
    max_qty = _dec(rules.get("max_quantity"), "ASTER_CAMPAIGN_BAD_RULES")
    tick = _dec(rules.get("tick_size"), "ASTER_CAMPAIGN_BAD_RULES")
    min_notional = _dec(rules.get("min_notional"), "ASTER_CAMPAIGN_BAD_RULES")
    if any(v <= 0 for v in (balance, mark, step, min_qty, max_qty, tick, min_notional)):
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_RULES_OR_BALANCE")

    target = balance * get_decimal("orchestration", "campaign_margin_fraction_of_settled_wallet_balance")
    reserve = get_decimal("pilot", "allocation_reserve_floor_usd")
    if available - reserve < target:
        raise AsterPlanError("ASTER_CAMPAIGN_COLLATERAL_INSUFFICIENT")
    rung_count = 5
    if int(get_decimal("orchestration", "campaign_rung_count")) != rung_count:
        raise AsterPlanError("ASTER_CAMPAIGN_RUNG_CONTRACT_MISMATCH")
    span = min(
        get_decimal("ladder", "ladder_span_roi") / Decimal(leverage),
        get_decimal("ladder", "ladder_span_pct_cap"),
    )
    per_rung = target / Decimal(rung_count)
    rungs: list[AsterRung] = []
    actual_margin = Decimal(0)
    previous = None
    for index in range(rung_count):
        fraction = Decimal(index) / Decimal(rung_count - 1)
        raw_price = mark * (Decimal(1) - span * fraction) if side == "BUY" else mark * (Decimal(1) + span * fraction)
        price = _grid(raw_price, tick, up=side == "SELL")
        if price <= 0 or (previous is not None and (
            (side == "BUY" and price >= previous) or (side == "SELL" and price <= previous)
        )):
            raise AsterPlanError("ASTER_CAMPAIGN_RUNG_PRICE_COLLISION")
        quantity = _grid(per_rung * Decimal(leverage) / price, step)
        notional = quantity * price
        if quantity < min_qty or notional < min_notional:
            raise AsterPlanError("ASTER_CAMPAIGN_RUNG_BELOW_VENUE_MINIMUM")
        if quantity > max_qty:
            raise AsterPlanError("ASTER_CAMPAIGN_RUNG_ABOVE_VENUE_MAXIMUM")
        margin = notional / Decimal(leverage)
        if margin > per_rung:
            raise AsterPlanError("ASTER_CAMPAIGN_RUNG_OVERSPEND")
        actual_margin += margin
        rungs.append(AsterRung(index + 1, _s(price), _s(quantity), _s(notional), _s(margin)))
        previous = price
    if actual_margin > target:
        raise AsterPlanError("ASTER_CAMPAIGN_OVERSPEND")
    deepest = previous
    assert deepest is not None
    stop_pct = get_decimal("ladder", "hard_stop_beyond_last_rung_pct")
    stop_raw = deepest * (Decimal(1) - stop_pct) if side == "BUY" else deepest * (Decimal(1) + stop_pct)
    stop = _grid(stop_raw, tick, up=side == "SELL")
    if stop <= 0 or (side == "BUY" and stop >= deepest) or (side == "SELL" and stop <= deepest):
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_HARD_STOP")
    return AsterCampaign(
        symbol=symbol, side=side, leverage=leverage,
        wallet_balance_usd=_s(balance), target_margin_usd=_s(target),
        actual_margin_usd=_s(actual_margin), hard_stop_price=_s(stop),
        rungs=tuple(rungs),
    )


def prepare_aster_campaign(
    credentials: aster_v3.AsterCredentials, *, symbol: str, side: str, leverage: int,
) -> AsterCampaign:
    """Read one authenticated Aster account and build, but never submit, a campaign."""
    if symbol not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}:
        raise AsterPlanError("ASTER_CAMPAIGN_SYMBOL_UNSUPPORTED")
    if side not in ("BUY", "SELL") or type(leverage) is not int or not 1 <= leverage <= aster_v3.MAX_LEVERAGE:
        raise AsterPlanError("ASTER_CAMPAIGN_BAD_INPUT")
    account = aster_v3.read_account(credentials)
    mode = aster_v3.read_position_mode(credentials)
    positions = aster_v3.read_positions(credentials, symbol)
    orders = aster_v3.read_open_orders(credentials, symbol)
    balance, available = validate_entry_preflight(
        symbol=symbol, account=account, positions=positions,
        open_orders=orders, position_mode=mode,
    )
    rules = aster_v3.symbol_rules(symbol)
    mark = aster_v3.mark_price(symbol)
    intended_notional = balance * get_decimal(
        "orchestration", "campaign_margin_fraction_of_settled_wallet_balance",
    ) * Decimal(leverage)
    venue_max = aster_v3.max_initial_leverage(credentials, symbol, intended_notional)
    return build_aster_campaign(
        symbol=symbol, side=side, wallet_balance_usd=balance,
        available_collateral_usd=available, mark_price=mark,
        leverage=leverage, venue_max_leverage=venue_max, rules=rules,
    )
