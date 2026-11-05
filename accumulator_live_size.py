"""Canonical entry-size derivation for the live Accumulator/Vanguard bridge.

THERE IS EXACTLY ONE SIZING ALGORITHM HERE AND IT IS NOT A NEW ONE.
Every number below comes from an existing ratified source:

  * `accumulator_sizing.compute_cycle_sizing` — ACCUMULATOR_MAINNET_PILOT_V0
    §13.2 / §13.5. Owns the capital baseline, the external wallet buffer, the
    inverse-leverage margin fraction and the position notional.
  * `pilot_sizing.pilot_leverage` — clamps leverage to `pilot.max_leverage`
    from `shared/mainnet_parity_constants.json`, the same block the TS broker
    translator reads.
  * `market_data.ApexPublicFeed.contract_config` — live venue rules from
    ApeX `/api/v3/symbols`: minOrderSize, stepSize, maxOrderSize. ApeX bounds
    order QUANTITY, not order value, so the minimum NOTIONAL is DERIVED
    (minOrderSize x price) exactly as documented there. No literal minimum is
    written in this file.

EVERY FAILURE IS A REFUSAL — inherited from accumulator_sizing's contract.
No branch returns a floor, a default, a clamped size, or a constant. If the
equity, the venue contract, or the price is not available and sane, the
caller gets a `SizingError` with a static code and places nothing. A guessed
size is a position the guards never sanctioned.

Pure: no network, no DB, no credentials, no side effects. The venue contract
dict and the equity figure are INPUTS, supplied by the caller.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import accumulator_sizing
import pilot_sizing
from accumulator_sizing import SizingError
from shared.parity_constants import get_decimal as _pc_decimal

CAMPAIGN_MARGIN_FRACTION = _pc_decimal(
    "orchestration", "campaign_margin_fraction_of_settled_wallet_balance"
)
CAMPAIGN_RUNG_COUNT = int(_pc_decimal("orchestration", "campaign_rung_count"))

# Venue contract keys required to quantize an order. Mirrors
# market_data.ApexPublicFeed._REQUIRED_CONTRACT_FIELDS for the subset this
# module needs; a missing or non-positive value is a refusal, never a default.
REQUIRED_CONTRACT_KEYS = ("minOrderSize", "stepSize", "maxOrderSize")


@dataclass(frozen=True)
class EntrySizePlan:
    """Everything the intent needs, plus the evidence for the audit trail."""
    symbol: str
    direction: str
    side: str                      # BUY / SELL — ApeX futures order side
    leverage: int
    entry_price: Decimal
    size: Decimal                  # quantized onto the venue step grid
    notional_usd: Decimal          # size x entry_price (post-quantization)
    margin_usd: Decimal            # notional / leverage
    target_notional_usd: Decimal   # pre-quantization, from the pilot spec
    cycle_capital_usd: Decimal
    min_order_size: Decimal
    step_size: Decimal
    rung_count: int = 1
    margin_per_rung_usd: Decimal = Decimal(0)


def _dec(value, code: str) -> Decimal:
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise SizingError(code)
    if not d.is_finite():
        raise SizingError(code)
    return d


def _floor_to_step(value: Decimal, step: Decimal) -> Decimal:
    """Quantize DOWN onto the step grid. Rounding UP would spend more margin
    than the pilot ledger authorized, so down is the only safe direction."""
    return (value // step) * step


def _venue_max_leverage(contract: dict):
    """Live venue leverage ceiling, or None when the venue did not publish one."""
    raw = contract.get("displayMaxLeverage")
    if raw is not None:
        lev = _dec(raw, "VENUE_LEVERAGE_INVALID")
        if lev > 0:
            return lev
    imr = contract.get("initialMarginRate")
    if imr is not None:
        rate = _dec(imr, "VENUE_LEVERAGE_INVALID")
        if rate > 0:
            return Decimal(1) / rate
    return None


def side_for_direction(direction: str) -> str:
    if direction == "long":
        return "BUY"
    if direction == "short":
        return "SELL"
    raise SizingError("DIRECTION_INVALID")


def plan_entry_size(
    *,
    available_equity_usd,
    symbol: str,
    direction: str,
    entry_price,
    contract: dict | None,
    requested_leverage=None,
    dynamic_wallet_campaign: bool = False,
) -> EntrySizePlan:
    """Canonical Accumulator entry size for ONE live intent.

    `contract` is the dict returned by ApexPublicFeed.contract_config(symbol).
    `available_equity_usd` is the account equity backing the cycle; None or
    unreadable is a refusal (BALANCE_UNAVAILABLE / BALANCE_UNREADABLE from
    accumulator_sizing), never an assumed balance.
    """
    side = side_for_direction(direction)

    price = _dec(entry_price, "ENTRY_PRICE_INVALID")
    if price <= 0:
        raise SizingError("ENTRY_PRICE_INVALID")

    if not isinstance(contract, dict):
        raise SizingError("VENUE_CONTRACT_UNAVAILABLE")
    for key in REQUIRED_CONTRACT_KEYS:
        if contract.get(key) is None:
            raise SizingError("VENUE_CONTRACT_INCOMPLETE")
    min_size = _dec(contract["minOrderSize"], "VENUE_CONTRACT_INVALID")
    step = _dec(contract["stepSize"], "VENUE_CONTRACT_INVALID")
    max_size = _dec(contract["maxOrderSize"], "VENUE_CONTRACT_INVALID")
    if min_size <= 0 or step <= 0 or max_size <= 0:
        raise SizingError("VENUE_CONTRACT_INVALID")

    # Venue leverage ceiling, taken from the LIVE contract when ApeX
    # publishes it. `displayMaxLeverage` is the venue's own figure;
    # `initialMarginRate` is its reciprocal and is used only as a derivation
    # when the display field is absent. Neither present -> the sizer falls
    # back to accumulator_sizing's static table and refuses on an unknown
    # symbol (SYMBOL_LEVERAGE_UNKNOWN). No ceiling is ever assumed.
    venue_max = _venue_max_leverage(contract)

    requested = (
        pilot_sizing.MAX_LEVERAGE if requested_leverage is None else requested_leverage
    )
    # CLAMP, do not refuse. The pilot ceiling and the venue ceiling are both
    # upper bounds; taking the lower of the two is the safe intersection.
    # Refusing whenever the pilot ceiling exceeded a 50x symbol is what
    # silently disqualified every non-BTC/ETH symbol from live dispatch.
    if venue_max is not None:
        requested = min(_dec(requested, "LEVERAGE_INVALID"), venue_max)
    leverage = pilot_sizing.pilot_leverage(requested)

    # ApeX has no minimum-notional field; it is DERIVED from the quantity
    # minimum at the sizing price. accumulator_sizing REQUIRES this input and
    # fails closed without it — that is why it is computed here from live
    # venue config rather than assumed.
    min_notional = min_size * price

    if dynamic_wallet_campaign:
        equity = _dec(available_equity_usd, "BALANCE_UNREADABLE")
        if equity <= 0:
            raise SizingError("BALANCE_ZERO_OR_NEGATIVE")
        target_margin = equity * CAMPAIGN_MARGIN_FRACTION
        target_notional = target_margin * Decimal(leverage)
        if target_notional < min_notional:
            raise SizingError("NOTIONAL_BELOW_VENUE_MINIMUM")
        cycle_capital = equity
        rung_count = CAMPAIGN_RUNG_COUNT
        margin_per_rung = target_margin / Decimal(rung_count)
    else:
        sizing = accumulator_sizing.compute_cycle_sizing(
            available_equity_usd,
            leverage=Decimal(leverage),
            symbol=symbol,
            min_notional_usd=min_notional,
            venue_max_leverage=venue_max,
        )
        target_margin = sizing.initial_margin_usd
        target_notional = sizing.position_notional_usd
        cycle_capital = sizing.cycle_capital_usd
        rung_count = 1
        margin_per_rung = target_margin

    raw_size = target_notional / price
    size = _floor_to_step(raw_size, step)
    if size <= 0:
        raise SizingError("SIZE_ROUNDS_TO_ZERO")
    if size < min_size:
        raise SizingError("SIZE_BELOW_VENUE_MINIMUM")
    if size > max_size:
        # Refuse rather than clamp: a clamped size silently changes the
        # position the pilot ledger was computed for.
        raise SizingError("SIZE_ABOVE_VENUE_MAXIMUM")

    notional = size * price
    return EntrySizePlan(
        symbol=symbol,
        direction=direction,
        side=side,
        leverage=leverage,
        entry_price=price,
        size=size,
        notional_usd=notional,
        margin_usd=notional / Decimal(leverage),
        target_notional_usd=target_notional,
        cycle_capital_usd=cycle_capital,
        min_order_size=min_size,
        step_size=step,
        rung_count=rung_count,
        margin_per_rung_usd=margin_per_rung,
    )
