"""ACCUMULATOR_MAINNET_PILOT_V0 — cycle sizing. PILOT SCOPE, NOT GLOBAL SPEC.

RATIFIED SOURCES
----------------
§13.2  margin_fraction = 10 / leverage        (CORRECTED 0.17.1; 20/leverage is SUPERSEDED)
       initial_margin  = capital_baseline × margin_fraction
       position_notional = initial_margin × leverage = capital_baseline × 10
§13.3  max_slippage_bps_per_side = 25
§13.5  $500/100x -> $100 floor + $50 reserve + $50 margin + $25 slip + $10 fees = $235
       $300/100x -> $60 + $30 + $30 + $15 + $6 = $141
§13.6  Resize sufficiency — the VETO. Takes a proposed margin; never produces one.
v1 `capital.max_usd = 500` · `sizing.cap: position_margin <= account_capital`

OWNER RULING — ACCUMULATOR_MAINNET_PILOT_V0 (2026-07-17)
--------------------------------------------------------
An exhaustive search of the specification found NO resize-margin equation.
§13.6 consumes `proposed resize margin` as an INPUT and never defines it;
v1 `## resize` fixes direction/gating only; §13.2 is scoped to the INITIAL
entry. The owner therefore ruled, FOR THIS PILOT ONLY:

    resize_margin_usd = initial_margin_usd = capital_baseline × (10 / leverage)

CONSTANT-MARGIN. Not an equal split of remaining capital. Not geometric. There
is no predefined rung-count ceiling: resizing terminates when a §13.6 guard
vetoes, not at a constant. Unused capital REMAINS UNUSED — the bot is not
required to exhaust the cap.

This is pilot scope. It contradicts `v1 ## sizing`'s `margin_fraction_formula:
20 / leverage`, which §13.2 supersedes but which still sits in the doc. Do not
promote this rule to global spec without an owner ratification.

WHY Decimal
-----------
Float would drift on the floor/reserve boundary, and the boundary is exactly
where a guard must be exact. A rung permitted by 1e-9 of float error is a rung
the owner never authorized.

EVERY FAILURE IS A REFUSAL
--------------------------
No branch returns a smaller size, a clamped size, or a default. Sizing that
cannot be proven safe does not happen. A clamped position is a position the
guards did not sanction.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from decimal import ROUND_DOWN
from typing import Optional

PILOT_SCOPE = "ACCUMULATOR_MAINNET_PILOT_V0"

CAPITAL_MAX_USD = Decimal("500")          # v1 capital.max_usd

# --- Pilot funding rule (owner, 2026-07-17) -------------------------------
# The wallet is funded to $600. $100 of that NEVER enters the strategy.
#
#     deployable_cycle_capital = min(max(available_equity - 100, 0), 500)
#
# BEWARE A COINCIDENCE THAT WILL MISLEAD YOU: at a $600 balance the EXTERNAL
# buffer ($100) and the INTERNAL equity floor (20% of a $500 baseline = $100)
# are the same number. They are NOT the same pool and they are not related:
#   * EXTERNAL buffer  — subtracted BEFORE the baseline exists. Never sizes a
#     rung, never counts as profit, never consumed by a resize, never risk
#     capital. It is not the strategy's money.
#   * INTERNAL floor   — 20% OF the baseline, inside the strategy, enforced by
#     §13.6 on every resize.
# At any other balance they diverge ($500 balance -> $400 baseline -> $80
# floor, buffer still $100). Do not collapse them.
WALLET_TARGET_USD = Decimal("600")
EXTERNAL_WALLET_BUFFER_USD = Decimal("100")
INVERSE_LEVERAGE_MARGIN_NUMERATOR = Decimal("10")   # §13.2 (was 20 — superseded)
EQUITY_FLOOR_FRACTION = Decimal("0.20")   # §13.5
OPERATIONAL_RESERVE_FRACTION = Decimal("0.10")      # §13.5
MAX_SLIPPAGE_BPS_PER_SIDE = Decimal("25")           # §13.3
FEE_BPS_PER_SIDE_CEILING = Decimal("10")            # §13.5 ceiling; real rate must be fetched
SIDES_ROUND_TRIP = Decimal("2")

# ApeX /api/v3/symbols, retrieved 2026-07-16. 200x/300x/400x/500x DO NOT EXIST.
VENUE_MAX_LEVERAGE = {"BTC-USDT": Decimal("100"), "ETH-USDT": Decimal("100"),
                      "SOL-USDT": Decimal("50"), "XRP-USDT": Decimal("50"),
                      "ARB-USDT": Decimal("50")}


class SizingError(Exception):
    """Fail-closed. `code` is static; carries no balance or price material."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _dec(v, code: str) -> Decimal:
    try:
        return Decimal(str(v))
    except (InvalidOperation, TypeError, ValueError):
        raise SizingError(code)


@dataclass(frozen=True)
class CycleSizing:
    scope: str
    available_equity_usd: Decimal
    external_wallet_buffer_usd: Decimal      # NOT strategy capital. Never sized.
    cycle_capital_usd: Decimal
    leverage: Decimal
    margin_fraction: Decimal
    initial_margin_usd: Decimal
    resize_margin_usd: Decimal
    position_notional_usd: Decimal
    equity_floor_usd: Decimal
    operational_reserve_usd: Decimal
    max_slippage_usd: Decimal
    max_fees_usd: Decimal
    total_required_cycle_equity_usd: Decimal


def resolve_cycle_capital(available_equity_usd, cap_usd: Decimal = CAPITAL_MAX_USD,
                          buffer_usd: Decimal = EXTERNAL_WALLET_BUFFER_USD) -> Decimal:
    """deployable_cycle_capital = min(max(available_equity - 100, 0), 500).

    The external buffer comes off the TOP, before any baseline exists, so it
    can never inflate the baseline, a rung, or the reserve. Between $100 and
    $600 the baseline SHRINKS and every downstream figure (floor, reserve,
    margin, fees, slippage) recomputes from the reduced baseline — they are
    all fractions of it, so this happens automatically rather than by a second
    code path that could drift.
    """
    if available_equity_usd is None:
        raise SizingError("BALANCE_UNAVAILABLE")
    eq = _dec(available_equity_usd, "BALANCE_UNREADABLE")
    if eq <= 0:
        raise SizingError("BALANCE_ZERO_OR_NEGATIVE")
    # Owner rule: fail closed at or below the buffer. At exactly $100 the
    # deployable capital is $0 — that is not a tiny cycle, it is no cycle, and
    # returning 0 would let every fraction compute cleanly to zero and look
    # like a valid plan.
    if eq <= buffer_usd:
        raise SizingError("EQUITY_AT_OR_BELOW_EXTERNAL_BUFFER")
    deployable = max(eq - buffer_usd, Decimal(0))
    return min(deployable, cap_usd)


def resolve_venue_max_leverage(symbol: str, venue_max_leverage=None) -> Decimal:
    """Authoritative venue leverage ceiling for `symbol`.

    `venue_max_leverage`, when supplied, comes from LIVE venue metadata
    (ApeX /api/v3/symbols) and always wins — the static table below is only
    a last-resort fallback for the handful of symbols captured on
    2026-07-16. A symbol absent from BOTH is still a refusal: guessing a
    ceiling is how an unsupported leverage reaches the venue.
    """
    if venue_max_leverage is not None:
        vm = _dec(venue_max_leverage, "VENUE_LEVERAGE_INVALID")
        if vm <= 0:
            raise SizingError("VENUE_LEVERAGE_INVALID")
        return vm
    vm = VENUE_MAX_LEVERAGE.get(symbol)
    if vm is None:
        raise SizingError("SYMBOL_LEVERAGE_UNKNOWN")
    return vm


def verify_leverage_supported(symbol: str, leverage: Decimal,
                              venue_max_leverage=None) -> None:
    """The most restrictive venue/account/user/strategy limit always wins (§13.2)."""
    if leverage <= 0:
        raise SizingError("LEVERAGE_NOT_POSITIVE")
    if leverage > resolve_venue_max_leverage(symbol, venue_max_leverage):
        raise SizingError("LEVERAGE_UNSUPPORTED_BY_VENUE")


def compute_cycle_sizing(available_equity_usd, leverage=Decimal("100"),
                         symbol: str = "BTC-USDT",
                         min_notional_usd=None,
                         venue_max_leverage=None) -> CycleSizing:
    """§13.2 + §13.5. Deterministic; no venue call, no side effects."""
    lev = _dec(leverage, "LEVERAGE_INVALID")
    verify_leverage_supported(symbol, lev, venue_max_leverage)
    cap = resolve_cycle_capital(available_equity_usd)

    margin_fraction = INVERSE_LEVERAGE_MARGIN_NUMERATOR / lev     # §13.2
    initial_margin = cap * margin_fraction
    notional = initial_margin * lev                                # == cap × 10
    floor = cap * EQUITY_FLOOR_FRACTION
    reserve = cap * OPERATIONAL_RESERVE_FRACTION
    slippage = notional * (MAX_SLIPPAGE_BPS_PER_SIDE / Decimal("10000")) * SIDES_ROUND_TRIP
    fees = notional * (FEE_BPS_PER_SIDE_CEILING / Decimal("10000")) * SIDES_ROUND_TRIP
    total = floor + reserve + initial_margin + slippage + fees

    # v1 sizing.cap — an existing ratified guard, enforced alongside §13.6.
    if initial_margin > cap:
        raise SizingError("MARGIN_EXCEEDS_ACCOUNT_CAPITAL")

    # §13.5's ledger is STRUCTURALLY ALWAYS-PASS and this is not a bug:
    #     total = cap × (0.20 + 0.10 + 0.10 + 0.05 + 0.02) = cap × 0.47
    # Every component is a fraction of the baseline, so the ratio is constant
    # at 47% ($235/$500, $141/$300) and `total > cap` can never fire. That is
    # §13.5.1's stated scale-invariance working as designed. The check is kept
    # because it is the ratified guard and a future non-proportional component
    # (a flat venue fee, a fixed reserve) WOULD make it bind.
    if total > cap:
        raise SizingError("INSUFFICIENT_CYCLE_EQUITY")

    # THE REAL FLOOR IS THE VENUE, NOT THE RATIO. Because the ledger scales,
    # a $10 baseline "passes" while sizing a $100 notional that ApeX would
    # reject outright. The binding constraint is minimum order size / step
    # size from /api/v3/symbols. It is NOT hard-coded here: inventing a
    # minimum would be exactly the MAX_LIMIT=1500 error again. `min_notional`
    # must be supplied by the caller from live venue config; when it is
    # absent we FAIL CLOSED rather than assume the order is placeable.
    if min_notional_usd is None:
        raise SizingError("VENUE_MIN_NOTIONAL_UNAVAILABLE")
    if notional < _dec(min_notional_usd, "VENUE_MIN_NOTIONAL_INVALID"):
        raise SizingError("NOTIONAL_BELOW_VENUE_MINIMUM")

    return CycleSizing(
        scope=PILOT_SCOPE,
        available_equity_usd=_dec(available_equity_usd, "BALANCE_UNREADABLE"),
        external_wallet_buffer_usd=EXTERNAL_WALLET_BUFFER_USD,
        cycle_capital_usd=cap, leverage=lev,
        margin_fraction=margin_fraction, initial_margin_usd=initial_margin,
        resize_margin_usd=initial_margin,          # OWNER RULING: constant-margin
        position_notional_usd=notional, equity_floor_usd=floor,
        operational_reserve_usd=reserve, max_slippage_usd=slippage,
        max_fees_usd=fees, total_required_cycle_equity_usd=total,
    )


@dataclass(frozen=True)
class ResizeDecision:
    permitted: bool
    reason_code: str
    proposed_margin_usd: Decimal
    post_resize_free_equity_usd: Decimal


def evaluate_resize(
    *,
    sizing: CycleSizing,
    current_equity_usd,
    existing_exposure_notional_usd,
    existing_margin_committed_usd,
    fee_rate_bps_per_side,
    has_newly_eligible_entry: bool,
    liquidation_buffer_ok: bool,
) -> ResizeDecision:
    """§13.6 pre-resize sufficiency. THE VETO — it never proposes an amount.

    Recalculates, per §13.6, before EVERY resize: current equity · fixed equity
    floor · fixed operational reserve · proposed resize margin · resize-entry
    fee · eventual-exit fee on the added notional · entry slippage · exit
    slippage · exposure after resize · liquidation buffer · all limits.

    Permitted ONLY if every post-resize guard holds. Otherwise resizing stops
    and the remaining capital simply goes unused.
    """
    # A resize with no NEW confirmation would rebuild rungs from history — the
    # exact failure entry_eligibility exists to prevent. Checked first: it is
    # free and it is the most dangerous branch.
    if not has_newly_eligible_entry:
        return ResizeDecision(False, "NO_NEWLY_ELIGIBLE_ENTRY", Decimal(0), Decimal(0))

    if fee_rate_bps_per_side is None:
        # §13.5: "Do not claim the cycle passes without retrieving and applying
        # the actual authenticated fee rate."
        return ResizeDecision(False, "FEE_RATE_UNAVAILABLE", Decimal(0), Decimal(0))
    if not liquidation_buffer_ok:
        return ResizeDecision(False, "LIQUIDATION_BUFFER_FAIL", Decimal(0), Decimal(0))

    try:
        eq = _dec(current_equity_usd, "EQUITY_UNREADABLE")
        exposure = _dec(existing_exposure_notional_usd, "EXPOSURE_UNREADABLE")
        committed = _dec(existing_margin_committed_usd, "MARGIN_UNREADABLE")
        fee_bps = _dec(fee_rate_bps_per_side, "FEE_RATE_INVALID")
    except SizingError as e:
        return ResizeDecision(False, e.code, Decimal(0), Decimal(0))

    if eq <= 0:
        return ResizeDecision(False, "BALANCE_ZERO_OR_NEGATIVE", Decimal(0), Decimal(0))

    proposed = sizing.resize_margin_usd                 # constant-margin, $50
    added_notional = proposed * sizing.leverage
    entry_fee = added_notional * (fee_bps / Decimal("10000"))
    exit_fee = added_notional * (fee_bps / Decimal("10000"))
    entry_slip = added_notional * (MAX_SLIPPAGE_BPS_PER_SIDE / Decimal("10000"))
    exit_slip = added_notional * (MAX_SLIPPAGE_BPS_PER_SIDE / Decimal("10000"))

    required = (sizing.equity_floor_usd + sizing.operational_reserve_usd
                + committed + proposed + entry_fee + exit_fee + entry_slip + exit_slip)
    free = eq - required

    if committed + proposed > sizing.cycle_capital_usd:
        return ResizeDecision(False, "MARGIN_EXCEEDS_ACCOUNT_CAPITAL", proposed, free)
    # The external buffer is not risk capital and must never be consumed by a
    # resize. Guarded explicitly rather than relying on the baseline having
    # already excluded it — defence in depth on the one pool that is not ours.
    if eq - required < sizing.external_wallet_buffer_usd:
        return ResizeDecision(False, "WOULD_CONSUME_EXTERNAL_BUFFER", proposed, free)
    if required > eq:
        return ResizeDecision(False, "INSUFFICIENT_POST_RESIZE_EQUITY", proposed, free)
    if eq - required < 0:
        return ResizeDecision(False, "FLOOR_OR_RESERVE_BREACH", proposed, free)
    _ = exposure + added_notional   # recalculated per §13.6; no ceiling ruled
    return ResizeDecision(True, "PERMITTED", proposed, free)


# ===========================================================================
# Quantity sizing against VERIFIED ApeX contract bounds.
#
# Live BTC-USDT probe, 2026-07-17:
#   minOrderSize 0.0010 · stepSize 0.001 · tickSize 0.1
#   maxOrderSize 50 · maxPositionSize 225 · maxPositionValue 15000000
#
# THERE IS NO MINIMUM-NOTIONAL FIELD. ApeX bounds QUANTITY. Any "minimum
# notional" is DERIVED (minOrderSize x price) for display/validation only.
# ===========================================================================
CONTRACT_FIELDS = ("minOrderSize", "stepSize", "tickSize",
                   "maxOrderSize", "maxPositionSize", "maxPositionValue")


@dataclass(frozen=True)
class QuantitySizing:
    quantity: Decimal
    notional_usd: Decimal          # quantity x price AFTER rounding down
    price: Decimal
    min_notional_display_usd: Decimal   # DERIVED: minOrderSize x price
    rounded_down_from: Decimal


def _contract(cfg: dict) -> dict:
    if not isinstance(cfg, dict):
        raise SizingError("CONTRACT_CONFIG_UNAVAILABLE")
    out = {}
    for f in CONTRACT_FIELDS:
        if cfg.get(f) is None:
            raise SizingError(f"CONTRACT_FIELD_MISSING_{f}")
        v = _dec(cfg[f], f"CONTRACT_FIELD_INVALID_{f}")
        if v <= 0:
            raise SizingError(f"CONTRACT_FIELD_INVALID_{f}")
        out[f] = v
    return out


def size_quantity(*, proposed_notional_usd, price, contract_cfg: dict,
                  existing_position_qty=Decimal(0)) -> QuantitySizing:
    """proposed notional -> venue-legal quantity, or refuse.

    Rounds DOWN to stepSize so sizing can NEVER exceed the capital cap —
    rounding up would spend money the guards did not authorize.
    """
    c = _contract(contract_cfg)
    px = _dec(price, "PRICE_INVALID")
    if px <= 0:
        raise SizingError("PRICE_NOT_POSITIVE")
    notional = _dec(proposed_notional_usd, "NOTIONAL_INVALID")
    if notional <= 0:
        raise SizingError("NOTIONAL_NOT_POSITIVE")

    raw_qty = notional / px
    step = c["stepSize"]
    qty = (raw_qty / step).to_integral_value(rounding=ROUND_DOWN) * step   # DOWN, always

    if qty < c["minOrderSize"]:
        raise SizingError("QUANTITY_BELOW_MIN_ORDER_SIZE")
    if qty > c["maxOrderSize"]:
        raise SizingError("QUANTITY_ABOVE_MAX_ORDER_SIZE")

    total_qty = _dec(existing_position_qty, "POSITION_QTY_INVALID") + qty
    if total_qty > c["maxPositionSize"]:
        raise SizingError("POSITION_ABOVE_MAX_POSITION_SIZE")
    if total_qty * px > c["maxPositionValue"]:
        raise SizingError("POSITION_ABOVE_MAX_POSITION_VALUE")

    return QuantitySizing(
        quantity=qty, notional_usd=qty * px, price=px,
        min_notional_display_usd=c["minOrderSize"] * px,   # DERIVED, display only
        rounded_down_from=raw_qty,
    )
