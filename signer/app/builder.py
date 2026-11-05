"""BUILD_ORDER — deterministic pre-signing sizing.

Pure computation. No I/O, no signing, no secrets. Given the mark price and
the perpetual contract config, produces the exact order parameters that
`SIGN_ORDER` and `CREATE_ORDER` will consume unchanged.

Sizing reads target MARGIN from `ladder.dca_total_margin_usd` and account
bounds (`pilot.allocation_ceiling_usd`, `pilot.allocation_reserve_floor_usd`)
from the pilot block in shared/mainnet_parity_constants.json via
`shared/parity_constants.py`. Notional is derived: notional = margin ×
leverage. Leverage is capital efficiency, not a risk knob; the account is
cross-margin and all positions share one collateral pool.

This module holds NO sizing literals of its own for any field defined in
shared/mainnet_parity_constants.json.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from typing import Literal

from shared.parity_constants import get_decimal as _pget


# Sizing inputs — sourced from shared/mainnet_parity_constants.json.
STRATEGY_CAP_USD = _pget("pilot", "allocation_ceiling_usd")
# Re-exported for execution.py::preflight (equity floor gate). Not consumed
# inside builder.py — the sizing path uses ladder.dca_total_margin_usd.
# Kept here as a single import surface for the sizing/exec money path.
ACCOUNT_FLOOR_USD = _pget("pilot", "allocation_reserve_floor_usd")
DEFAULT_SLIPPAGE_BPS = 50  # 0.50% cap on protected price

# Post-rounding notional must not drift more than 1% from target, else refuse.
NOTIONAL_ROUNDING_TOLERANCE = Decimal("0.01")



class BuildError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class BuildInput:
    symbol: str
    side: Literal["BUY", "SELL"]
    mark_price: str
    leverage: int
    # DEPRECATED: retained for API compatibility with existing callers.
    # Ignored for sizing — target margin is read from
    # ladder.dca_total_margin_usd in shared/mainnet_parity_constants.json
    # unless margin_override_usd is set (manual ladder path).
    capital_baseline_usd: str
    tick_size: str
    step_size: str
    decimals: int
    l2_pair_id: int
    taker_fee_rate: str
    maker_fee_rate: str
    slippage_bps: int = DEFAULT_SLIPPAGE_BPS
    # Explicit order type. Defaults to MARKET so every existing single-order
    # caller keeps byte-identical behavior. LIMIT is used only by the manual
    # ladder deploy path.
    order_type: Literal["MARKET", "LIMIT"] = "MARKET"
    # LIMIT rung price — required when order_type == "LIMIT". Rounded to
    # tick with BUY -> DOWN and SELL -> UP so a resting rung is never
    # placed at a WORSE price than requested.
    limit_price: str | None = None
    # AUTHORITATIVE SIZE from the caller's intent (strategy bridge path).
    # When set, the signer does NOT recompute size: it quantizes this value
    # DOWN onto the venue step grid and uses it verbatim. The resulting
    # margin is checked immediately before signing against authenticated free
    # collateral. Automated campaigns have no application-level dollar cap:
    # the worker owns the 5%-of-current-wallet rule and this builder only
    # quantizes the authorized size downward to the venue grid.
    size_override: str | None = None
    # Per-rung margin override for the manual ladder planner. When set,
    # this value is used as the target margin instead of the ladder total.
    # Every automated (single-order) caller leaves this None.
    margin_override_usd: str | None = None



@dataclass(frozen=True)
class BuiltOrder:
    symbol: str
    side: str
    order_type: str  # MARKET or LIMIT
    size: str
    # MARKET: worst-acceptable protected price (slippage-capped).
    # LIMIT:  the tick-rounded rung price itself.
    protected_price: str
    mark_price: str
    notional_usd: str
    margin_usd: str
    leverage: int
    l2_pair_id: int
    decimals: int
    taker_fee_rate: str
    maker_fee_rate: str
    slippage_bps: int


def _q(x: str) -> Decimal:
    d = Decimal(str(x))
    if not d.is_finite():
        raise BuildError("BAD_NUMBER")
    return d


def _round_down_to_step(value: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        raise BuildError("BAD_STEP_SIZE")
    return (value / step).quantize(Decimal(1), rounding=ROUND_DOWN) * step


def _round_up_to_step(value: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        raise BuildError("BAD_STEP_SIZE")
    return (value / step).quantize(Decimal(1), rounding=ROUND_UP) * step


def _round_nearest_to_step(value: Decimal, step: Decimal) -> Decimal:
    """Round to the nearest multiple of step (ties go down)."""
    if step <= 0:
        raise BuildError("BAD_STEP_SIZE")
    down = _round_down_to_step(value, step)
    up = down + step
    return up if (value - down) > (up - value) else down


def round_price_to_tick(price: str | Decimal, tick: str | Decimal, direction: str) -> str:
    """Quantize `price` onto the venue's price tick grid.

    `direction` MUST be "UP" or "DOWN". The caller picks the safe side:
      - entry protected price:  BUY -> UP, SELL -> DOWN (worst-acceptable
        fill is only made stricter, never looser).
      - protective STOP:        rounds TOWARD MARK (never loosen the stop).
          BUY position's stop sits below mark  -> UP.
          SELL position's stop sits above mark -> DOWN.
      - take-profit LIMIT:      rounds TOWARD MARK (easier to fill, no
        loosening of the profit target).
          BUY position's TP sits above mark    -> DOWN.
          SELL position's TP sits below mark   -> UP.

    Returns a normalized string. Never returns a value that violates
    tickSize.
    """
    if direction not in ("UP", "DOWN"):
        raise BuildError("BAD_ROUND_DIRECTION")
    p = _q(str(price))
    t = _q(str(tick))
    q = _round_up_to_step(p, t) if direction == "UP" else _round_down_to_step(p, t)
    if q <= 0:
        raise BuildError("ROUNDED_PRICE_INVALID")
    return format(q.normalize(), "f")


def round_size_to_step(size: str | Decimal, step: str | Decimal) -> str:
    """Quantize `size` onto the venue's stepSize grid (ROUND_DOWN — never
    submit more than requested)."""
    s = _q(str(size))
    st = _q(str(step))
    q = _round_down_to_step(s, st)
    if q < 0:
        raise BuildError("ROUNDED_SIZE_INVALID")
    return format(q.normalize(), "f")



def build_order(inp: BuildInput) -> BuiltOrder:
    if inp.side not in ("BUY", "SELL"):
        raise BuildError("BAD_SIDE")
    if inp.leverage <= 0 or inp.leverage > 100:
        raise BuildError("BAD_LEVERAGE")
    if inp.order_type not in ("MARKET", "LIMIT"):
        raise BuildError("BAD_ORDER_TYPE")
    if inp.order_type == "LIMIT" and (inp.limit_price is None or str(inp.limit_price).strip() == ""):
        raise BuildError("LIMIT_PRICE_REQUIRED")

    # capital_baseline_usd is deprecated and ignored.
    # margin_override_usd (manual ladder path) takes precedence over the
    # shared ladder total, else read ladder.dca_total_margin_usd.
    if inp.margin_override_usd is not None:
        target_margin = _q(inp.margin_override_usd)
        if target_margin <= 0:
            raise BuildError("BAD_MARGIN_OVERRIDE")
    else:
        target_margin = _pget("ladder", "dca_total_margin_usd")
    if target_margin > STRATEGY_CAP_USD:
        raise BuildError("STRATEGY_CAP_EXCEEDED")

    target_notional = target_margin * Decimal(inp.leverage)

    price = _q(inp.mark_price)
    if price <= 0:
        raise BuildError("BAD_MARK_PRICE")

    # SIZING BASIS: for MARKET, size is derived from mark_price. For LIMIT,
    # size is derived from the RUNG limit price so per-rung margin matches
    # exactly at that fill price (a rung is only ever filled at its limit).
    tick = _q(inp.tick_size)
    if inp.order_type == "LIMIT":
        # Round rung limit to tick: BUY DOWN (resting buy sits below mark;
        # never round UP into a worse price), SELL UP.
        limit_dir = "DOWN" if inp.side == "BUY" else "UP"
        limit_rounded_str = round_price_to_tick(str(inp.limit_price), inp.tick_size, limit_dir)
        limit_rounded = _q(limit_rounded_str)
        if limit_rounded <= 0:
            raise BuildError("LIMIT_PRICE_INVALID")
        sizing_price = limit_rounded
    else:
        sizing_price = price

    step = _q(inp.step_size)
    if inp.size_override is not None:
        # AUTHORITATIVE SIZE PATH — no recomputation. Quantize down only.
        requested = _q(inp.size_override)
        if requested <= 0:
            raise BuildError("BAD_SIZE_OVERRIDE")
        size = _round_down_to_step(requested, step)
        if size <= 0:
            raise BuildError("SIZE_TOO_SMALL")
        actual_notional = size * sizing_price
        if actual_notional == 0:
            raise BuildError("NOTIONAL_ZERO")
        return _finalize_build(inp, price, tick, sizing_price, size, actual_notional)

    raw_size = target_notional / sizing_price
    # MARKET: nearest-step (byte-identical to prior behavior — do not touch).
    # LIMIT:  round DOWN. A resting rung must land at or under its target
    # margin, never over; overspend on a rounded-up rung compounds across N
    # rungs and can push the ladder above its ratified total_margin cap.
    if inp.order_type == "LIMIT":
        size = _round_down_to_step(raw_size, step)
    else:
        size = _round_nearest_to_step(raw_size, step)
    if size <= 0:
        raise BuildError("SIZE_TOO_SMALL")

    actual_notional = size * sizing_price
    if actual_notional == 0:
        raise BuildError("NOTIONAL_ZERO")
    step_notional = step * sizing_price
    unavoidable = step_notional / target_notional
    tolerance = max(NOTIONAL_ROUNDING_TOLERANCE, unavoidable)
    drift = abs(actual_notional - target_notional) / target_notional
    if drift > tolerance:
        raise BuildError("NOTIONAL_ROUND_ERROR")

    return _finalize_build(inp, price, tick, sizing_price, size, actual_notional)


def _finalize_build(inp: BuildInput, price: Decimal, tick: Decimal,
                    sizing_price: Decimal, size: Decimal,
                    actual_notional: Decimal) -> BuiltOrder:
    """Shared protected-price + BuiltOrder assembly for every sizing path."""
    if inp.order_type == "MARKET":
        # Protected price — worst acceptable fill.
        slip = Decimal(inp.slippage_bps) / Decimal(10000)
        if inp.side == "BUY":
            protected = price * (Decimal(1) + slip)
            protected = _round_up_to_step(protected, tick)
        else:
            protected = price * (Decimal(1) - slip)
            protected = _round_down_to_step(protected, tick)
        if protected <= 0:
            raise BuildError("PROTECTED_PRICE_INVALID")
        protected_out = protected
    else:
        # LIMIT: the "protected_price" slot carries the rung limit itself.
        protected_out = sizing_price

    return BuiltOrder(
        symbol=inp.symbol,
        side=inp.side,
        order_type=inp.order_type,
        size=format(size.normalize(), "f"),
        protected_price=format(protected_out.normalize(), "f"),
        mark_price=format(price.normalize(), "f"),
        notional_usd=format(actual_notional.normalize(), "f"),
        margin_usd=format((actual_notional / Decimal(inp.leverage)).normalize(), "f"),
        leverage=inp.leverage,
        l2_pair_id=inp.l2_pair_id,
        decimals=inp.decimals,
        taker_fee_rate=inp.taker_fee_rate,
        maker_fee_rate=inp.maker_fee_rate,
        slippage_bps=inp.slippage_bps,
    )


# ---------------------------------------------------------------------------
# Manual ladder planner (owner-only Deploy Formation path).
#
# CRITICAL SAFETY REQUIREMENT (owner ruling): total ladder margin equals
# `ladder.dca_total_margin_usd` (60). Per-rung margin = total / rungs, with
# rounding remainder carried on the LAST rung so the sum equals total
# EXACTLY and NEVER exceeds it. A hard assertion refuses to plan a ladder
# whose per-rung margins sum above the total.
#
# Geometry mirrors the paper accumulator: rung 1 at mark; rungs 2..N step
# AGAINST the position; deepest rung sits ladder_span_pct(leverage) away
# from rung 1 where span = min(ladder_span_pct_cap, ladder_span_roi / lev).
# The hard stop sits `hard_stop_beyond_last_rung_pct` beyond the deepest
# rung, on the losing side of the position.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LadderRungPlan:
    index: int              # 1-based
    limit_price: str
    size: str
    margin_usd: str
    notional_usd: str
    built: BuiltOrder


@dataclass(frozen=True)
class LadderPlan:
    symbol: str
    side: str
    leverage: int
    rungs: tuple[LadderRungPlan, ...]
    total_margin_usd: str
    total_notional_usd: str
    hard_stop_price: str
    hard_stop_side: str      # SELL for a BUY ladder, BUY for a SELL ladder


def _ladder_span_pct(leverage: int) -> Decimal:
    span_roi = _pget("ladder", "ladder_span_roi")
    cap = _pget("ladder", "ladder_span_pct_cap")
    raw = span_roi / Decimal(leverage)
    return raw if raw < cap else cap


def build_ladder_plan(
    *,
    symbol: str,
    side: Literal["BUY", "SELL"],
    mark_price: str,
    leverage: int,
    tick_size: str,
    step_size: str,
    decimals: int,
    l2_pair_id: int,
    taker_fee_rate: str,
    maker_fee_rate: str,
    rungs: int | None = None,
    slippage_bps: int = DEFAULT_SLIPPAGE_BPS,
) -> LadderPlan:
    if side not in ("BUY", "SELL"):
        raise BuildError("BAD_SIDE")
    if leverage <= 0 or leverage > 100:
        raise BuildError("BAD_LEVERAGE")

    rungs_min = int(_pget("ladder", "dca_rungs_min"))
    rungs_max = int(_pget("ladder", "dca_rungs_max"))
    rungs_default = int(_pget("ladder", "dca_rungs_default"))
    n = int(rungs) if rungs is not None else rungs_default
    if n < rungs_min: n = rungs_min
    if n > rungs_max: n = rungs_max

    total_margin = _pget("ladder", "dca_total_margin_usd")
    # Per-rung margin, remainder carried on the LAST rung so the sum of
    # INTENDED margins equals total_margin EXACTLY. Actual committed margin
    # (after rung SIZE round-down at the venue step) may be strictly less
    # than intended — that under-fill is acceptable; overspend is not.
    q = Decimal("0.00000001")
    per_rung = (total_margin / Decimal(n)).quantize(q, rounding=ROUND_DOWN)
    remainder = total_margin - per_rung * Decimal(n - 1) - per_rung
    last_rung_margin = per_rung + remainder

    # INTENDED-margin arithmetic check. This validates the split (per_rung +
    # remainder onto rung N) sums to the target — it does NOT guard against
    # actual overspend from step-rounded rung sizes; that check runs below
    # against built.notional_usd. Named MISMATCH to distinguish it in logs
    # from the actual OVERSPEND guard.
    rung_margins = [per_rung] * (n - 1) + [last_rung_margin]
    total_intended = sum(rung_margins)
    if total_intended != total_margin:
        raise BuildError("LADDER_MARGIN_MISMATCH")

    # Rung geometry — evenly spaced from mark to ladder floor.
    price = _q(mark_price)
    if price <= 0:
        raise BuildError("BAD_MARK_PRICE")
    span = _ladder_span_pct(leverage)
    denom = Decimal(n - 1) if n > 1 else Decimal(1)

    rung_plans: list[LadderRungPlan] = []
    actual_total_notional = Decimal(0)
    actual_total_margin = Decimal(0)
    last_rung_price: Decimal | None = None
    for i in range(n):
        frac = (Decimal(i) / denom) * span if n > 1 else Decimal(0)
        rung_px = price * (Decimal(1) - frac) if side == "BUY" else price * (Decimal(1) + frac)
        if rung_px <= 0:
            raise BuildError("RUNG_PRICE_INVALID")
        rung_margin = rung_margins[i]
        built = build_order(BuildInput(
            symbol=symbol, side=side, mark_price=mark_price, leverage=leverage,
            capital_baseline_usd="0", tick_size=tick_size, step_size=step_size,
            decimals=decimals, l2_pair_id=l2_pair_id,
            taker_fee_rate=taker_fee_rate, maker_fee_rate=maker_fee_rate,
            slippage_bps=slippage_bps, order_type="LIMIT",
            limit_price=format(rung_px.normalize(), "f"),
            margin_override_usd=format(rung_margin.normalize(), "f"),
        ))
        actual_rung_notional = Decimal(built.notional_usd)
        actual_rung_margin = actual_rung_notional / Decimal(leverage)
        actual_total_notional += actual_rung_notional
        actual_total_margin += actual_rung_margin
        last_rung_price = _q(built.protected_price)  # tick-rounded rung price
        rung_plans.append(LadderRungPlan(
            index=i + 1,
            limit_price=built.protected_price,
            size=built.size,
            # margin_usd on the rung = ACTUAL committed margin at that rung's
            # limit price and step-rounded size. The intended per-rung value
            # is recoverable from total_margin / n but the owner must see
            # what is really committed, not what was requested.
            margin_usd=format(actual_rung_margin.normalize(), "f"),
            notional_usd=built.notional_usd,
            built=built,
        ))

    # ACTUAL OVERSPEND GUARD — the load-bearing safety check. Uses the
    # post-rounding notionals returned by build_order(); the intended-margin
    # check above cannot detect step-rounding overspend.
    if actual_total_margin > total_margin:
        raise BuildError("LADDER_OVERSPEND")

    # Hard stop: `hard_stop_beyond_last_rung_pct` beyond the deepest rung on
    # the losing side (BUY ladder -> stop BELOW, SELL ladder -> stop ABOVE).
    assert last_rung_price is not None
    stop_pct = _pget("ladder", "hard_stop_beyond_last_rung_pct")
    tick = _q(tick_size)
    if side == "BUY":
        stop_raw = last_rung_price * (Decimal(1) - stop_pct)
        stop_px = _round_down_to_step(stop_raw, tick)
        stop_side = "SELL"
    else:
        stop_raw = last_rung_price * (Decimal(1) + stop_pct)
        stop_px = _round_up_to_step(stop_raw, tick)
        stop_side = "BUY"
    if stop_px <= 0:
        raise BuildError("HARD_STOP_INVALID")

    return LadderPlan(
        symbol=symbol,
        side=side,
        leverage=leverage,
        rungs=tuple(rung_plans),
        # ACTUAL committed totals, not intended. See LadderRungPlan.margin_usd.
        total_margin_usd=format(actual_total_margin.normalize(), "f"),
        total_notional_usd=format(actual_total_notional.normalize(), "f"),
        hard_stop_price=format(stop_px.normalize(), "f"),
        hard_stop_side=stop_side,
    )


def build_wallet_campaign_plan(
    *,
    symbol: str,
    side: Literal["BUY", "SELL"],
    mark_price: str,
    leverage: int,
    tick_size: str,
    step_size: str,
    min_order_size: str,
    max_order_size: str,
    venue_max_leverage: int,
    settled_wallet_balance_usd: str,
    available_collateral_usd: str,
    decimals: int,
    l2_pair_id: int,
    taker_fee_rate: str,
    maker_fee_rate: str,
) -> LadderPlan:
    """Plan five real, individually valid resting orders; submit nothing.

    Sizing uses the destination wallet's *settled* balance at creation, not
    free collateral (which shrinks as rungs reserve margin). Free collateral
    independently bounds the whole campaign. Every rung is checked against
    the live venue's quantity limits after step rounding. This deliberately
    does not turn the old one-order signer endpoint into a campaign endpoint.
    """
    if side not in ("BUY", "SELL"):
        raise BuildError("BAD_SIDE")
    if leverage < 1 or leverage > 100 or leverage > venue_max_leverage:
        raise BuildError("BAD_LEVERAGE")
    n = int(_pget("orchestration", "campaign_rung_count"))
    if n != 5:
        raise BuildError("CAMPAIGN_RUNG_COUNT_UNSUPPORTED")
    balance = _q(settled_wallet_balance_usd)
    available = _q(available_collateral_usd)
    min_size = _q(min_order_size)
    max_size = _q(max_order_size)
    price = _q(mark_price)
    tick = _q(tick_size)
    step = _q(step_size)
    if balance <= 0 or available < 0:
        raise BuildError("CAMPAIGN_BALANCE_INVALID")
    if min_size <= 0 or max_size < min_size or price <= 0 or tick <= 0 or step <= 0:
        raise BuildError("CAMPAIGN_CONTRACT_INVALID")
    target_margin = balance * _pget(
        "orchestration", "campaign_margin_fraction_of_settled_wallet_balance"
    )
    if available - ACCOUNT_FLOOR_USD < target_margin:
        raise BuildError("CAMPAIGN_COLLATERAL_INSUFFICIENT")

    span = _ladder_span_pct(leverage)
    per_rung = target_margin / Decimal(n)
    rung_plans: list[LadderRungPlan] = []
    total_margin = Decimal(0)
    total_notional = Decimal(0)
    for i in range(n):
        fraction = Decimal(i) / Decimal(n - 1)
        raw_price = price * (Decimal(1) - fraction * span) if side == "BUY" else price * (Decimal(1) + fraction * span)
        limit_price = round_price_to_tick(raw_price, tick, "DOWN" if side == "BUY" else "UP")
        if rung_plans:
            previous = Decimal(rung_plans[-1].limit_price)
            current = Decimal(limit_price)
            if (side == "BUY" and current >= previous) or (side == "SELL" and current <= previous):
                raise BuildError("CAMPAIGN_RUNG_PRICE_COLLISION")
        requested_size = per_rung * Decimal(leverage) / Decimal(limit_price)
        built = build_order(BuildInput(
            symbol=symbol, side=side, mark_price=mark_price, leverage=leverage,
            capital_baseline_usd="0", tick_size=tick_size, step_size=step_size,
            decimals=decimals, l2_pair_id=l2_pair_id,
            taker_fee_rate=taker_fee_rate, maker_fee_rate=maker_fee_rate,
            order_type="LIMIT", limit_price=limit_price,
            size_override=format(requested_size, "f"),
        ))
        actual_size = Decimal(built.size)
        if actual_size < min_size:
            raise BuildError("CAMPAIGN_RUNG_BELOW_VENUE_MINIMUM")
        if actual_size > max_size:
            raise BuildError("CAMPAIGN_RUNG_ABOVE_VENUE_MAXIMUM")
        actual_margin = Decimal(built.margin_usd)
        if actual_margin > per_rung:
            raise BuildError("CAMPAIGN_RUNG_OVERSPEND")
        total_margin += actual_margin
        total_notional += Decimal(built.notional_usd)
        rung_plans.append(LadderRungPlan(
            index=i + 1, limit_price=built.protected_price, size=built.size,
            margin_usd=built.margin_usd, notional_usd=built.notional_usd,
            built=built,
        ))
    if total_margin > target_margin:
        raise BuildError("CAMPAIGN_OVERSPEND")

    deepest = Decimal(rung_plans[-1].limit_price)
    stop_pct = _pget("ladder", "hard_stop_beyond_last_rung_pct")
    stop_raw = deepest * (Decimal(1) - stop_pct) if side == "BUY" else deepest * (Decimal(1) + stop_pct)
    stop_price = round_price_to_tick(stop_raw, tick, "DOWN" if side == "BUY" else "UP")
    return LadderPlan(
        symbol=symbol, side=side, leverage=leverage, rungs=tuple(rung_plans),
        total_margin_usd=format(total_margin.normalize(), "f"),
        total_notional_usd=format(total_notional.normalize(), "f"),
        hard_stop_price=stop_price,
        hard_stop_side="SELL" if side == "BUY" else "BUY",
    )


# ---------------------------------------------------------------------------
# Manual EXIT ladder planner (owner-only "Rung Down" scale-out path).
#
# Owner ruling #17. Mirror of build_ladder_plan for controlled EXITS:
#   * every rung is REDUCE_ONLY. No exceptions, no flag, no override.
#     A manual exit can NEVER open or flip a position.
#   * sum(rung sizes) <= selected close qty <= open position size. Sizes
#     are floored to the venue step; remainder is carried on the LAST rung
#     and is still floored. A hard assertion refuses to plan on overspend.
#   * ASCENDING (default, patient / better TP): LONG closes with SELL rungs
#     stepping UP from mark; SHORT closes with BUY rungs stepping DOWN.
#   * DESCENDING (urgent): LONG closes with SELL rungs stepping DOWN; SHORT
#     closes with BUY rungs stepping UP.
#   * Same span geometry as build_ladder_plan
#     (min(ladder_span_pct_cap, ladder_span_roi / leverage)). No new spacing.
#   * Tick-round each rung price on the side that never makes the fill
#     WORSE than requested (SELL -> UP, BUY -> DOWN — same as entry LIMITs).
#   * The hard stop is NOT touched by this path. See ruling #17 step 4.
# ---------------------------------------------------------------------------

Direction = Literal["ASCENDING", "DESCENDING"]


@dataclass(frozen=True)
class ExitRungPlan:
    index: int              # 1-based
    limit_price: str
    size: str
    notional_usd: str
    reduce_only: bool       # invariant: True. Rejected at build if False.


@dataclass(frozen=True)
class ExitLadderPlan:
    symbol: str
    position_side: str      # "BUY" (LONG) or "SELL" (SHORT) — the OPEN side
    exit_side: str          # opposite of position_side
    leverage: int
    direction: str          # ASCENDING | DESCENDING
    open_size: str          # current open size read at plan time
    close_size: str         # owner-selected close quantity
    actual_close_size: str  # SUM of rung sizes after step-rounding
    remaining_size: str     # open_size - actual_close_size (post-fill)
    rungs: tuple[ExitRungPlan, ...]


def build_exit_ladder_plan(
    *,
    symbol: str,
    position_side: Literal["BUY", "SELL"],
    mark_price: str,
    open_size: str,
    close_size: str,
    leverage: int,
    tick_size: str,
    step_size: str,
    rungs: int | None = None,
    direction: Direction = "ASCENDING",
    # Ruling #18 addition 1 — explicit price-range mode. When BOTH start_price
    # and end_price are provided, rungs distribute EVENLY and INCLUSIVELY from
    # start_price..end_price (rung 1 = start, rung N = end). When either is
    # None, falls back to the span-derived geometry from ruling #17.
    start_price: str | None = None,
    end_price: str | None = None,
) -> ExitLadderPlan:
    """Plan a manual scale-out. See module comment for the safety contract."""
    if position_side not in ("BUY", "SELL"):
        raise BuildError("BAD_SIDE")
    if direction not in ("ASCENDING", "DESCENDING"):
        raise BuildError("BAD_DIRECTION")
    if leverage <= 0 or leverage > 100:
        raise BuildError("BAD_LEVERAGE")

    price = _q(mark_price)
    if price <= 0:
        raise BuildError("BAD_MARK_PRICE")

    open_q = _q(open_size)
    close_q = _q(close_size)
    if open_q <= 0:
        raise BuildError("NO_OPEN_POSITION")
    if close_q <= 0:
        raise BuildError("BAD_CLOSE_SIZE")
    # HARD CAP — the owner-selected close quantity cannot exceed the
    # currently-open size. Every rung is reduce-only anyway, but rejecting
    # here surfaces a clear planner-time error instead of a venue reject.
    if close_q > open_q:
        raise BuildError("CLOSE_EXCEEDS_OPEN")

    # Ruling #18 addition 2 — exit ladders use a SEPARATE clamp from entry
    # ladders. Entry rungs commit margin; exit rungs only release exposure.
    rungs_min = int(_pget("ladder", "exit_rungs_min"))
    rungs_max = int(_pget("ladder", "exit_rungs_max"))
    rungs_default = int(_pget("ladder", "exit_rungs_default"))
    n = int(rungs) if rungs is not None else rungs_default
    if n < rungs_min: n = rungs_min
    if n > rungs_max: n = rungs_max

    step = _q(step_size)
    tick = _q(tick_size)
    if step <= 0:
        raise BuildError("BAD_STEP_SIZE")
    if tick <= 0:
        raise BuildError("BAD_TICK_SIZE")

    # Even split of the CLOSE quantity across rungs. Each rung is floored
    # to the venue step; remainder is carried onto the last rung and
    # floored again — so the sum can never exceed close_q.
    per_rung_raw = close_q / Decimal(n)
    per_rung = _round_down_to_step(per_rung_raw, step)
    sizes: list[Decimal] = [per_rung] * (n - 1)
    used_so_far = per_rung * Decimal(n - 1)
    last_raw = close_q - used_so_far
    last_size = _round_down_to_step(last_raw, step)
    sizes.append(last_size)

    # Drop zero-size rungs (close_q too small to fill even one step across
    # n rungs) so we never send zero-qty LIMITs to the venue.
    sizes = [s for s in sizes if s > 0]
    if not sizes:
        raise BuildError("CLOSE_SIZE_BELOW_STEP")

    total_close = sum(sizes, Decimal(0))
    # ACTUAL CAP GUARD — post-rounding sum must never exceed the requested
    # close quantity, which itself is already <= open size.
    if total_close > close_q:
        raise BuildError("EXIT_LADDER_OVERSPEND")
    if total_close > open_q:
        raise BuildError("EXIT_LADDER_EXCEEDS_OPEN")

    exit_side: Literal["BUY", "SELL"] = "SELL" if position_side == "BUY" else "BUY"
    # Tick-round direction: SELL rungs round UP (never fills worse), BUY
    # rungs round DOWN. Same convention as the entry LIMIT builder.
    tick_dir = "UP" if exit_side == "SELL" else "DOWN"

    # -------------------------------------------------------------------
    # Ruling #18 addition 1 — explicit price-range mode.
    # -------------------------------------------------------------------
    use_range = start_price is not None and end_price is not None
    if (start_price is None) ^ (end_price is None):
        raise BuildError("RANGE_REQUIRES_BOTH_ENDPOINTS")

    rung_prices: list[Decimal] = []
    if use_range:
        sp = _q(str(start_price))
        ep = _q(str(end_price))
        if sp <= 0 or ep <= 0:
            raise BuildError("BAD_RANGE_PRICE")

        # Direction must agree with (start -> end) ordering AND with the
        # side of mark that resting reduce-only rungs can safely sit on.
        # ASCENDING = walk AWAY from position (LONG SELLs above mark,
        # SHORT BUYs below mark). DESCENDING = walk INTO price.
        if position_side == "BUY":
            profitable_above = True   # LONG exits profitably ABOVE mark
        else:
            profitable_above = False  # SHORT exits profitably BELOW mark
        want_ascending_range = (direction == "ASCENDING") == profitable_above
        # want_ascending_range True  => end > start required
        # want_ascending_range False => end < start required
        if want_ascending_range and not (ep > sp):
            raise BuildError("RANGE_INVERTED_FOR_DIRECTION")
        if (not want_ascending_range) and not (sp > ep):
            raise BuildError("RANGE_INVERTED_FOR_DIRECTION")

        # Every rung must sit on the correct side of mark for a resting
        # reduce-only order: SELL exit -> strictly ABOVE mark; BUY exit
        # -> strictly BELOW mark. Reject the whole plan otherwise.
        for endpoint in (sp, ep):
            if exit_side == "SELL" and not (endpoint > price):
                raise BuildError("RUNG_WRONG_SIDE_OF_MARK")
            if exit_side == "BUY" and not (endpoint < price):
                raise BuildError("RUNG_WRONG_SIDE_OF_MARK")

        m = len(sizes)
        denom = Decimal(m - 1) if m > 1 else Decimal(1)
        for i in range(m):
            if m == 1:
                raw_px = sp
            else:
                raw_px = sp + (ep - sp) * Decimal(i) / denom
            if raw_px <= 0:
                raise BuildError("RUNG_PRICE_INVALID")
            rung_px = _q(round_price_to_tick(
                format(raw_px.normalize(), "f"), tick_size, tick_dir))
            # Post-rounding safety re-check on side of mark.
            if exit_side == "SELL" and not (rung_px > price):
                raise BuildError("RUNG_WRONG_SIDE_OF_MARK")
            if exit_side == "BUY" and not (rung_px < price):
                raise BuildError("RUNG_WRONG_SIDE_OF_MARK")
            rung_prices.append(rung_px)
    else:
        # -----------------------------------------------------------------
        # Span-derived geometry (ruling #17). Rung 1 sits at mark (frac=0).
        # -----------------------------------------------------------------
        span = _ladder_span_pct(leverage)
        # Direction: ASCENDING = walk AWAY on the profitable side of the
        # position (LONG-close SELLs step UP; SHORT-close BUYs step DOWN).
        # DESCENDING = walk INTO price.
        if position_side == "BUY":
            step_sign = Decimal(1) if direction == "ASCENDING" else Decimal(-1)
        else:
            step_sign = Decimal(-1) if direction == "ASCENDING" else Decimal(1)
        denom = Decimal(len(sizes) - 1) if len(sizes) > 1 else Decimal(1)
        for i in range(len(sizes)):
            frac = (Decimal(i) / denom) * span if len(sizes) > 1 else Decimal(0)
            raw_px = price * (Decimal(1) + step_sign * frac)
            if raw_px <= 0:
                raise BuildError("RUNG_PRICE_INVALID")
            rung_px = _q(round_price_to_tick(
                format(raw_px.normalize(), "f"), tick_size, tick_dir))
            rung_prices.append(rung_px)

    rung_plans: list[ExitRungPlan] = []
    for i, (sz, rung_px) in enumerate(zip(sizes, rung_prices)):
        notional = sz * rung_px
        # REDUCE-ONLY IS AN INVARIANT. Asserted, not passed in.
        reduce_only = True
        if reduce_only is not True:  # pragma: no cover — defensive tripwire
            raise BuildError("REDUCE_ONLY_VIOLATED")
        rung_plans.append(ExitRungPlan(
            index=i + 1,
            limit_price=format(rung_px.normalize(), "f"),
            size=format(sz.normalize(), "f"),
            notional_usd=format(notional.normalize(), "f"),
            reduce_only=True,
        ))

    remaining = open_q - total_close

    return ExitLadderPlan(
        symbol=symbol,
        position_side=position_side,
        exit_side=exit_side,
        leverage=leverage,
        direction=direction,
        open_size=format(open_q.normalize(), "f"),
        close_size=format(close_q.normalize(), "f"),
        actual_close_size=format(total_close.normalize(), "f"),
        remaining_size=format(remaining.normalize(), "f"),
        rungs=tuple(rung_plans),
    )



def recompute_tp_tier_sizes(
    *,
    remaining_qty: str,
    tier_fractions: list[str],
    step_size: str,
) -> list[str]:
    """Ruling #17 step 5. TP tiers are configured as fractions of the
    ORIGINAL position. After a partial manual exit those fractions
    over-close the remainder (e.g. TP1 at 50% of original == 100% of a
    halved remainder). Recompute each tier's absolute size against the
    CURRENT remaining quantity using the same tier fractions, floored to
    the venue step.

    Returns a list of size strings, one per tier, in tier order. Zero-size
    tiers are kept as "0" so the caller can still replace them positionally.
    """
    r = _q(remaining_qty)
    step = _q(step_size)
    if r <= 0 or step <= 0:
        return ["0" for _ in tier_fractions]
    out: list[str] = []
    used = Decimal(0)
    for i, f_str in enumerate(tier_fractions):
        frac = _q(f_str)
        if frac < 0 or frac > 1:
            raise BuildError("BAD_TIER_FRACTION")
        raw = r * frac
        # Last tier absorbs remainder up to the total remaining qty.
        if i == len(tier_fractions) - 1:
            raw = r - used
        sized = _round_down_to_step(raw, step)
        if sized < 0:
            sized = Decimal(0)
        used += sized
        out.append(format(sized.normalize(), "f") if sized > 0 else "0")
    return out
