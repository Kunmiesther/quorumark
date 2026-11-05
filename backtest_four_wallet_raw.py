"""Four-wallet research replay with full audit output.

This is deliberately not production code.  It applies the owner's existing
trade geometry without risk caps or discretionary vetoes and writes every
input, signal, order, fill, exit and equity observation to CSV/JSON.

Wallet routing:
  long     every confirmed 15m bullish entry aligned with 1h/4h
  short    every confirmed 15m bearish entry aligned with 1h/4h
  strategy every deduplicated 15m Hunter volatility/FVG retrace
  hedge    raw/cleanup behavior is preserved; graded mode activates one
           exposure-matched leg only on a clear A-grade reversal

All four wallets are separate $2,500 cross-margin pools coordinated in one
event loop.  No collateral is silently transferred between wallets.
"""
from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
import csv
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import hunter_entry
import accumulator_signal
from backtest_pnl_sweep_15m_50_30_20 import (
    APEX_LEVERAGE,
    APEX_MMR,
    BARS_5M,
    CLOSE,
    HIGH,
    LOW,
    OPEN,
    RUNG_MARGIN,
    SYMBOLS,
    TARGET_START_MS,
    TS,
    WARMUP_5M_BARS,
    fetch_apex,
)
from backtest_pnl_sweep_15m_four_rung import FIXED_END_SECONDS
from backtest_pnl_sweep_sniper_stack_30d import _aggregate_15m
from htf_bos import (
    MIN_HTF_CANDLES_FOR_BOS,
    aggregate_1h,
    aggregate_4h,
)
from regime import regime_state_series
from shared.parity_constants import get as parity_get
from shared.orchestration_policy import (
    MAX_ACTIVE_OPPORTUNITIES,
    PortfolioCandidate,
    is_confirmed_protective_reversal,
    rank_cycle_symbols,
)
from sweep_signal import SWEEP_ATR_SMA_PERIOD, atr_series
from sweep_signal import detect_sweep

WALLET_START = 2_500.0
RUNG_COUNT = 5
RUNG_STEP = 0.005
VOLUME = 5
DAY_MS = 24 * 60 * 60 * 1000
EXPANDED_RUNG_COUNT = 8
EXPANDED_CORE_ENTRY_STEP = 5
EXPANDED_HEDGE_TRAIL_STEPS = 2
UNPAIRED_HEDGE_MAX_MARGIN_PCT = 0.05
UNPAIRED_HEDGE_DEFAULT_RESIZE_FRACTION = 0.5
UNPAIRED_HEDGE_DEFAULT_RECOVERY_BARS = 2
UNPAIRED_HEDGE_DEFAULT_RECOVERY_ROI = 0.05
TP_SLICES = ((0.50, 0.50), (0.30, 0.80), (0.20, 1.00))
FEE_RATE = 0.0005
SLIPPAGE_RATE = 0.0002
MAINTENANCE_BUFFER_MULTIPLE = 2.0
MAX_ACTIVE_TRADE_SYMBOLS = MAX_ACTIVE_OPPORTUNITIES
STALE_AFTER_BARS = 8
ROTATION_SCORE_MARGIN = 0.10
OUTPUT_DIR = Path("backtest_artifacts/four_wallet_5d_raw")
CLEANUP_OUTPUT_DIR = Path("backtest_artifacts/four_wallet_5d_cleanup_1_2")
GRADED_OUTPUT_DIR = Path("backtest_artifacts/four_wallet_5d_graded_all_signals")
COORDINATED_OUTPUT_DIR = Path("backtest_artifacts/four_wallet_5d_coordinated_lifecycle")
ALIGNED_30D_5M_OUTPUT_DIR = Path("backtest_artifacts/four_wallet_30d_5m_aligned")
GRADE_RANK = {"D": 1, "C": 2, "B": 3, "A": 4}
DEFAULT_SWEEP_STOP_BUFFER_ATR = float(
    parity_get("sweep", "stop_beyond_edge_atr")
)
LONG_TRUSTED_LIQUIDITY_SOURCES = frozenset({
    "session", "prior_day", "confirmed_structure_zone",
})


@dataclass
class Order:
    order_id: str
    campaign_id: str
    signal_id: str
    wallet: str
    strategy: str
    symbol: str
    side: str
    rung: int
    slice_fraction: float
    target_roi: float
    created_ts: int
    entry: float
    target: float
    notional: float
    qty: float
    initial_margin: float
    stop: float | None = None
    state: str = "pending"


@dataclass
class Position:
    order: Order
    entry: float
    qty: float
    opened_ts: int
    entry_fee: float
    state: str = "open"
    gross_pnl: float = 0.0
    exit_fee: float = 0.0
    net_pnl: float = 0.0
    closed_ts: int | None = None
    exit_price: float | None = None
    exit_reason: str | None = None
    trailing_active: bool = False
    trailing_armed_ts: int | None = None
    trailing_distance: float | None = None


@dataclass
class Wallet:
    name: str
    cash: float = WALLET_START
    orders: list[Order] = field(default_factory=list)
    positions: list[Position] = field(default_factory=list)
    fees: float = 0.0
    liquidations: int = 0
    peak_equity: float = WALLET_START
    max_drawdown: float = 0.0


@dataclass
class CoordinatedCampaign:
    campaign_id: str
    symbol: str
    side: str
    wallet: str
    grade: str
    confirmations: int = 1
    size_upgrades: int = 0
    frozen: bool = False
    status: str = "active"
    created_ts: int = 0
    invalidation_price: float | None = None
    entry_score: float = 0.0


@dataclass
class ReversalState:
    symbol: str
    old_side: str
    new_side: str
    hedge_campaign_id: str | None
    first_ts: int
    confirmations: int = 1


@dataclass
class PreEntryHedgeState:
    symbol: str
    core_campaign_id: str
    core_side: str
    hedge_campaign_id: str
    signal_price: float
    retrace_armed: bool = False
    dynamic_trailing: bool = False
    deepest_favorable_step: int = 0
    core_was_filled: bool = False
    unpaired_resize_needed: bool = False
    max_unpaired_adverse_step: int = 0
    resize_count: int = 0
    last_resize_adverse_step: int = 0
    first_resize_ts: int | None = None


@dataclass(frozen=True)
class BreakRetestSignal:
    direction: str
    entry: float
    mode: str
    level_source: str
    invalidation_price: float


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat()


def open_positions(wallet: Wallet) -> list[Position]:
    return [position for position in wallet.positions if position.state == "open"]


def pending_orders(wallet: Wallet) -> list[Order]:
    return [order for order in wallet.orders if order.state == "pending"]


def position_pnl(position: Position, mark: float) -> float:
    move = mark - position.entry if position.order.side == "long" else position.entry - mark
    return move * position.qty


def wallet_equity(wallet: Wallet, marks: dict[str, float]) -> float:
    return wallet.cash + sum(position_pnl(p, marks[p.order.symbol]) for p in open_positions(wallet))


def used_margin(wallet: Wallet) -> float:
    return sum(position.order.initial_margin for position in open_positions(wallet))


def reserved_margin(wallet: Wallet) -> float:
    return sum(order.initial_margin for order in pending_orders(wallet))


def free_collateral(wallet: Wallet, marks: dict[str, float]) -> float:
    return wallet_equity(wallet, marks) - used_margin(wallet) - reserved_margin(wallet)


def adverse_position_price(position: Position, candles: dict[str, list]) -> float:
    """Worst observed price on this completed candle for one position side."""
    candle = candles[position.order.symbol]
    return float(candle[LOW] if position.order.side == "long" else candle[HIGH])


def cross_margin_deleverage(
    wallet: Wallet,
    timestamp: int,
    candles: dict[str, list],
    events: list[dict],
) -> int:
    """Stress one symbol at a time; never combine unrelated candle extremes."""
    closed_campaigns = 0
    while open_positions(wallet):
        opened = open_positions(wallet)
        maintenance = sum(
            p.order.notional * APEX_MMR[p.order.symbol] for p in opened
        )
        open_symbols = sorted({p.order.symbol for p in opened})
        stress_equities = {
            stressed_symbol: wallet.cash + sum(
                position_pnl(
                    p,
                    adverse_position_price(p, candles)
                    if p.order.symbol == stressed_symbol
                    else float(candles[p.order.symbol][CLOSE]),
                )
                for p in opened
            )
            for stressed_symbol in open_symbols
        }
        stressed_symbol = min(stress_equities, key=stress_equities.get)
        adverse_equity = stress_equities[stressed_symbol]
        if adverse_equity > maintenance * MAINTENANCE_BUFFER_MULTIPLE:
            break
        campaign_ids = {p.order.campaign_id for p in opened}
        worst_campaign = min(
            campaign_ids,
            key=lambda campaign_id: sum(
                position_pnl(p, adverse_position_price(p, candles))
                if p.order.symbol == stressed_symbol
                else position_pnl(p, float(candles[p.order.symbol][CLOSE]))
                for p in opened if p.order.campaign_id == campaign_id
            ),
        )
        campaign_positions = [
            p for p in opened if p.order.campaign_id == worst_campaign
        ]
        append_event(
            events, timestamp, "cross_margin_deleverage",
            wallet=wallet.name, campaign_id=worst_campaign,
            symbol=campaign_positions[0].order.symbol,
            adverse_equity=adverse_equity, maintenance=maintenance,
            stressed_symbol=stressed_symbol,
            buffer_multiple=MAINTENANCE_BUFFER_MULTIPLE,
        )
        for position in campaign_positions:
            close_position(
                wallet, position, timestamp,
                (
                    adverse_position_price(position, candles)
                    if position.order.symbol == stressed_symbol
                    else float(candles[position.order.symbol][CLOSE])
                ),
                "cross_margin_deleverage", events,
            )
        cancel_campaign_pending(
            wallet, worst_campaign, timestamp,
            "cross_margin_deleverage", events,
        )
        closed_campaigns += 1
    return closed_campaigns


def append_event(events: list[dict], timestamp: int, kind: str, **detail) -> None:
    events.append({"timestamp": timestamp, "time_utc": iso(timestamp), "event": kind, **detail})


def close_position(
    wallet: Wallet,
    position: Position,
    timestamp: int,
    raw_price: float,
    reason: str,
    events: list[dict],
) -> None:
    side = position.order.side
    price = raw_price * (1 - SLIPPAGE_RATE if side == "long" else 1 + SLIPPAGE_RATE)
    gross = position_pnl(position, price)
    exit_fee = price * position.qty * FEE_RATE
    net = gross - position.entry_fee - exit_fee
    wallet.cash += gross - exit_fee
    wallet.fees += exit_fee
    position.state = "closed"
    position.gross_pnl = gross
    position.exit_fee = exit_fee
    position.net_pnl = net
    position.closed_ts = timestamp
    position.exit_price = price
    position.exit_reason = reason
    append_event(
        events, timestamp, "close", wallet=wallet.name,
        campaign_id=position.order.campaign_id, signal_id=position.order.signal_id,
        order_id=position.order.order_id, strategy=position.order.strategy,
        symbol=position.order.symbol, side=side, rung=position.order.rung,
        slice_fraction=position.order.slice_fraction, raw_price=raw_price,
        execution_price=price, gross_pnl=gross, entry_fee=position.entry_fee,
        exit_fee=exit_fee, net_pnl=net, reason=reason,
    )


def projected_close_net(position: Position, raw_price: float) -> float:
    """Net P&L if an open slice exits now with modeled costs."""
    side = position.order.side
    price = raw_price * (1 - SLIPPAGE_RATE if side == "long" else 1 + SLIPPAGE_RATE)
    gross = position_pnl(position, price)
    exit_fee = price * position.qty * FEE_RATE
    return gross - position.entry_fee - exit_fee


def arm_campaign_trailing_remainder(
    wallet: Wallet,
    trigger: Position,
    timestamp: int,
    distance_roi: float,
    events: list[dict],
) -> int:
    """Arm higher-target slices after the first 50% reaches its target."""
    leverage = APEX_LEVERAGE[trigger.order.symbol]
    distance = trigger.order.entry * distance_roi / leverage
    stop_sign = 1 if trigger.order.side == "long" else -1
    initial_stop = trigger.order.entry + stop_sign * distance
    armed = 0
    for position in open_positions(wallet):
        order = position.order
        if (
            order.campaign_id != trigger.order.campaign_id
            or order.rung != trigger.order.rung
            or order.target_roi <= trigger.order.target_roi
        ):
            continue
        order.stop = initial_stop
        position.trailing_active = True
        position.trailing_armed_ts = timestamp
        position.trailing_distance = distance
        armed += 1
        append_event(
            events, timestamp, "trailing_stop_armed",
            wallet=wallet.name, campaign_id=order.campaign_id,
            signal_id=order.signal_id, order_id=order.order_id,
            strategy=order.strategy, symbol=order.symbol, side=order.side,
            rung=order.rung, stop=initial_stop,
            activation_roi=trigger.order.target_roi,
            distance_roi=distance_roi,
        )
    return armed


def ratchet_trailing_stop(position: Position, candle: list) -> bool:
    """Advance an armed trailing stop with favorable price; never loosen it."""
    if not position.trailing_active or position.trailing_distance is None:
        return False
    if position.order.side == "long":
        candidate = float(candle[HIGH]) - position.trailing_distance
        tightened = position.order.stop is None or candidate > position.order.stop
    else:
        candidate = float(candle[LOW]) + position.trailing_distance
        tightened = position.order.stop is None or candidate < position.order.stop
    if tightened:
        position.order.stop = candidate
    return tightened


def fill_order(
    wallet: Wallet,
    order: Order,
    timestamp: int,
    raw_price: float,
    marks: dict[str, float],
    events: list[dict],
) -> bool:
    order.state = "evaluating"
    side = order.side
    price = raw_price * (1 + SLIPPAGE_RATE if side == "long" else 1 - SLIPPAGE_RATE)
    fee = order.notional * FEE_RATE
    required_after_release = order.initial_margin + fee
    available_after_release = free_collateral(wallet, marks)
    if available_after_release < required_after_release:
        order.state = "margin_rejected"
        append_event(
            events, timestamp, "margin_reject", wallet=wallet.name,
            campaign_id=order.campaign_id, signal_id=order.signal_id,
            order_id=order.order_id, strategy=order.strategy, symbol=order.symbol,
            side=side, rung=order.rung, required=required_after_release,
            available=available_after_release,
        )
        return False
    order.state = "filled"
    wallet.cash -= fee
    wallet.fees += fee
    position = Position(order=order, entry=price, qty=order.notional / price, opened_ts=timestamp, entry_fee=fee)
    wallet.positions.append(position)
    append_event(
        events, timestamp, "fill", wallet=wallet.name,
        campaign_id=order.campaign_id, signal_id=order.signal_id,
        order_id=order.order_id, strategy=order.strategy, symbol=order.symbol,
        side=side, rung=order.rung, slice_fraction=order.slice_fraction,
        target_roi=order.target_roi, raw_price=raw_price, execution_price=price,
        target=order.target, qty=position.qty, notional=order.notional,
        initial_margin=order.initial_margin, fee=fee,
    )
    return True


def make_campaign(
    sequence: int,
    signal_id: str,
    wallet: str,
    strategy: str,
    symbol: str,
    side: str,
    timestamp: int,
    base_entry: float,
    rung_count: int = RUNG_COUNT,
    margin_per_rung: float = RUNG_MARGIN,
    tp_slices: tuple[tuple[float, float], ...] = TP_SLICES,
) -> list[Order]:
    leverage = APEX_LEVERAGE[symbol]
    entry_sign = -1 if side == "long" else 1
    target_sign = 1 if side == "long" else -1
    campaign_id = f"C{sequence:06d}"
    orders = []
    ordinal = 0
    for rung in range(rung_count):
        entry = base_entry * (1 + entry_sign * RUNG_STEP * rung)
        for fraction, roi in tp_slices:
            ordinal += 1
            notional = margin_per_rung * fraction * leverage
            orders.append(Order(
                order_id=f"{campaign_id}-O{ordinal:02d}", campaign_id=campaign_id,
                signal_id=signal_id, wallet=wallet, strategy=strategy,
                symbol=symbol, side=side, rung=rung + 1,
                slice_fraction=fraction, target_roi=roi, created_ts=timestamp,
                entry=entry, target=entry * (1 + target_sign * roi / leverage),
                notional=notional, qty=notional / entry,
                initial_margin=notional / leverage,
            ))
    return orders


def campaign_reward_risk(
    orders: list[Order], invalidation_price: float | None,
) -> dict[str, float | int | None]:
    """Pre-trade 50/30/20 reward versus loss at structural invalidation.

    Only rungs price must cross before reaching the invalidation are included.
    This is an admission diagnostic, not an isolated-margin liquidation model.
    """
    if not orders or invalidation_price is None or invalidation_price <= 0:
        return {
            "eligible_rungs": 0, "net_reward": None,
            "invalidation_loss": None, "reward_risk": None,
        }
    side = orders[0].side
    fillable = [
        order for order in orders
        if (
            order.entry > invalidation_price
            if side == "long" else order.entry < invalidation_price
        )
    ]
    if not fillable:
        return {
            "eligible_rungs": 0, "net_reward": None,
            "invalidation_loss": None, "reward_risk": None,
        }
    gross_reward = sum(
        abs(order.target - order.entry) * order.qty for order in fillable
    )
    gross_loss = sum(
        abs(order.entry - invalidation_price) * order.qty for order in fillable
    )
    round_trip_cost = sum(
        order.notional * (2 * FEE_RATE + 2 * SLIPPAGE_RATE)
        for order in fillable
    )
    net_reward = max(0.0, gross_reward - round_trip_cost)
    invalidation_loss = gross_loss + round_trip_cost
    return {
        "eligible_rungs": len({order.rung for order in fillable}),
        "net_reward": net_reward,
        "invalidation_loss": invalidation_loss,
        "reward_risk": (
            net_reward / invalidation_loss if invalidation_loss > 0 else None
        ),
    }


def orders_before_invalidation(
    orders: list[Order], invalidation_price: float | None,
) -> list[Order]:
    """Keep only ladder orders that exist before the setup boundary."""
    if invalidation_price is None:
        return orders
    return [
        order for order in orders
        if (
            order.entry > invalidation_price
            if order.side == "long" else order.entry < invalidation_price
        )
    ]


def stage_three_rungs_after_three_spaces(
    orders: list[Order], entry_steps: int = 3,
) -> list[Order]:
    """Wait configured 0.5% spaces, then stage rungs 1-3 together."""
    if entry_steps < 1:
        raise ValueError("entry_steps must be positive")
    if not orders:
        return orders
    base_entry = orders[0].entry
    leverage = APEX_LEVERAGE[orders[0].symbol]
    entry_sign = -1 if orders[0].side == "long" else 1
    target_sign = 1 if orders[0].side == "long" else -1
    for order in orders:
        space = entry_steps if order.rung <= 3 else order.rung
        order.entry = base_entry * (1 + entry_sign * RUNG_STEP * space)
        order.target = order.entry * (
            1 + target_sign * order.target_roi / leverage
        )
        order.qty = order.notional / order.entry
    return orders


def stage_all_rungs_at_alert(orders: list[Order]) -> list[Order]:
    """Place every authorized rung at the original signal price."""
    if not orders:
        return orders
    alert_price = orders[0].entry
    leverage = APEX_LEVERAGE[orders[0].symbol]
    target_sign = 1 if orders[0].side == "long" else -1
    for order in orders:
        order.entry = alert_price
        order.target = alert_price * (
            1 + target_sign * order.target_roi / leverage
        )
        order.qty = order.notional / alert_price
    return orders


def stage_five_rungs_after_five_steps(orders: list[Order]) -> list[Order]:
    """Stage five $8 rungs at -/+2.5%, then retain steps six-eight."""
    if not orders:
        return orders
    base_entry = orders[0].entry
    leverage = APEX_LEVERAGE[orders[0].symbol]
    entry_sign = -1 if orders[0].side == "long" else 1
    target_sign = 1 if orders[0].side == "long" else -1
    for order in orders:
        step = EXPANDED_CORE_ENTRY_STEP if order.rung <= 5 else order.rung
        order.entry = base_entry * (1 + entry_sign * RUNG_STEP * step)
        order.target = order.entry * (
            1 + target_sign * order.target_roi / leverage
        )
        order.qty = order.notional / order.entry
    return orders


def long_entry_quality_rejection(
    level_source: str, reward_risk: float | None,
    mode: str = "retest", momentum_ratio: float | None = None,
    eligible_rungs: int | None = None,
) -> str | None:
    """Reject Long entries whose pre-trade payoff cannot support their risk.

    Session and prior-day liquidity are retained as explicit market landmarks.
    Generic swing liquidity must offer at least one net dollar of modeled target
    reward for every dollar lost at structural invalidation. Equal-low signals
    remain observable but are not admitted by this Long-only research gate.
    """
    trusted_landmark = level_source in LONG_TRUSTED_LIQUIDITY_SOURCES
    viable_swing = (
        level_source == "swing"
        and reward_risk is not None
        and reward_risk >= 1.0
    )
    if not (trusted_landmark or viable_swing):
        return "long_entry_quality_gate"
    if mode == "rejection" and (
        momentum_ratio is None or momentum_ratio < 1.05
    ):
        return "long_rejection_without_displacement"
    if eligible_rungs is None or eligible_rungs < 3:
        return "long_insufficient_ladder_space"
    return None


def entry_boundary_broken(
    side: str,
    candle: list,
    invalidation_price: float | None,
    reject_touch: bool = False,
) -> bool:
    """Reject a setup whose trigger bar has already invalidated its thesis."""
    if invalidation_price is None:
        return False
    observed = float(
        candle[LOW if side == "long" else HIGH]
        if reject_touch else candle[CLOSE]
    )
    return (
        observed <= invalidation_price
        if side == "long" else observed >= invalidation_price
    )


def campaign_is_active(wallet: Wallet, campaign_id: str) -> bool:
    return any(
        position.state == "open" and position.order.campaign_id == campaign_id
        for position in wallet.positions
    ) or any(
        order.state == "pending" and order.campaign_id == campaign_id
        for order in wallet.orders
    )


def campaign_open_notional(wallet: Wallet, campaign_id: str) -> float:
    return sum(
        position.order.notional for position in open_positions(wallet)
        if position.order.campaign_id == campaign_id
    )


def cancel_campaign_pending(
    wallet: Wallet,
    campaign_id: str,
    timestamp: int,
    reason: str,
    events: list[dict],
) -> None:
    for order in list(pending_orders(wallet)):
        if order.campaign_id != campaign_id:
            continue
        order.state = f"cancelled_{reason}"
        append_event(
            events, timestamp, "cancel", wallet=wallet.name,
            campaign_id=campaign_id, signal_id=order.signal_id,
            order_id=order.order_id, strategy=order.strategy,
            symbol=order.symbol, side=order.side, rung=order.rung,
            reason=reason,
        )


def close_campaign(
    wallet: Wallet,
    campaign_id: str,
    timestamp: int,
    marks: dict[str, float],
    reason: str,
    events: list[dict],
) -> None:
    for position in list(open_positions(wallet)):
        if position.order.campaign_id == campaign_id:
            close_position(
                wallet, position, timestamp, marks[position.order.symbol],
                reason, events,
            )
    cancel_campaign_pending(wallet, campaign_id, timestamp, reason, events)


def active_opportunity_symbols(wallets: dict[str, Wallet]) -> set[str]:
    """Symbols occupying the five portfolio opportunity slots."""
    names = {"long", "short", "strategy"}
    return {
        position.order.symbol
        for name in names for position in open_positions(wallets[name])
    } | {
        order.symbol
        for name in names for order in pending_orders(wallets[name])
    }


def campaign_net_if_closed(
    wallet: Wallet, campaign_id: str, marks: dict[str, float],
) -> float:
    realized = sum(
        position.net_pnl for position in wallet.positions
        if position.order.campaign_id == campaign_id and position.state == "closed"
    )
    projected = sum(
        projected_close_net(position, marks[position.order.symbol])
        for position in open_positions(wallet)
        if position.order.campaign_id == campaign_id
    )
    return realized + projected


def campaign_last_activity_ts(wallet: Wallet, campaign_id: str) -> int:
    times = [
        order.created_ts for order in wallet.orders
        if order.campaign_id == campaign_id
    ]
    for position in wallet.positions:
        if position.order.campaign_id != campaign_id:
            continue
        times.append(position.opened_ts)
        if position.closed_ts is not None and position.exit_reason == "target":
            times.append(position.closed_ts)
    return max(times, default=0)


def candidate_score(grade: str, momentum_ratio: float | None) -> float:
    """Comparable deterministic score; HTF grade dominates momentum."""
    return GRADE_RANK.get(grade, 0) + max(0.0, momentum_ratio or 0.0)


def admit_opportunity(
    wallets: dict[str, Wallet], campaign_history: dict[str, CoordinatedCampaign],
    timestamp: int, symbol: str, fresh_score: float,
    estimated_fresh_cost: float, marks: dict[str, float],
    momentum: dict[str, float | None], events: list[dict],
) -> tuple[bool, str | None]:
    """Use a free slot or replace one profitable, stale, weaker campaign."""
    active_symbols = active_opportunity_symbols(wallets)
    if symbol in active_symbols:
        return False, "symbol_slot_occupied"
    if len(active_symbols) < MAX_ACTIVE_TRADE_SYMBOLS:
        return True, None

    eligible: list[tuple[float, int, CoordinatedCampaign, float]] = []
    stale_ms = STALE_AFTER_BARS * 15 * 60 * 1000
    active_ids = {
        position.order.campaign_id
        for name in ("long", "short", "strategy")
        for position in open_positions(wallets[name])
    } | {
        order.campaign_id
        for name in ("long", "short", "strategy")
        for order in pending_orders(wallets[name])
    }
    for campaign_id in active_ids:
        state = campaign_history.get(campaign_id)
        if state is None:
            continue
        wallet = wallets[state.wallet]
        last_activity = campaign_last_activity_ts(wallet, state.campaign_id)
        if timestamp - last_activity < stale_ms:
            continue
        close_net = campaign_net_if_closed(wallet, state.campaign_id, marks)
        if close_net <= estimated_fresh_cost:
            continue
        current_score = candidate_score(
            state.grade, momentum.get(state.symbol),
        )
        eligible.append((current_score, last_activity, state, close_net))
    if not eligible:
        return False, "five_symbol_capacity"

    stale_score, _, stale, close_net = min(
        eligible, key=lambda item: (item[0], item[1]),
    )
    if fresh_score < stale_score + ROTATION_SCORE_MARGIN:
        return False, "fresh_edge_not_stronger"

    close_campaign(
        wallets[stale.wallet], stale.campaign_id, timestamp, marks,
        "profitable_stale_rotation", events,
    )
    unwind_symbol(
        wallets["hedge"], stale.symbol, timestamp, marks[stale.symbol], events,
        reason="underlying_rotated",
    )
    stale.status = "rotated_profitable_stale"
    append_event(
        events, timestamp, "portfolio_rotation",
        closed_campaign_id=stale.campaign_id,
        closed_wallet=stale.wallet, closed_symbol=stale.symbol,
        replacement_symbol=symbol, closed_net=close_net,
        stale_score=stale_score, fresh_score=fresh_score,
    )
    return True, stale.campaign_id


def close_structural_invalidations(
    wallets: dict[str, Wallet], campaign_history: dict[str, CoordinatedCampaign],
    timestamp: int, candles: dict[str, list], marks: dict[str, float],
    events: list[dict],
    preserved_hedge_campaign_ids: set[str] | None = None,
) -> None:
    """Exit campaigns whose completed bar crossed their setup boundary."""
    active_ids = {
        position.order.campaign_id
        for name in ("long", "short", "strategy")
        for position in open_positions(wallets[name])
    } | {
        order.campaign_id
        for name in ("long", "short", "strategy")
        for order in pending_orders(wallets[name])
    }
    for campaign_id in active_ids:
        state = campaign_history.get(campaign_id)
        if state is None:
            continue
        if state.invalidation_price is None:
            continue
        wallet = wallets[state.wallet]
        candle = candles[state.symbol]
        observed = float(candle[LOW if state.side == "long" else HIGH])
        invalid = (
            observed <= state.invalidation_price
            if state.side == "long"
            else observed >= state.invalidation_price
        )
        if not invalid:
            continue
        for position in list(open_positions(wallet)):
            if position.order.campaign_id == state.campaign_id:
                close_position(
                    wallet, position, timestamp, state.invalidation_price,
                    "structural_invalidation", events,
                )
        cancel_campaign_pending(
            wallet, state.campaign_id, timestamp,
            "structural_invalidation", events,
        )
        unwind_symbol(
            wallets["hedge"], state.symbol, timestamp, marks[state.symbol], events,
            reason="underlying_invalidated",
            preserve_campaign_ids=preserved_hedge_campaign_ids,
        )
        state.status = "structural_invalidation"


def place_campaign(
    wallet: Wallet,
    orders: list[Order],
    timestamp: int,
    marks: dict[str, float],
    events: list[dict],
    fill_initial: bool = True,
) -> bool:
    required_margin = sum(order.initial_margin for order in orders)
    required_fees = sum(order.notional * FEE_RATE for order in orders[:3])
    available = free_collateral(wallet, marks)
    first = orders[0]
    if available < required_margin + required_fees:
        for order in orders:
            order.state = "campaign_margin_rejected"
            wallet.orders.append(order)
        append_event(
            events, timestamp, "campaign_margin_reject", wallet=wallet.name,
            campaign_id=first.campaign_id, signal_id=first.signal_id,
            strategy=first.strategy, symbol=first.symbol, side=first.side,
            required=required_margin + required_fees, available=available,
        )
        return False
    wallet.orders.extend(orders)
    append_event(
        events, timestamp, "campaign_placed", wallet=wallet.name,
        campaign_id=first.campaign_id, signal_id=first.signal_id,
        strategy=first.strategy, symbol=first.symbol, side=first.side,
        orders=len(orders), margin_reserved=required_margin,
    )
    # Ordinary campaigns begin at a confirmed rung-one entry. Staged core
    # campaigns stay pending until the market actually trades at their level.
    if fill_initial:
        for order in orders[:3]:
            fill_order(wallet, order, timestamp, order.entry, marks, events)
    return True


def cancel_orphan_pending(wallet: Wallet, timestamp: int, events: list[dict]) -> None:
    campaign_ids = {order.campaign_id for order in pending_orders(wallet)}
    for campaign_id in campaign_ids:
        has_open = any(p.state == "open" and p.order.campaign_id == campaign_id for p in wallet.positions)
        has_filled = any(order.state == "filled" and order.campaign_id == campaign_id for order in wallet.orders)
        if has_filled and not has_open:
            for order in wallet.orders:
                if order.campaign_id == campaign_id and order.state == "pending":
                    order.state = "cancelled_campaign_complete"
                    append_event(
                        events, timestamp, "cancel", wallet=wallet.name,
                        campaign_id=campaign_id, signal_id=order.signal_id,
                        order_id=order.order_id, strategy=order.strategy,
                        symbol=order.symbol, side=order.side, rung=order.rung,
                        reason="campaign_complete",
                    )


def active_campaign_id(wallet: Wallet, symbol: str, side: str) -> str | None:
    """Return the existing active campaign for one symbol and direction."""
    for position in open_positions(wallet):
        order = position.order
        if order.symbol == symbol and order.side == side:
            return order.campaign_id
    for order in pending_orders(wallet):
        if order.symbol == symbol and order.side == side:
            return order.campaign_id
    return None


def signal_grade(side: str, state_1h: str, state_4h: str) -> str:
    """Grade direction using only completed higher-timeframe BOS states."""
    aligned = "bullish_bos" if side == "long" else "bearish_bos"
    opposed = "bearish_bos" if side == "long" else "bullish_bos"
    states = (state_1h, state_4h)
    if opposed in states:
        return "D"
    aligned_count = sum(state == aligned for state in states)
    if aligned_count == 2:
        return "A"
    if aligned_count == 1:
        return "B"
    return "C"


def aggregate_1d(candles_5m: list[list]) -> list[list]:
    """Aggregate ascending 5m candles into completed UTC daily candles."""
    buckets: dict[int, list] = {}
    counts: dict[int, int] = {}
    for candle in candles_5m:
        bucket = (int(candle[TS]) // DAY_MS) * DAY_MS
        counts[bucket] = counts.get(bucket, 0) + 1
        if bucket not in buckets:
            buckets[bucket] = [
                bucket, float(candle[OPEN]), float(candle[HIGH]),
                float(candle[LOW]), float(candle[CLOSE]), float(candle[VOLUME]),
            ]
        else:
            row = buckets[bucket]
            row[HIGH] = max(row[HIGH], float(candle[HIGH]))
            row[LOW] = min(row[LOW], float(candle[LOW]))
            row[CLOSE] = float(candle[CLOSE])
            row[VOLUME] += float(candle[VOLUME])
    return [
        buckets[bucket] for bucket in sorted(buckets)
        if counts[bucket] >= 288
    ]


def daily_trend_state_series(candles: list[list]) -> list[str]:
    """Classify completed days using a 5/10 EMA plus closing-price vote."""
    states: list[str] = []
    fast = slow = None
    fast_alpha = 2 / 6
    slow_alpha = 2 / 11
    for index, candle in enumerate(candles):
        close = float(candle[CLOSE])
        fast = close if fast is None else fast + fast_alpha * (close - fast)
        slow = close if slow is None else slow + slow_alpha * (close - slow)
        if index < 9:
            states.append("none")
        elif fast > slow and close > slow:
            states.append("bullish_bos")
        elif fast < slow and close < slow:
            states.append("bearish_bos")
        else:
            states.append("none")
    return states


def timeframe_alignment_votes(
    side: str, state_1h: str, state_4h: str, state_1d: str,
) -> int:
    aligned = "bullish_bos" if side == "long" else "bearish_bos"
    return sum(state == aligned for state in (state_1h, state_4h, state_1d))


def core_protection_state(
    core_side: str | None, state_1h: str, state_4h: str,
) -> str:
    """Return the Hedge lifecycle implied by completed 1h/4h structure.

    A 1h turn against the still-live 4h thesis starts protection. Once both
    completed higher timeframes oppose the core, the reversal is confirmed and
    the losing core plus its Hedge are closed. If 1h recovers before 4h flips,
    protection is no longer required.
    """
    if core_side is None:
        return "flat"
    opposed = "bearish_bos" if core_side == "long" else "bullish_bos"
    aligned = "bullish_bos" if core_side == "long" else "bearish_bos"
    if state_1h == opposed and state_4h == opposed:
        return "confirmed_reversal"
    if state_1h == opposed and state_4h == aligned:
        return "protect"
    return "clear"


def sweep_vote_quality_rejection(
    level_source: str, mode: str, momentum_ratio: float | None,
) -> str | None:
    """Shared Long/Short quality filter for the two-of-three vote replay."""
    accepted_source = level_source in LONG_TRUSTED_LIQUIDITY_SOURCES or level_source == "swing"
    if not accepted_source:
        return "vote_filter_weak_liquidity_source"
    if mode == "rejection" and (
        momentum_ratio is None or momentum_ratio < 1.05
    ):
        return "vote_filter_rejection_without_displacement"
    if level_source == "swing" and (
        momentum_ratio is None or momentum_ratio < 1.0
    ):
        return "vote_filter_weak_swing_momentum"
    return None


def atr_momentum_ratio(values: list[float | None], index: int) -> float | None:
    """Current ATR divided by its established sweep ATR baseline."""
    start = index - SWEEP_ATR_SMA_PERIOD + 1
    if start < 0 or values[index] is None:
        return None
    window = values[start:index + 1]
    if any(value is None for value in window):
        return None
    baseline = sum(float(value) for value in window) / SWEEP_ATR_SMA_PERIOD
    return float(values[index]) / baseline if baseline > 0 else None


def close_profitable_weak_campaigns(
    wallet: Wallet,
    timestamp: int,
    marks: dict[str, float],
    momentum: dict[str, float | None],
    campaign_grades: dict[str, str],
    events: list[dict],
    entry_bar_ms: int = 15 * 60 * 1000,
) -> None:
    """Recycle weak/faded campaigns only when the whole campaign is net green."""
    campaign_ids = {position.order.campaign_id for position in open_positions(wallet)}
    for campaign_id in campaign_ids:
        opened = [
            position for position in open_positions(wallet)
            if position.order.campaign_id == campaign_id
        ]
        if not opened:
            continue
        symbol = opened[0].order.symbol
        age_bars = min((timestamp - position.opened_ts) // entry_bar_ms for position in opened)
        if age_bars < 3:
            continue
        grade = campaign_grades.get(campaign_id, "C")
        ratio = momentum.get(symbol)
        weak = grade in {"C", "D"}
        faded = ratio is not None and ratio < 1.0
        if not (weak or faded):
            continue
        closed_net = sum(
            position.net_pnl for position in wallet.positions
            if position.order.campaign_id == campaign_id and position.state == "closed"
        )
        exit_net = sum(projected_close_net(position, marks[symbol]) for position in opened)
        if closed_net + exit_net <= 0:
            continue
        reason = "weak_grade_profit" if weak else "momentum_fade_profit"
        for position in list(opened):
            close_position(wallet, position, timestamp, marks[symbol], reason, events)
        for order in list(pending_orders(wallet)):
            if order.campaign_id == campaign_id:
                order.state = "cancelled_profit_recycle"
                append_event(
                    events, timestamp, "cancel", wallet=wallet.name,
                    campaign_id=campaign_id, signal_id=order.signal_id,
                    order_id=order.order_id, strategy=order.strategy,
                    symbol=order.symbol, side=order.side, rung=order.rung,
                    reason=reason,
                )


def unwind_symbol(
    wallet: Wallet,
    symbol: str,
    timestamp: int,
    mark: float,
    events: list[dict],
    reason: str = "environment_changed_unwind",
    preserve_campaign_ids: set[str] | None = None,
) -> None:
    """Close and cancel the current symbol inventory before reassessing it."""
    preserved = preserve_campaign_ids or set()
    for position in list(open_positions(wallet)):
        if (
            position.order.symbol == symbol
            and position.order.campaign_id not in preserved
        ):
            close_position(
                wallet, position, timestamp, mark, reason, events,
            )
    for order in list(pending_orders(wallet)):
        if order.symbol == symbol and order.campaign_id not in preserved:
            order.state = f"cancelled_{reason}"
            append_event(
                events, timestamp, "cancel", wallet=wallet.name,
                campaign_id=order.campaign_id, signal_id=order.signal_id,
                order_id=order.order_id, strategy=order.strategy,
                symbol=order.symbol, side=order.side, rung=order.rung,
                reason=reason,
            )


def make_exposure_matched_hedge(
    sequence: int,
    signal_id: str,
    symbol: str,
    side: str,
    timestamp: int,
    entry: float,
    requested_notional: float,
    available_collateral: float,
    strategy: str = "environment_change",
) -> Order | None:
    """Create one hedge leg, limited only by its wallet's actual collateral."""
    leverage = APEX_LEVERAGE[symbol]
    max_notional = max(0.0, available_collateral) / (1 / leverage + FEE_RATE)
    notional = min(requested_notional, max_notional)
    if notional <= 0:
        return None
    campaign_id = f"C{sequence:06d}"
    return Order(
        order_id=f"{campaign_id}-O01", campaign_id=campaign_id,
        signal_id=signal_id, wallet="hedge", strategy=strategy,
        symbol=symbol, side=side, rung=1, slice_fraction=1.0,
        target_roi=0.0, created_ts=timestamp, entry=entry,
        target=float("nan"), notional=notional, qty=notional / entry,
        initial_margin=notional / leverage,
    )


def pre_entry_hedge_exit(
    state: PreEntryHedgeState,
    candle: list,
    unpaired: bool = True,
) -> tuple[float, str] | None:
    """Evaluate the owner's virtual-rung hedge trail without lookahead.

    The hedge opens at the signal price and never takes profit merely because
    the core entry pairs at virtual rung four. Once paired, the normal ladder
    trails two 0.5% steps behind the deepest completed-bar favorable move.
    The expanded ladder uses the same rule after step five. Unpaired adverse
    movement records a resize request; sizing and recovery exits are left to
    the caller because no resize allocation has been specified.
    """
    entry = state.signal_price
    prior_deepest = state.deepest_favorable_step
    arm_step = EXPANDED_CORE_ENTRY_STEP if state.dynamic_trailing else 3
    if state.core_side == "long":
        favorable_move = max(0.0, entry - float(candle[LOW]))
        adverse_move = max(0.0, float(candle[HIGH]) - entry)
        if prior_deepest >= arm_step:
            exit_step = prior_deepest - EXPANDED_HEDGE_TRAIL_STEPS
            trail = entry * (1 - exit_step * RUNG_STEP)
            if float(candle[HIGH]) >= trail:
                return trail, f"pre_entry_hedge_trail_step_{exit_step}"
    else:
        favorable_move = max(0.0, float(candle[HIGH]) - entry)
        adverse_move = max(0.0, entry - float(candle[LOW]))
        if prior_deepest >= arm_step:
            exit_step = prior_deepest - EXPANDED_HEDGE_TRAIL_STEPS
            trail = entry * (1 + exit_step * RUNG_STEP)
            if float(candle[LOW]) <= trail:
                return trail, f"pre_entry_hedge_trail_step_{exit_step}"

    reached = int(favorable_move / (entry * RUNG_STEP) + 1e-9)
    state.deepest_favorable_step = max(prior_deepest, reached)
    if unpaired:
        adverse_step = int(adverse_move / (entry * RUNG_STEP) + 1e-9)
        state.max_unpaired_adverse_step = max(
            state.max_unpaired_adverse_step, adverse_step,
        )
        state.unpaired_resize_needed = state.max_unpaired_adverse_step >= 1
    return None


def manage_pre_entry_hedges(
    states: dict[str, PreEntryHedgeState],
    wallets: dict[str, Wallet],
    campaign_history: dict[str, CoordinatedCampaign],
    timestamp: int,
    candles: dict[str, list],
    marks: dict[str, float],
    events: list[dict],
    environment_by_symbol: dict[str, tuple[str, str, str]] | None = None,
    adaptive_unpaired_hedge: bool = False,
    resize_fraction: float = UNPAIRED_HEDGE_DEFAULT_RESIZE_FRACTION,
    max_resizes: int = 1,
    recovery_bars: int = UNPAIRED_HEDGE_DEFAULT_RECOVERY_BARS,
    recovery_roi: float = UNPAIRED_HEDGE_DEFAULT_RECOVERY_ROI,
    bar_ms: int = 15 * 60 * 1000,
) -> None:
    """Maintain each hedge independently after its core lifecycle changes."""
    for symbol, state in list(states.items()):
        hedge_positions = [
            position for position in open_positions(wallets["hedge"])
            if position.order.campaign_id == state.hedge_campaign_id
        ]
        if not hedge_positions:
            del states[symbol]
            continue
        core_filled = any(
            position.order.campaign_id == state.core_campaign_id
            for name in ("long", "short")
            for position in open_positions(wallets[name])
        )
        state.core_was_filled = state.core_was_filled or core_filled
        prior_adverse_step = state.max_unpaired_adverse_step
        exit_result = pre_entry_hedge_exit(
            state, candles[symbol], unpaired=not state.core_was_filled,
        )
        if state.max_unpaired_adverse_step > prior_adverse_step:
            append_event(
                events, timestamp, "pre_entry_hedge_resize_requested",
                wallet="hedge", campaign_id=state.hedge_campaign_id,
                symbol=symbol, side=hedge_positions[0].order.side,
                adverse_step=state.max_unpaired_adverse_step,
                status="awaiting_resize_rule",
            )
        environment = (
            environment_by_symbol.get(symbol)
            if environment_by_symbol else None
        )
        hedge_side = hedge_positions[0].order.side
        hedge_votes = (
            timeframe_alignment_votes(hedge_side, *environment)
            if environment else 0
        )
        core_votes = (
            timeframe_alignment_votes(state.core_side, *environment)
            if environment else 0
        )
        if (
            adaptive_unpaired_hedge
            and not state.core_was_filled
            and state.unpaired_resize_needed
            and state.resize_count < max_resizes
            and state.max_unpaired_adverse_step > state.last_resize_adverse_step
        ):
            leverage = APEX_LEVERAGE[symbol]
            campaign_positions = [
                position for position in open_positions(wallets["hedge"])
                if position.order.campaign_id == state.hedge_campaign_id
            ]
            campaign_margin = sum(
                position.order.initial_margin for position in campaign_positions
            )
            initial = campaign_positions[0].order
            remaining_margin = max(
                0.0,
                WALLET_START * UNPAIRED_HEDGE_MAX_MARGIN_PCT - campaign_margin,
            )
            requested_notional = initial.notional * resize_fraction
            resize_notional = min(
                requested_notional, remaining_margin * leverage,
            )
            if resize_notional > 0:
                resize_order = Order(
                    order_id=(
                        f"{state.hedge_campaign_id}-R{state.resize_count + 1:02d}"
                    ),
                    campaign_id=state.hedge_campaign_id,
                    signal_id=initial.signal_id,
                    wallet="hedge",
                    strategy="adaptive_unpaired_pre_entry_hedge",
                    symbol=symbol,
                    side=hedge_side,
                    rung=state.max_unpaired_adverse_step + 1,
                    slice_fraction=1.0,
                    target_roi=0.0,
                    created_ts=timestamp,
                    entry=marks[symbol],
                    target=float("nan"),
                    notional=resize_notional,
                    qty=resize_notional / marks[symbol],
                    initial_margin=resize_notional / leverage,
                )
                if place_campaign(
                    wallets["hedge"], [resize_order], timestamp, marks, events,
                ):
                    state.resize_count += 1
                    state.last_resize_adverse_step = (
                        state.max_unpaired_adverse_step
                    )
                    state.first_resize_ts = state.first_resize_ts or timestamp
                    append_event(
                        events, timestamp, "pre_entry_hedge_resized",
                        wallet="hedge", campaign_id=state.hedge_campaign_id,
                        symbol=symbol, side=hedge_side,
                        adverse_step=state.max_unpaired_adverse_step,
                        resize_count=state.resize_count,
                        resize_notional=resize_notional,
                        resize_margin=resize_notional / leverage,
                        campaign_margin_after=(
                            campaign_margin + resize_notional / leverage
                        ),
                    )
        if adaptive_unpaired_hedge and not state.core_was_filled:
            campaign_positions = [
                position for position in open_positions(wallets["hedge"])
                if position.order.campaign_id == state.hedge_campaign_id
            ]
            projected_net = sum(
                projected_close_net(position, marks[symbol])
                for position in campaign_positions
            )
            campaign_margin = sum(
                position.order.initial_margin for position in campaign_positions
            )
            recovery_target = campaign_margin * recovery_roi
            if (
                state.resize_count > 0
                and hedge_votes < 2
                and projected_net >= recovery_target
            ):
                exit_result = (
                    marks[symbol], "pre_entry_hedge_unpaired_recovery_profit"
                )
            elif (
                state.first_resize_ts is not None
                and timestamp - state.first_resize_ts >= recovery_bars * bar_ms
                and core_votes >= 2
                and hedge_votes < 2
            ):
                exit_result = (
                    marks[symbol], "pre_entry_hedge_unpaired_environment_exit"
                )
        if exit_result is None:
            continue
        exit_price, reason = exit_result
        close_campaign(
            wallets["hedge"], state.hedge_campaign_id,
            timestamp, {**marks, symbol: exit_price}, reason, events,
        )
        if not state.core_was_filled:
            for name in ("long", "short"):
                cancel_campaign_pending(
                    wallets[name], state.core_campaign_id, timestamp,
                    "pre_entry_hedge_resolved_without_core", events,
                )
            core_state = campaign_history.get(state.core_campaign_id)
            if core_state:
                core_state.status = "pre_entry_hedge_resolved_without_core"
        hedge_state = campaign_history.get(state.hedge_campaign_id)
        if hedge_state:
            hedge_state.status = reason
        del states[symbol]


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = sorted({key for row in rows for key in row})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def liquidity_sweep_signals_for_15m(
    candles_5m: list[list], target_start_ms: int,
) -> tuple[list[list], dict[int, object]]:
    """Canonical liquidity-sweep detector evaluated on completed 15m bars."""
    candles_15m = _aggregate_15m(candles_5m)
    atr = atr_series(candles_15m)
    signals: dict[int, object] = {}
    warmup = max(60, SWEEP_ATR_SMA_PERIOD * 2)
    for index in range(warmup, len(candles_15m)):
        timestamp = int(candles_15m[index][TS])
        if timestamp < target_start_ms:
            continue
        history_start = max(0, index - 600)
        signal = detect_sweep(
            candles_15m[history_start:index + 1],
            atr[history_start:index + 1], "none", 0.0,
        )
        if signal is not None:
            signals[timestamp] = signal
    return candles_15m, signals


def break_retest_signals_for_15m(
    candles_5m: list[list], target_start_ms: int,
) -> tuple[list[list], dict[int, BreakRetestSignal]]:
    """Detect each confirmed 15m structural break and retest once."""
    candles_15m = _aggregate_15m(candles_5m)
    signals: dict[int, BreakRetestSignal] = {}
    for direction in ("long", "short"):
        result = accumulator_signal.evaluate(candles_15m, direction, 0.0)
        for retest in result["entries"]:
            if retest.retest_index is None or retest.retest_ts is None:
                continue
            timestamp = int(retest.retest_ts)
            if timestamp < target_start_ms:
                continue
            candle = candles_15m[int(retest.retest_index)]
            signals[timestamp] = BreakRetestSignal(
                direction=direction,
                entry=float(candle[CLOSE]),
                mode="break_retest",
                level_source="confirmed_structure_zone",
                invalidation_price=float(
                    retest.break_event.zone.lower
                    if direction == "long"
                    else retest.break_event.zone.upper
                ),
            )
    return candles_15m, signals


def signal_invalidation_price(
    signal: object,
    sweep_stop_buffer_atr: float = 0.0,
) -> float | None:
    """Return structural invalidation for either tested entry family."""
    value = getattr(signal, "invalidation_price", None)
    if value is None:
        value = getattr(signal, "stop", None)
        atr = getattr(signal, "atr_at_entry", None)
        direction = getattr(signal, "direction", None)
        if (
            value is not None
            and atr is not None
            and sweep_stop_buffer_atr > 0
        ):
            value = float(value) + (
                -1 if direction == "long" else 1
            ) * sweep_stop_buffer_atr * float(atr)
    return float(value) if value is not None else None


def bos_state_series(candles: list[list]) -> list[str]:
    """Compute the latest completed BOS state at every HTF bar once."""
    events: list[tuple[int, int, str]] = []
    for direction in ("long", "short"):
        result = accumulator_signal.evaluate(candles, direction, 0.0)
        for event in result["breaks"]:
            events.append((
                int(event.break_ts), int(event.break_index),
                "bullish_bos" if direction == "long" else "bearish_bos",
            ))
    events.sort(key=lambda item: (item[0], item[1]))
    states = ["none"] * len(candles)
    current = "none"
    event_index = 0
    for candle_index in range(len(candles)):
        while event_index < len(events) and events[event_index][1] <= candle_index:
            current = events[event_index][2]
            event_index += 1
        if candle_index + 1 >= MIN_HTF_CANDLES_FOR_BOS:
            states[candle_index] = current
    return states


def hunter_plans_for_entry_bars(
    entry_candles: list[list],
) -> dict[int, dict[str, hunter_entry.HunterEntry]]:
    """Precompute the unchanged Hunter FVG/retrace rule in one linear pass."""
    fvgs = hunter_entry.hunter_signal.find_fvgs(
        entry_candles, hunter_entry.K_THRESHOLD,
    )
    by_direction = {
        "long": [f for f in fvgs if f.direction == "bullish"],
        "short": [f for f in fvgs if f.direction == "bearish"],
    }
    confirm_indexes = {
        direction: [f.confirm_index for f in candidates]
        for direction, candidates in by_direction.items()
    }
    plans: dict[int, dict[str, hunter_entry.HunterEntry]] = {}
    for newest_idx, newest in enumerate(entry_candles):
        for direction, candidates in by_direction.items():
            indexes = confirm_indexes[direction]
            start = bisect_left(
                indexes, newest_idx - hunter_entry.RETRACE_WINDOW,
            )
            end = bisect_left(indexes, newest_idx)
            eligible = candidates[start:end]
            if not eligible:
                continue
            picked = None
            entry_raw = 0.0
            for fvg in reversed(eligible):
                if direction == "long" and float(newest[LOW]) <= fvg.gap_upper:
                    picked = fvg
                    entry_raw = min(fvg.gap_upper, float(newest[OPEN]))
                    break
                if direction == "short" and float(newest[HIGH]) >= fvg.gap_lower:
                    picked = fvg
                    entry_raw = max(fvg.gap_lower, float(newest[OPEN]))
                    break
            if picked is None:
                continue
            stop = picked.gap_lower if direction == "long" else picked.gap_upper
            if (direction == "long" and stop >= entry_raw) or (
                direction == "short" and stop <= entry_raw
            ):
                continue
            distance = abs(entry_raw - stop)
            plan = hunter_entry.HunterEntry(
                direction=direction,
                fill_px=float(entry_raw),
                stop_level=float(stop),
                tp_level=(
                    entry_raw + distance if direction == "long"
                    else entry_raw - distance
                ),
                fvg_confirm_ts=int(picked.confirm_ts),
                gap_lower=float(picked.gap_lower),
                gap_upper=float(picked.gap_upper),
                ratio=float(picked.ratio),
                stop_pct=distance / entry_raw if entry_raw else 0.0,
            )
            plans.setdefault(int(newest[TS]), {})[direction] = plan
    return plans


def run(
    raw: dict[str, list[list]],
    output_dir: Path = OUTPUT_DIR,
    cleanup_1_2: bool = False,
    graded_all_signals: bool = False,
    coordinated_lifecycle: bool = False,
    target_start_ms: int = TARGET_START_MS,
    strict_aligned_rules: bool = False,
    entry_signal: str = "liquidity_sweep",
    sweep_stop_buffer_atr: float = DEFAULT_SWEEP_STOP_BUFFER_ATR,
    long_quality_gate: bool = False,
    long_stage_three_after_three_spaces: bool = False,
    short_stage_three_after_three_spaces: bool = False,
    pre_entry_ladder_hedge: bool = False,
    eight_rung_dynamic_hedge: bool = False,
    eth_five_rung_five_percent: bool = False,
    eth_strict_opposite_hedge: bool = False,
    include_strategy: bool = True,
    core_wallet_filter: str | None = None,
    campaign_margin_pct: float | None = None,
    apply_every_sweep: bool = False,
    three_timeframe_vote: bool = False,
    vote_quality_filter: bool = True,
    staged_entry_steps: int = 3,
    enter_all_rungs_at_alert: bool = False,
    continuous_core_hedge: bool = False,
    core_tp_slices: tuple[tuple[float, float], ...] = TP_SLICES,
    trail_remainder_after_first_target: bool = False,
    trailing_distance_roi: float = 0.50,
    exit_short_on_alignment_loss: bool = False,
    entry_signal_by_symbol: dict[str, str] | None = None,
    automatic_hedge_enabled: bool = True,
    adaptive_unpaired_hedge: bool = True,
    unpaired_resize_fraction: float = UNPAIRED_HEDGE_DEFAULT_RESIZE_FRACTION,
    unpaired_max_resizes: int = 1,
    unpaired_recovery_bars: int = UNPAIRED_HEDGE_DEFAULT_RECOVERY_BARS,
    unpaired_recovery_roi: float = UNPAIRED_HEDGE_DEFAULT_RECOVERY_ROI,
) -> dict:
    if coordinated_lifecycle:
        graded_all_signals = True
    if entry_signal not in {"break_retest", "liquidity_sweep"}:
        raise ValueError(
            "entry_signal must be 'break_retest' or 'liquidity_sweep'"
        )
    if entry_signal_by_symbol and any(
        value not in {"break_retest", "liquidity_sweep"}
        for value in entry_signal_by_symbol.values()
    ):
        raise ValueError(
            "entry_signal_by_symbol values must be 'break_retest' or 'liquidity_sweep'"
        )
    if sweep_stop_buffer_atr < 0:
        raise ValueError("sweep_stop_buffer_atr must be non-negative")
    if core_wallet_filter not in {None, "long", "short"}:
        raise ValueError("core_wallet_filter must be None, 'long', or 'short'")
    if campaign_margin_pct is not None and not 0 < campaign_margin_pct <= 1:
        raise ValueError("campaign_margin_pct must be between 0 and 1")
    if staged_entry_steps < 1:
        raise ValueError("staged_entry_steps must be positive")
    if not core_tp_slices or not all(
        fraction > 0 and roi > 0 for fraction, roi in core_tp_slices
    ) or abs(sum(fraction for fraction, _ in core_tp_slices) - 1.0) > 1e-9:
        raise ValueError("core_tp_slices must use positive values and total 100%")
    if trailing_distance_roi <= 0:
        raise ValueError("trailing_distance_roi must be positive")
    if unpaired_resize_fraction <= 0:
        raise ValueError("unpaired_resize_fraction must be positive")
    if unpaired_max_resizes < 0:
        raise ValueError("unpaired_max_resizes must be non-negative")
    if unpaired_recovery_bars < 1:
        raise ValueError("unpaired_recovery_bars must be positive")
    if unpaired_recovery_roi < 0:
        raise ValueError("unpaired_recovery_roi must be non-negative")
    dynamic_trailing_hedge = (
        eight_rung_dynamic_hedge or eth_five_rung_five_percent
    )
    eth_five_percent_geometry = (
        eth_five_rung_five_percent or eth_strict_opposite_hedge
    )
    if dynamic_trailing_hedge:
        pre_entry_ladder_hedge = True
    symbols = tuple(raw)
    symbol_entry_signals = {
        symbol: (
            entry_signal_by_symbol.get(symbol, entry_signal)
            if entry_signal_by_symbol else entry_signal
        )
        for symbol in symbols
    }
    entry_bar_ms = 15 * 60 * 1000
    prepared = {
        symbol: (
            liquidity_sweep_signals_for_15m(series, target_start_ms)
            if symbol_entry_signals[symbol] == "liquidity_sweep"
            else break_retest_signals_for_15m(series, target_start_ms)
        )
        for symbol, series in raw.items()
    }
    candles = {symbol: item[0] for symbol, item in prepared.items()}
    sweep_signals = {symbol: item[1] for symbol, item in prepared.items()}
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in candles.items()}
    timeline = sorted({ts for series in rows.values() for ts in series if ts >= target_start_ms})
    wallets = {name: Wallet(name) for name in ("long", "short", "hedge", "strategy")}
    events: list[dict] = []
    signals: list[dict] = []
    equity_rows: list[dict] = []
    environment_rows: list[dict] = []
    campaign_sequence = 0
    signal_sequence = 0
    hunter_seen: set[tuple[str, str, int]] = set()
    campaign_grades: dict[str, str] = {}
    coordinated_campaigns: dict[tuple[str, str, str], CoordinatedCampaign] = {}
    campaign_history: dict[str, CoordinatedCampaign] = {}
    reversals: dict[str, ReversalState] = {}
    pre_entry_hedges: dict[str, PreEntryHedgeState] = {}
    prior_environment: dict[str, tuple[str | None, str, str] | None] = {
        symbol: None for symbol in symbols
    }

    entry_candles = candles
    entry_index = {
        symbol: {int(row[TS]): index for index, row in enumerate(series)}
        for symbol, series in entry_candles.items()
    }
    atr_values = {symbol: atr_series(entry_candles[symbol]) for symbol in symbols}
    one_hour = {symbol: aggregate_1h(raw[symbol]) for symbol in symbols}
    four_hour = {symbol: aggregate_4h(raw[symbol]) for symbol in symbols}
    one_day = {symbol: aggregate_1d(raw[symbol]) for symbol in symbols}
    daily_state_cache: dict[str, dict[int, str]] = {}
    environment_cache: dict[str, dict[int, tuple[str | None, str, str]]] = {}
    hunter_plan_cache = {
        symbol: (
            hunter_plans_for_entry_bars(entry_candles[symbol])
            if include_strategy else {}
        )
        for symbol in symbols
    }
    for symbol in symbols:
        one = one_hour[symbol]
        four = four_hour[symbol]
        daily = one_day[symbol]
        one_regimes = regime_state_series(one)
        one_bos = bos_state_series(one)
        four_bos = bos_state_series(four)
        daily_states = daily_trend_state_series(daily)
        one_closes = [int(row[TS]) + 60 * 60 * 1000 - 1 for row in one]
        four_closes = [int(row[TS]) + 4 * 60 * 60 * 1000 - 1 for row in four]
        daily_closes = [int(row[TS]) + DAY_MS - 1 for row in daily]
        state_by_counts: dict[tuple[int, int], tuple[str | None, str, str]] = {}
        by_ts: dict[int, tuple[str | None, str, str]] = {}
        for row in entry_candles[symbol]:
            timestamp = int(row[TS])
            cutoff = timestamp + entry_bar_ms - 1
            one_count = bisect_right(one_closes, cutoff)
            four_count = bisect_right(four_closes, cutoff)
            key = (one_count, four_count)
            if key not in state_by_counts:
                state_by_counts[key] = (
                    one_regimes[one_count - 1] if one_count else None,
                    one_bos[one_count - 1] if one_count else "none",
                    four_bos[four_count - 1] if four_count else "none",
                )
            by_ts[timestamp] = state_by_counts[key]
        environment_cache[symbol] = by_ts
        daily_state_cache[symbol] = {}
        for row in entry_candles[symbol]:
            timestamp = int(row[TS])
            cutoff = timestamp + entry_bar_ms - 1
            daily_count = bisect_right(daily_closes, cutoff)
            daily_state_cache[symbol][timestamp] = (
                daily_states[daily_count - 1] if daily_count else "none"
            )

    for timestamp in timeline:
        if any(timestamp not in rows[symbol] for symbol in symbols):
            continue
        marks = {symbol: float(rows[symbol][timestamp][CLOSE]) for symbol in symbols}
        momentum = {
            symbol: atr_momentum_ratio(atr_values[symbol], entry_index[symbol][timestamp])
            for symbol in symbols
        }

        candle_snapshot = {
            symbol: rows[symbol][timestamp] for symbol in symbols
        }
        if strict_aligned_rules or three_timeframe_vote:
            # Stop-first is the conservative deterministic rule when a single
            # completed bar touches both a boundary and another pending rung.
            close_structural_invalidations(
                wallets, campaign_history, timestamp, candle_snapshot,
                marks, events,
                preserved_hedge_campaign_ids={
                    state.hedge_campaign_id
                    for state in pre_entry_hedges.values()
                },
            )

        # Pending rung fills and TP exits use this completed candle. If a new
        # position fills on the candle, its TP cannot trigger until a later one.
        for wallet in wallets.values():
            for order in list(pending_orders(wallet)):
                candle = rows[order.symbol][timestamp]
                touched = candle[LOW] <= order.entry if order.side == "long" else candle[HIGH] >= order.entry
                if timestamp > order.created_ts and touched:
                    fill_order(wallet, order, timestamp, order.entry, marks, events)
            for position in list(open_positions(wallet)):
                if timestamp <= position.opened_ts:
                    continue
                candle = rows[position.order.symbol][timestamp]
                if position.order.stop is not None and not (
                    position.trailing_active
                    and position.trailing_armed_ts == timestamp
                ):
                    stop_hit = (
                        candle[LOW] <= position.order.stop
                        if position.order.side == "long"
                        else candle[HIGH] >= position.order.stop
                    )
                    if stop_hit:
                        close_position(
                            wallet, position, timestamp, position.order.stop,
                            (
                                "trailing_stop"
                                if position.trailing_active else
                                "strict_opposite_unpaired_rung_2"
                            ),
                            events,
                        )
                        continue
                hit = candle[HIGH] >= position.order.target if position.order.side == "long" else candle[LOW] <= position.order.target
                if hit:
                    close_position(wallet, position, timestamp, position.order.target, "target", events)
                    if (
                        trail_remainder_after_first_target
                        and wallet.name in {"long", "short"}
                        and position.order.target_roi
                        == min(roi for _, roi in core_tp_slices)
                    ):
                        arm_campaign_trailing_remainder(
                            wallet, position, timestamp,
                            trailing_distance_roi, events,
                        )
                    continue
                if (
                    position.trailing_active
                    and position.trailing_armed_ts is not None
                    and timestamp > position.trailing_armed_ts
                ):
                    prior_stop = position.order.stop
                    if ratchet_trailing_stop(position, candle):
                        append_event(
                            events, timestamp, "trailing_stop_ratchet",
                            wallet=wallet.name,
                            campaign_id=position.order.campaign_id,
                            signal_id=position.order.signal_id,
                            order_id=position.order.order_id,
                            strategy=position.order.strategy,
                            symbol=position.order.symbol,
                            side=position.order.side,
                            rung=position.order.rung,
                            prior_stop=prior_stop,
                            stop=position.order.stop,
                        )
            if graded_all_signals and not (
                (
                    wallet.name == "hedge"
                    and (pre_entry_ladder_hedge or eth_strict_opposite_hedge)
                )
                or (
                    trail_remainder_after_first_target
                    and wallet.name in {"long", "short"}
                )
            ):
                close_profitable_weak_campaigns(
                    wallet, timestamp, marks, momentum, campaign_grades, events,
                    entry_bar_ms,
                )
            cancel_orphan_pending(wallet, timestamp, events)

        if pre_entry_ladder_hedge:
            manage_pre_entry_hedges(
                pre_entry_hedges, wallets, campaign_history, timestamp,
                candle_snapshot, marks, events,
                environment_by_symbol={
                    symbol: (
                        environment_cache[symbol][timestamp][1],
                        environment_cache[symbol][timestamp][2],
                        daily_state_cache[symbol][timestamp],
                    )
                    for symbol in symbols
                },
                adaptive_unpaired_hedge=adaptive_unpaired_hedge,
                resize_fraction=unpaired_resize_fraction,
                max_resizes=unpaired_max_resizes,
                recovery_bars=unpaired_recovery_bars,
                recovery_roi=unpaired_recovery_roi,
                bar_ms=entry_bar_ms,
            )

        if strict_aligned_rules:
            for wallet in wallets.values():
                cross_margin_deleverage(
                    wallet, timestamp, candle_snapshot, events,
                )

        # Exchange-style cross-margin liquidation is evaluated independently
        # per wallet. There is deliberately no portfolio bailout or loss cap.
        for wallet in wallets.values():
            equity = wallet_equity(wallet, marks)
            maintenance = sum(
                p.order.notional * APEX_MMR[p.order.symbol]
                for p in open_positions(wallet)
            )
            if open_positions(wallet) and equity <= maintenance:
                wallet.liquidations += 1
                for position in list(open_positions(wallet)):
                    close_position(wallet, position, timestamp, marks[position.order.symbol], "liquidation", events)
                for order in pending_orders(wallet):
                    order.state = "cancelled_liquidation"
                    append_event(
                        events, timestamp, "cancel", wallet=wallet.name,
                        campaign_id=order.campaign_id, signal_id=order.signal_id,
                        order_id=order.order_id, strategy=order.strategy,
                        symbol=order.symbol, side=order.side, rung=order.rung,
                        reason="liquidation",
                    )

        # Build the complete same-candle candidate batch before admitting any
        # symbol. The old replay processed SYMBOLS in a fixed list order, which
        # meant discovery order—not quality—won scarce portfolio slots.
        cycle_candidates: list[PortfolioCandidate] = []
        for candidate_symbol in symbols:
            candidate_environment = environment_cache[candidate_symbol][timestamp]
            candidate_state_1h = candidate_environment[1]
            candidate_state_4h = candidate_environment[2]
            candidate_momentum = momentum[candidate_symbol]
            candidate_sweep = sweep_signals[candidate_symbol].get(timestamp)
            if candidate_sweep is not None:
                candidate_grade = signal_grade(
                    candidate_sweep.direction,
                    candidate_state_1h,
                    candidate_state_4h,
                )
                if not strict_aligned_rules or candidate_grade == "A":
                    cycle_candidates.append(PortfolioCandidate(
                        symbol=candidate_symbol,
                        wallet=candidate_sweep.direction,
                        side=candidate_sweep.direction,
                        source=(
                            symbol_entry_signals[candidate_symbol]
                        ),
                        grade=candidate_grade,
                        momentum_ratio=candidate_momentum,
                    ))
            for candidate_side in ("long", "short"):
                candidate_plan = hunter_plan_cache[candidate_symbol].get(
                    timestamp, {},
                ).get(candidate_side)
                if candidate_plan is None:
                    continue
                candidate_dedup = (
                    candidate_symbol,
                    candidate_side,
                    candidate_plan.fvg_confirm_ts,
                )
                if candidate_dedup in hunter_seen:
                    continue
                candidate_grade = signal_grade(
                    candidate_side, candidate_state_1h, candidate_state_4h,
                )
                if not strict_aligned_rules or candidate_grade == "A":
                    cycle_candidates.append(PortfolioCandidate(
                        symbol=candidate_symbol,
                        wallet="strategy",
                        side=candidate_side,
                        source="hunter_fvg_retrace",
                        grade=candidate_grade,
                        momentum_ratio=candidate_momentum,
                    ))

        symbol_order, cycle_ranks, cycle_scores = rank_cycle_symbols(
            cycle_candidates, list(symbols),
        )

        for symbol in symbol_order:
            index = entry_index[symbol].get(timestamp)
            if index is None:
                continue
            history = entry_candles[symbol][max(0, index - 600):index + 1]
            regime, state_1h, state_4h = environment_cache[symbol][timestamp]
            environment = (regime, state_1h, state_4h)
            previous = prior_environment[symbol]
            changed = previous is not None and environment != previous
            structure_changed = previous is None or (
                state_1h, state_4h
            ) != (previous[1], previous[2])
            environment_rows.append({
                "timestamp": timestamp, "time_utc": iso(timestamp), "symbol": symbol,
                "regime": regime, "state_1h": state_1h, "state_4h": state_4h,
                "prior_regime": previous[0] if previous else None,
                "prior_state_1h": previous[1] if previous else None,
                "prior_state_4h": previous[2] if previous else None,
                "environment_changed": changed,
            })

            if exit_short_on_alignment_loss and any(
                position.order.symbol == symbol
                for position in open_positions(wallets["short"])
            ):
                short_votes = timeframe_alignment_votes(
                    "short", state_1h, state_4h,
                    daily_state_cache[symbol][timestamp],
                )
                if short_votes < 2:
                    unwind_symbol(
                        wallets["short"], symbol, timestamp, marks[symbol],
                        events, reason="short_two_of_three_alignment_lost",
                    )

            if strict_aligned_rules and structure_changed:
                # Existing core inventory may ride through a 1h pullback, but
                # exits as soon as its dominant 4h thesis is no longer valid.
                if state_4h != "bullish_bos":
                    unwind_symbol(
                        wallets["long"], symbol, timestamp, marks[symbol], events,
                        reason="four_hour_long_thesis_lost",
                    )
                if state_4h != "bearish_bos":
                    unwind_symbol(
                        wallets["short"], symbol, timestamp, marks[symbol], events,
                        reason="four_hour_short_thesis_lost",
                    )

                opportunity_wallets = ("long", "short", "strategy")
                long_exposure = sum(
                    p.order.notional
                    for name in opportunity_wallets
                    for p in open_positions(wallets[name])
                    if p.order.symbol == symbol and p.order.side == "long"
                )
                short_exposure = sum(
                    p.order.notional
                    for name in opportunity_wallets
                    for p in open_positions(wallets[name])
                    if p.order.symbol == symbol and p.order.side == "short"
                )
                core_side = (
                    "long" if long_exposure > short_exposure
                    else "short" if short_exposure > long_exposure else None
                )
                hedge_positions = [] if (
                    pre_entry_ladder_hedge or eth_strict_opposite_hedge
                ) else [
                    p for p in open_positions(wallets["hedge"])
                    if p.order.symbol == symbol
                ]
                protective_reversal = (
                    False if (
                        pre_entry_ladder_hedge or eth_strict_opposite_hedge
                    ) else
                    is_confirmed_protective_reversal(
                        core_side, state_1h, state_4h,
                    )
                )
                protected_positions = [
                    p
                    for name in opportunity_wallets
                    for p in open_positions(wallets[name])
                    if p.order.symbol == symbol and p.order.side == core_side
                ]
                protected_net = sum(
                    projected_close_net(p, marks[symbol])
                    for p in protected_positions
                )
                if protective_reversal and protected_net <= 0:
                    for name in opportunity_wallets:
                        unwind_symbol(
                            wallets[name], symbol, timestamp, marks[symbol], events,
                            reason="adverse_1h_losing_trade_exit",
                        )
                    unwind_symbol(
                        wallets["hedge"], symbol, timestamp, marks[symbol], events,
                        reason="underlying_bad_trade_exit",
                    )
                    protective_reversal = False
                if hedge_positions and not protective_reversal:
                    unwind_symbol(
                        wallets["hedge"], symbol, timestamp, marks[symbol], events,
                        reason="protective_condition_cleared",
                    )
                elif protective_reversal and not hedge_positions:
                    requested = abs(long_exposure - short_exposure)
                    if requested > 0:
                        signal_sequence += 1
                        signal_id = f"S{signal_sequence:06d}"
                        hedge_side = "short" if core_side == "long" else "long"
                        campaign_sequence += 1
                        hedge_order = make_exposure_matched_hedge(
                            campaign_sequence, signal_id, symbol, hedge_side,
                            timestamp, marks[symbol], requested,
                            free_collateral(wallets["hedge"], marks),
                            strategy="confirmed_1h_protection",
                        )
                        hedge_row = {
                            "signal_id": signal_id, "timestamp": timestamp,
                            "time_utc": iso(timestamp), "symbol": symbol,
                            "source": "protective_1h_reversal",
                            "wallet": "hedge", "side": hedge_side,
                            "entry": marks[symbol], "regime": regime,
                            "state_1h": state_1h, "state_4h": state_4h,
                            "requested_notional": requested,
                        }
                        signals.append(hedge_row)
                        if hedge_order is None:
                            hedge_row["outcome"] = "collateral_exhausted"
                        else:
                            campaign_grades[hedge_order.campaign_id] = "A"
                            accepted = place_campaign(
                                wallets["hedge"], [hedge_order], timestamp,
                                marks, events,
                            )
                            hedge_row["outcome"] = (
                                "hedge_opened" if accepted
                                else "collateral_exhausted"
                            )

            if continuous_core_hedge:
                long_notional = sum(
                    position.order.notional
                    for position in open_positions(wallets["long"])
                    if position.order.symbol == symbol
                )
                short_notional = sum(
                    position.order.notional
                    for position in open_positions(wallets["short"])
                    if position.order.symbol == symbol
                )
                net_core = long_notional - short_notional
                core_side = (
                    "long" if net_core > 0 else
                    "short" if net_core < 0 else None
                )
                protection = core_protection_state(
                    core_side, state_1h, state_4h,
                )
                hedge_positions = [
                    position for position in open_positions(wallets["hedge"])
                    if position.order.symbol == symbol
                    and position.order.strategy == "continuous_core_protection"
                ]
                if protection == "confirmed_reversal":
                    signal_sequence += 1
                    signal_id = f"S{signal_sequence:06d}"
                    signals.append({
                        "signal_id": signal_id, "timestamp": timestamp,
                        "time_utc": iso(timestamp), "symbol": symbol,
                        "source": "confirmed_core_reversal",
                        "wallet": core_side, "side": core_side,
                        "entry": marks[symbol], "regime": regime,
                        "state_1h": state_1h, "state_4h": state_4h,
                        "state_1d": daily_state_cache[symbol][timestamp],
                        "core_net_notional": net_core,
                        "outcome": "core_and_hedge_closed",
                    })
                    unwind_symbol(
                        wallets[core_side], symbol, timestamp, marks[symbol],
                        events, reason="confirmed_higher_timeframe_reversal",
                    )
                    unwind_symbol(
                        wallets["hedge"], symbol, timestamp, marks[symbol],
                        events, reason="protected_core_reversal_exit",
                    )
                elif protection == "protect":
                    expected_side = "short" if core_side == "long" else "long"
                    matching_notional = sum(
                        position.order.notional for position in hedge_positions
                        if position.order.side == expected_side
                    )
                    requested = abs(net_core)
                    if matching_notional < requested - 1e-9:
                        if hedge_positions:
                            unwind_symbol(
                                wallets["hedge"], symbol, timestamp,
                                marks[symbol], events,
                                reason="protective_hedge_resize",
                            )
                        signal_sequence += 1
                        signal_id = f"S{signal_sequence:06d}"
                        campaign_sequence += 1
                        order = make_exposure_matched_hedge(
                            campaign_sequence, signal_id, symbol,
                            expected_side, timestamp, marks[symbol], requested,
                            free_collateral(wallets["hedge"], marks),
                            strategy="continuous_core_protection",
                        )
                        signal_row = {
                            "signal_id": signal_id, "timestamp": timestamp,
                            "time_utc": iso(timestamp), "symbol": symbol,
                            "source": "protective_1h_reversal",
                            "wallet": "hedge", "side": expected_side,
                            "entry": marks[symbol], "regime": regime,
                            "state_1h": state_1h, "state_4h": state_4h,
                            "state_1d": daily_state_cache[symbol][timestamp],
                            "core_net_notional": net_core,
                            "requested_notional": requested,
                        }
                        signals.append(signal_row)
                        if order is None:
                            signal_row["filled_notional"] = 0.0
                            signal_row["outcome"] = "collateral_exhausted"
                        else:
                            campaign_grades[order.campaign_id] = "A"
                            accepted = place_campaign(
                                wallets["hedge"], [order], timestamp,
                                marks, events,
                            )
                            signal_row["filled_notional"] = (
                                order.notional if accepted else 0.0
                            )
                            signal_row["outcome"] = (
                                "hedge_opened" if accepted
                                else "collateral_exhausted"
                            )
                elif hedge_positions:
                    unwind_symbol(
                        wallets["hedge"], symbol, timestamp, marks[symbol],
                        events, reason=(
                            "protected_core_closed" if protection == "flat"
                            else "protective_condition_cleared"
                        ),
                    )

            # Core: every confirmed entry is routed solely by its direction.
            sweep = sweep_signals[symbol].get(timestamp)
            if sweep is not None:
                pre_signal_net = sum(
                    p.order.notional for p in open_positions(wallets["long"])
                    if p.order.symbol == symbol
                ) - sum(
                    p.order.notional for p in open_positions(wallets["short"])
                    if p.order.symbol == symbol
                )
                signal_sequence += 1
                signal_id = f"S{signal_sequence:06d}"
                wallet_name = sweep.direction
                core_strategy = (
                    symbol_entry_signals[symbol]
                )
                grade = signal_grade(sweep.direction, state_1h, state_4h)
                state_1d = daily_state_cache[symbol][timestamp]
                alignment_votes = timeframe_alignment_votes(
                    sweep.direction, state_1h, state_4h, state_1d,
                )
                signal_row = {
                    "signal_id": signal_id, "timestamp": timestamp,
                    "time_utc": iso(timestamp), "symbol": symbol,
                    "source": core_strategy, "wallet": wallet_name,
                    "side": sweep.direction, "entry": float(sweep.entry),
                    "regime": regime, "state_1h": state_1h,
                    "state_4h": state_4h, "mode": sweep.mode,
                    "state_1d": state_1d,
                    "alignment_votes": alignment_votes,
                    "level_source": sweep.level_source,
                    "grade": grade, "momentum_ratio": momentum[symbol],
                    "cycle_rank": cycle_ranks.get(symbol),
                    "cycle_score": cycle_scores.get(symbol),
                }
                signals.append(signal_row)
                if core_wallet_filter and wallet_name != core_wallet_filter:
                    signal_row["outcome"] = "filtered_wallet_isolation"
                    continue
                opposing_state = (
                    "bearish_bos" if sweep.direction == "long"
                    else "bullish_bos"
                )
                opposite_strict_bias = (
                    state_1h == opposing_state
                    and state_4h == opposing_state
                )
                if eth_strict_opposite_hedge and opposite_strict_bias:
                    existing_hedge = any(
                        position.order.symbol == symbol
                        for position in open_positions(wallets["hedge"])
                    )
                    if not existing_hedge:
                        requested = WALLET_START * 0.05 * APEX_LEVERAGE[symbol]
                        campaign_sequence += 1
                        hedge_order = make_exposure_matched_hedge(
                            campaign_sequence, signal_id, symbol,
                            sweep.direction, timestamp, marks[symbol], requested,
                            free_collateral(wallets["hedge"], marks),
                            strategy="strict_opposite_two_step_hedge",
                        )
                        if hedge_order is not None:
                            target_sign = 1 if sweep.direction == "long" else -1
                            hedge_order.target = marks[symbol] * (
                                1 + target_sign * 2 * RUNG_STEP
                            )
                            hedge_order.stop = marks[symbol] * (
                                1 - target_sign * RUNG_STEP
                            )
                            hedge_order.target_roi = (
                                2 * RUNG_STEP * APEX_LEVERAGE[symbol]
                            )
                            hedge_accepted = place_campaign(
                                wallets["hedge"], [hedge_order], timestamp,
                                marks, events,
                            )
                            if hedge_accepted:
                                signal_row["hedge_action"] = (
                                    "strict_opposite_two_step_hedge"
                                )
                                signal_row["hedge_requested_notional"] = requested
                                signal_row["hedge_filled_notional"] = (
                                    hedge_order.notional
                                )
                if three_timeframe_vote and alignment_votes < 2:
                    signal_row["outcome"] = "filtered_two_of_three_alignment"
                    signal_row["eligibility"] = (
                        "requires sweep direction to match at least two of 1h, 4h, and 1d"
                    )
                elif strict_aligned_rules and grade != "A":
                    signal_row["outcome"] = "filtered_htf_misalignment"
                    signal_row["eligibility"] = (
                        "requires exact 1h and 4h directional agreement"
                    )
                elif coordinated_lifecycle:
                    key = (wallet_name, symbol, sweep.direction)
                    current = coordinated_campaigns.get(key)
                    if current and not campaign_is_active(
                        wallets[current.wallet], current.campaign_id,
                    ):
                        current.status = "completed"
                        current = None

                    opposite_side = "short" if sweep.direction == "long" else "long"
                    opposite = coordinated_campaigns.get((
                        opposite_side, symbol, opposite_side,
                    ))
                    if opposite and not campaign_is_active(
                        wallets[opposite.wallet], opposite.campaign_id,
                    ):
                        opposite.status = "completed"
                        opposite = None

                    reversal = (
                        None if (
                            pre_entry_ladder_hedge
                            or continuous_core_hedge
                            or not automatic_hedge_enabled
                        )
                        else reversals.get(symbol)
                    )
                    if (
                        pre_entry_ladder_hedge
                        or continuous_core_hedge
                        or not automatic_hedge_enabled
                    ):
                        opposite = None
                    if grade == "A" and reversal and sweep.direction == reversal.new_side:
                        reversal.confirmations += 1
                        old = coordinated_campaigns.get((
                            reversal.old_side, symbol, reversal.old_side,
                        ))
                        if old and campaign_is_active(wallets[old.wallet], old.campaign_id):
                            close_campaign(
                                wallets[old.wallet], old.campaign_id, timestamp,
                                marks, "persistent_reversal_core_exit", events,
                            )
                            old.status = "reversed"
                        if reversal.hedge_campaign_id:
                            close_campaign(
                                wallets["hedge"], reversal.hedge_campaign_id,
                                timestamp, marks,
                                "persistent_reversal_hedge_exit", events,
                            )
                            hedge_state = campaign_history.get(
                                reversal.hedge_campaign_id,
                            )
                            if hedge_state:
                                hedge_state.status = "persistent_reversal_closed"
                        signal_row["hedge_action"] = "persistent_reversal_completed"
                        signal_row["reversal_confirmations"] = reversal.confirmations
                        del reversals[symbol]
                    elif grade == "A" and reversal and sweep.direction == reversal.old_side:
                        failed = coordinated_campaigns.get((
                            reversal.new_side, symbol, reversal.new_side,
                        ))
                        if failed and campaign_is_active(
                            wallets[failed.wallet], failed.campaign_id,
                        ):
                            close_campaign(
                                wallets[failed.wallet], failed.campaign_id,
                                timestamp, marks,
                                "reversal_invalidated_new_core_exit", events,
                            )
                            failed.status = "reversal_invalidated"
                        if reversal.hedge_campaign_id:
                            close_campaign(
                                wallets["hedge"], reversal.hedge_campaign_id,
                                timestamp, marks,
                                "reversal_invalidated_hedge_exit", events,
                            )
                            hedge_state = campaign_history.get(
                                reversal.hedge_campaign_id,
                            )
                            if hedge_state:
                                hedge_state.status = "reversal_invalidated"
                        original = coordinated_campaigns.get((
                            reversal.old_side, symbol, reversal.old_side,
                        ))
                        if original and campaign_is_active(
                            wallets[original.wallet], original.campaign_id,
                        ):
                            original.frozen = False
                            original.status = "active"
                            current = original
                        signal_row["hedge_action"] = "reversal_invalidated"
                        del reversals[symbol]
                    elif grade == "A" and opposite and not opposite.frozen:
                        opposite.frozen = True
                        opposite.status = "frozen_reversal"
                        cancel_campaign_pending(
                            wallets[opposite.wallet], opposite.campaign_id,
                            timestamp, "clear_reversal_freeze", events,
                        )
                        requested = campaign_open_notional(
                            wallets[opposite.wallet], opposite.campaign_id,
                        )
                        available = free_collateral(wallets["hedge"], marks)
                        hedge_campaign_id = None
                        hedge_filled = 0.0
                        if requested > 0:
                            campaign_sequence += 1
                            hedge_order = make_exposure_matched_hedge(
                                campaign_sequence, signal_id, symbol,
                                sweep.direction, timestamp, marks[symbol],
                                requested, available, strategy="clear_reversal",
                            )
                            if hedge_order is not None:
                                campaign_grades[hedge_order.campaign_id] = "A"
                                if place_campaign(
                                    wallets["hedge"], [hedge_order], timestamp,
                                    marks, events,
                                ):
                                    hedge_campaign_id = hedge_order.campaign_id
                                    hedge_filled = hedge_order.notional
                                    campaign_history[hedge_campaign_id] = CoordinatedCampaign(
                                        campaign_id=hedge_campaign_id,
                                        symbol=symbol, side=sweep.direction,
                                        wallet="hedge", grade="A",
                                    )
                        reversals[symbol] = ReversalState(
                            symbol=symbol, old_side=opposite.side,
                            new_side=sweep.direction,
                            hedge_campaign_id=hedge_campaign_id,
                            first_ts=timestamp,
                        )
                        signal_row["hedge_action"] = "clear_reversal_started"
                        signal_row["hedge_requested_notional"] = requested
                        signal_row["hedge_filled_notional"] = hedge_filled
                        signal_row["hedge_ratio"] = (
                            hedge_filled / requested if requested else 0.0
                        )

                    if current is None:
                        campaign_sequence += 1
                        all_orders = make_campaign(
                            campaign_sequence, signal_id, wallet_name, core_strategy,
                            symbol, sweep.direction, timestamp, float(sweep.entry),
                            rung_count=(
                                EXPANDED_RUNG_COUNT
                                if eight_rung_dynamic_hedge else RUNG_COUNT
                            ),
                            margin_per_rung=(
                                WALLET_START * campaign_margin_pct / RUNG_COUNT
                                if campaign_margin_pct is not None else
                                WALLET_START * 0.05 / 5
                                if eth_five_percent_geometry else RUNG_MARGIN
                            ),
                            tp_slices=core_tp_slices,
                        )
                        planned_orders = (
                            stage_all_rungs_at_alert(all_orders)
                            if enter_all_rungs_at_alert else
                            stage_five_rungs_after_five_steps(all_orders)
                            if (
                                dynamic_trailing_hedge
                                or eth_strict_opposite_hedge
                            )
                            else stage_three_rungs_after_three_spaces(
                                all_orders, staged_entry_steps,
                            )
                            if (
                                long_stage_three_after_three_spaces
                                and wallet_name == "long"
                            ) or (
                                short_stage_three_after_three_spaces
                                and wallet_name == "short"
                            )
                            else all_orders
                        )
                        invalidation_price = (
                            None if eth_five_percent_geometry or apply_every_sweep
                            else signal_invalidation_price(
                                sweep, sweep_stop_buffer_atr,
                            )
                        )
                        if eth_five_percent_geometry or apply_every_sweep:
                            orders = planned_orders
                            geometry = {
                                "eligible_rungs": 5,
                                "net_reward": None,
                                "invalidation_loss": None,
                                "reward_risk": None,
                            }
                        else:
                            geometry = campaign_reward_risk(
                                planned_orders, invalidation_price,
                            )
                            orders = orders_before_invalidation(
                                planned_orders, invalidation_price,
                            )
                        signal_row.update({
                            "planned_rungs": ",".join(str(rung) for rung in sorted({
                                order.rung for order in planned_orders
                            })),
                            "eligible_rungs": geometry["eligible_rungs"],
                            "net_reward": geometry["net_reward"],
                            "invalidation_loss": geometry["invalidation_loss"],
                            "reward_risk": geometry["reward_risk"],
                            "orders_clipped_at_invalidation": (
                                len(planned_orders) - len(orders)
                            ),
                        })
                        fresh_score = candidate_score(
                            grade, momentum[symbol],
                        )
                        fresh_cost = sum(
                            order.notional * (FEE_RATE + SLIPPAGE_RATE)
                            for order in orders[:3]
                        )
                        if entry_boundary_broken(
                            sweep.direction, rows[symbol][timestamp],
                            invalidation_price,
                        ):
                            admitted = False
                            rotated_campaign = "entry_boundary_already_broken"
                        elif not orders:
                            admitted = False
                            rotated_campaign = "no_orders_before_invalidation"
                        elif three_timeframe_vote and vote_quality_filter:
                            rotated_campaign = sweep_vote_quality_rejection(
                                sweep.level_source, sweep.mode, momentum[symbol],
                            )
                            admitted = rotated_campaign is None
                        elif (
                            long_quality_gate
                            and wallet_name == "long"
                            and not eth_five_percent_geometry
                        ):
                            rotated_campaign = long_entry_quality_rejection(
                                sweep.level_source,
                                geometry["reward_risk"],
                                sweep.mode,
                                momentum[symbol],
                                int(geometry["eligible_rungs"]),
                            )
                            admitted = rotated_campaign is None
                        else:
                            admitted, rotated_campaign = admit_opportunity(
                                wallets, campaign_history, timestamp, symbol,
                                fresh_score, fresh_cost, marks, momentum, events,
                            )
                        if not admitted:
                            signal_row["outcome"] = rotated_campaign
                        else:
                            campaign_grades[orders[0].campaign_id] = grade
                            staged_core = (
                                not enter_all_rungs_at_alert
                                and (
                                    dynamic_trailing_hedge
                                    or eth_strict_opposite_hedge
                                    or (
                                        long_stage_three_after_three_spaces
                                        and wallet_name == "long"
                                    )
                                    or (
                                        short_stage_three_after_three_spaces
                                        and wallet_name == "short"
                                    )
                                )
                            )
                            accepted = place_campaign(
                                wallets[wallet_name], orders, timestamp, marks,
                                events, fill_initial=not staged_core,
                            )
                            signal_row["outcome"] = (
                                "campaign_placed" if accepted else "collateral_exhausted"
                            )
                            if accepted:
                                current = CoordinatedCampaign(
                                    campaign_id=orders[0].campaign_id, symbol=symbol,
                                    side=sweep.direction, wallet=wallet_name,
                                    grade=grade, created_ts=timestamp,
                                    invalidation_price=invalidation_price,
                                    entry_score=fresh_score,
                                )
                                coordinated_campaigns[key] = current
                                campaign_history[current.campaign_id] = current
                                signal_row["coordinated_campaign_id"] = current.campaign_id
                                if rotated_campaign:
                                    signal_row["rotated_campaign_id"] = rotated_campaign
                                if (
                                    pre_entry_ladder_hedge
                                    and staged_core
                                    and symbol not in pre_entry_hedges
                                ):
                                    requested = sum(
                                        order.notional for order in orders
                                        if order.rung <= (
                                            5 if dynamic_trailing_hedge else 3
                                        )
                                    )
                                    campaign_sequence += 1
                                    hedge_side = (
                                        "short" if sweep.direction == "long"
                                        else "long"
                                    )
                                    hedge_order = make_exposure_matched_hedge(
                                        campaign_sequence, signal_id, symbol,
                                        hedge_side, timestamp, marks[symbol],
                                        requested,
                                        free_collateral(wallets["hedge"], marks),
                                        strategy="pre_entry_ladder_hedge",
                                    )
                                    signal_row["hedge_action"] = "pre_entry_ladder"
                                    signal_row["hedge_requested_notional"] = requested
                                    if hedge_order is None:
                                        signal_row["hedge_filled_notional"] = 0.0
                                    else:
                                        campaign_grades[hedge_order.campaign_id] = "A"
                                        hedge_accepted = place_campaign(
                                            wallets["hedge"], [hedge_order],
                                            timestamp, marks, events,
                                        )
                                        filled = (
                                            hedge_order.notional
                                            if hedge_accepted else 0.0
                                        )
                                        signal_row["hedge_filled_notional"] = filled
                                        if hedge_accepted:
                                            campaign_history[
                                                hedge_order.campaign_id
                                            ] = CoordinatedCampaign(
                                                campaign_id=hedge_order.campaign_id,
                                                symbol=symbol, side=hedge_side,
                                                wallet="hedge", grade="A",
                                                created_ts=timestamp,
                                            )
                                            pre_entry_hedges[symbol] = (
                                                PreEntryHedgeState(
                                                    symbol=symbol,
                                                    core_campaign_id=current.campaign_id,
                                                    core_side=sweep.direction,
                                                    hedge_campaign_id=hedge_order.campaign_id,
                                                    signal_price=marks[symbol],
                                                    dynamic_trailing=(
                                                        dynamic_trailing_hedge
                                                    ),
                                                )
                                            )
                    else:
                        current.confirmations += 1
                        signal_row["coordinated_campaign_id"] = current.campaign_id
                        signal_row["confirmation_count"] = current.confirmations
                        stronger = GRADE_RANK[grade] > GRADE_RANK[current.grade]
                        if stronger and not current.frozen:
                            prior_grade = current.grade
                            current.grade = grade
                            campaign_grades[current.campaign_id] = grade
                            signal_row["prior_grade"] = prior_grade
                            signal_row["outcome"] = "campaign_grade_upgraded_no_size"
                        else:
                            signal_row["outcome"] = "campaign_confirmed_no_size"
                            signal_row["confirmation_reason"] = (
                                "campaign_frozen" if current.frozen
                                else "grade_not_stronger"
                            )
                        append_event(
                            events, timestamp, "signal_coordinated",
                            wallet=wallet_name, signal_id=signal_id,
                            campaign_id=current.campaign_id, strategy=core_strategy,
                            symbol=symbol, side=sweep.direction,
                            grade=grade, campaign_grade=current.grade,
                            confirmations=current.confirmations,
                            frozen=current.frozen,
                            reason=signal_row["outcome"],
                        )
                else:
                    existing = (
                        active_campaign_id(
                            wallets[wallet_name], symbol, sweep.direction,
                        )
                        if cleanup_1_2 and not graded_all_signals else None
                    )
                    if existing is not None:
                        signal_row["outcome"] = "coordinated_existing_campaign"
                        signal_row["coordinated_campaign_id"] = existing
                        append_event(
                            events, timestamp, "signal_coordinated",
                            wallet=wallet_name, signal_id=signal_id,
                            campaign_id=existing, strategy=core_strategy, symbol=symbol,
                            side=sweep.direction, reason="duplicate_exposure_removed",
                        )
                    else:
                        campaign_sequence += 1
                        orders = make_campaign(
                            campaign_sequence, signal_id, wallet_name, core_strategy, symbol,
                            sweep.direction, timestamp, float(sweep.entry),
                        )
                        campaign_grades[orders[0].campaign_id] = grade
                        accepted = place_campaign(
                            wallets[wallet_name], orders, timestamp, marks, events,
                        )
                        signal_row["outcome"] = (
                            "campaign_placed" if accepted else "collateral_exhausted"
                        )

                    # A hedge is exceptional: only a fully aligned, opposite-direction
                    # reversal may activate it. Ordinary environment changes do nothing.
                    reversal_side = "short" if pre_signal_net > 0 else "long" if pre_signal_net < 0 else None
                    if graded_all_signals and grade == "A" and sweep.direction == reversal_side:
                        unwind_symbol(
                            wallets["hedge"], symbol, timestamp, marks[symbol], events,
                            reason="clear_reversal_refresh",
                        )
                        available = free_collateral(wallets["hedge"], marks)
                        campaign_sequence += 1
                        hedge_order = make_exposure_matched_hedge(
                            campaign_sequence, signal_id, symbol, sweep.direction,
                            timestamp, marks[symbol], abs(pre_signal_net), available,
                            strategy="clear_reversal",
                        )
                        signal_row["hedge_action"] = "clear_reversal"
                        signal_row["hedge_requested_notional"] = abs(pre_signal_net)
                        if hedge_order is None:
                            signal_row["hedge_filled_notional"] = 0.0
                            signal_row["hedge_ratio"] = 0.0
                        else:
                            campaign_grades[hedge_order.campaign_id] = "A"
                            hedge_accepted = place_campaign(
                                wallets["hedge"], [hedge_order], timestamp, marks, events,
                            )
                            hedge_filled = hedge_order.notional if hedge_accepted else 0.0
                            signal_row["hedge_filled_notional"] = hedge_filled
                            signal_row["hedge_ratio"] = hedge_filled / abs(pre_signal_net)

            # Strategy: existing Hunter definition already combines volatility,
            # a fair-value gap and its retrace. Both directions are evaluated.
            for side in ("long", "short"):
                plan = hunter_plan_cache[symbol].get(timestamp, {}).get(side)
                reason = "confirmed" if plan is not None else "hunter_no_retest"
                if plan is None or reason != "confirmed":
                    continue
                dedup = (symbol, side, plan.fvg_confirm_ts)
                if dedup in hunter_seen:
                    continue
                hunter_seen.add(dedup)
                signal_sequence += 1
                signal_id = f"S{signal_sequence:06d}"
                signal_row = {
                    "signal_id": signal_id, "timestamp": timestamp,
                    "time_utc": iso(timestamp), "symbol": symbol,
                    "source": "hunter_fvg_retrace", "wallet": "strategy",
                    "side": side, "entry": plan.fill_px, "regime": regime,
                    "state_1h": state_1h, "state_4h": state_4h,
                    "fvg_confirm_ts": plan.fvg_confirm_ts,
                    "gap_lower": plan.gap_lower, "gap_upper": plan.gap_upper,
                    "atr_ratio": plan.ratio,
                    "grade": signal_grade(side, state_1h, state_4h),
                    "momentum_ratio": momentum[symbol],
                    "cycle_rank": cycle_ranks.get(symbol),
                    "cycle_score": cycle_scores.get(symbol),
                }
                signals.append(signal_row)
                if strict_aligned_rules and signal_row["grade"] != "A":
                    signal_row["outcome"] = "filtered_htf_misalignment"
                    continue
                if coordinated_lifecycle:
                    key = ("strategy", symbol, side)
                    current = coordinated_campaigns.get(key)
                    if current and not campaign_is_active(
                        wallets["strategy"], current.campaign_id,
                    ):
                        current.status = "completed"
                        current = None
                    if current is None:
                        if strict_aligned_rules and (
                            used_margin(wallets["strategy"])
                            + reserved_margin(wallets["strategy"])
                            + RUNG_MARGIN * RUNG_COUNT
                            > WALLET_START * 0.15
                        ):
                            signal_row["outcome"] = "strategy_allocation_cap"
                            signal_row["allocation_cap_pct"] = 15.0
                            continue
                        campaign_sequence += 1
                        all_orders = make_campaign(
                            campaign_sequence, signal_id, "strategy", "hunter",
                            symbol, side, timestamp, plan.fill_px,
                        )
                        geometry = campaign_reward_risk(
                            all_orders, float(plan.stop_level),
                        )
                        orders = orders_before_invalidation(
                            all_orders, float(plan.stop_level),
                        )
                        signal_row.update({
                            "eligible_rungs": geometry["eligible_rungs"],
                            "net_reward": geometry["net_reward"],
                            "invalidation_loss": geometry["invalidation_loss"],
                            "reward_risk": geometry["reward_risk"],
                            "orders_clipped_at_invalidation": (
                                len(all_orders) - len(orders)
                            ),
                        })
                        fresh_score = candidate_score(
                            signal_row["grade"], momentum[symbol],
                        )
                        fresh_cost = sum(
                            order.notional * (FEE_RATE + SLIPPAGE_RATE)
                            for order in orders[:3]
                        )
                        if entry_boundary_broken(
                            side, rows[symbol][timestamp],
                            float(plan.stop_level), reject_touch=True,
                        ):
                            admitted = False
                            rotated_campaign = "entry_boundary_already_broken"
                        elif not orders:
                            admitted = False
                            rotated_campaign = "no_orders_before_invalidation"
                        else:
                            admitted, rotated_campaign = admit_opportunity(
                                wallets, campaign_history, timestamp, symbol,
                                fresh_score, fresh_cost, marks, momentum, events,
                            )
                        if not admitted:
                            signal_row["outcome"] = rotated_campaign
                            continue
                        campaign_grades[orders[0].campaign_id] = signal_row["grade"]
                        accepted = place_campaign(
                            wallets["strategy"], orders, timestamp, marks, events,
                        )
                        signal_row["outcome"] = (
                            "campaign_placed" if accepted else "collateral_exhausted"
                        )
                        if accepted:
                            current = CoordinatedCampaign(
                                campaign_id=orders[0].campaign_id, symbol=symbol,
                                side=side, wallet="strategy",
                                grade=signal_row["grade"], created_ts=timestamp,
                                invalidation_price=float(plan.stop_level),
                                entry_score=fresh_score,
                            )
                            coordinated_campaigns[key] = current
                            campaign_history[current.campaign_id] = current
                            signal_row["coordinated_campaign_id"] = current.campaign_id
                            if rotated_campaign:
                                signal_row["rotated_campaign_id"] = rotated_campaign
                    else:
                        current.confirmations += 1
                        signal_row["coordinated_campaign_id"] = current.campaign_id
                        signal_row["confirmation_count"] = current.confirmations
                        stronger = (
                            GRADE_RANK[signal_row["grade"]]
                            > GRADE_RANK[current.grade]
                        )
                        if stronger:
                            prior_grade = current.grade
                            current.grade = signal_row["grade"]
                            campaign_grades[current.campaign_id] = current.grade
                            signal_row["prior_grade"] = prior_grade
                            signal_row["outcome"] = "campaign_grade_upgraded_no_size"
                        else:
                            signal_row["outcome"] = "campaign_confirmed_no_size"
                            signal_row["confirmation_reason"] = "grade_not_stronger"
                else:
                    campaign_sequence += 1
                    orders = make_campaign(
                        campaign_sequence, signal_id, "strategy", "hunter", symbol,
                        side, timestamp, plan.fill_px,
                    )
                    campaign_grades[orders[0].campaign_id] = signal_row["grade"]
                    accepted = place_campaign(wallets["strategy"], orders, timestamp, marks, events)
                    signal_row["outcome"] = "campaign_placed" if accepted else "collateral_exhausted"

            # Hedge: raw mode preserves the original campaign. Cleanup mode
            # closes the prior hedge and matches current net core exposure.
            if changed:
                if graded_all_signals:
                    signal_sequence += 1
                    signal_id = f"S{signal_sequence:06d}"
                    signals.append({
                        "signal_id": signal_id, "timestamp": timestamp,
                        "time_utc": iso(timestamp), "symbol": symbol,
                        "source": "environment_change", "wallet": "hedge",
                        "side": None, "entry": marks[symbol], "regime": regime,
                        "state_1h": state_1h, "state_4h": state_4h,
                        "prior_regime": previous[0] if previous else None,
                        "prior_state_1h": previous[1] if previous else None,
                        "prior_state_4h": previous[2] if previous else None,
                        "outcome": "observed_only_no_automatic_hedge",
                    })
                    prior_environment[symbol] = environment
                    continue
                if cleanup_1_2:
                    unwind_symbol(
                        wallets["hedge"], symbol, timestamp, marks[symbol], events,
                    )
                long_notional = sum(
                    p.order.notional for p in open_positions(wallets["long"])
                    if p.order.symbol == symbol
                )
                short_notional = sum(
                    p.order.notional for p in open_positions(wallets["short"])
                    if p.order.symbol == symbol
                )
                net = long_notional - short_notional
                signal_sequence += 1
                signal_id = f"S{signal_sequence:06d}"
                side = "short" if net > 0 else "long" if net < 0 else None
                signal_row = {
                    "signal_id": signal_id, "timestamp": timestamp,
                    "time_utc": iso(timestamp), "symbol": symbol,
                    "source": "environment_change", "wallet": "hedge",
                    "side": side, "entry": marks[symbol], "regime": regime,
                    "state_1h": state_1h, "state_4h": state_4h,
                    "prior_regime": previous[0] if previous else None,
                    "prior_state_1h": previous[1] if previous else None,
                    "prior_state_4h": previous[2] if previous else None,
                    "core_net_notional": net,
                }
                signals.append(signal_row)
                if cleanup_1_2 and regime == "neutral":
                    signal_row["outcome"] = "hedge_unwound_neutral"
                elif side is None:
                    signal_row["outcome"] = "no_core_exposure"
                elif cleanup_1_2:
                    available = free_collateral(wallets["hedge"], marks)
                    campaign_sequence += 1
                    order = make_exposure_matched_hedge(
                        campaign_sequence, signal_id, symbol, side, timestamp,
                        marks[symbol], abs(net), available,
                    )
                    signal_row["requested_notional"] = abs(net)
                    signal_row["available_collateral"] = available
                    if order is None:
                        signal_row["filled_notional"] = 0.0
                        signal_row["hedge_ratio"] = 0.0
                        signal_row["outcome"] = "collateral_exhausted"
                    else:
                        accepted = place_campaign(
                            wallets["hedge"], [order], timestamp, marks, events,
                        )
                        filled = order.notional if accepted else 0.0
                        signal_row["filled_notional"] = filled
                        signal_row["hedge_ratio"] = filled / abs(net)
                        signal_row["outcome"] = (
                            "hedge_opened" if accepted and filled >= abs(net) - 1e-9
                            else "partial_hedge" if accepted
                            else "collateral_exhausted"
                        )
                else:
                    campaign_sequence += 1
                    orders = make_campaign(
                        campaign_sequence, signal_id, "hedge", "environment_change",
                        symbol, side, timestamp, marks[symbol],
                    )
                    accepted = place_campaign(wallets["hedge"], orders, timestamp, marks, events)
                    signal_row["outcome"] = "campaign_placed" if accepted else "collateral_exhausted"
            prior_environment[symbol] = environment

        portfolio_equity = 0.0
        wallet_snapshots = []
        for wallet in wallets.values():
            opened = open_positions(wallet)
            pending = pending_orders(wallet)
            equity = wallet.cash + sum(
                position_pnl(position, marks[position.order.symbol])
                for position in opened
            )
            used = sum(position.order.initial_margin for position in opened)
            reserved = sum(order.initial_margin for order in pending)
            available = equity - used - reserved
            wallet.peak_equity = max(wallet.peak_equity, equity)
            wallet.max_drawdown = max(wallet.max_drawdown, wallet.peak_equity - equity)
            portfolio_equity += equity
            snapshot = {
                "timestamp": timestamp, "time_utc": iso(timestamp),
                "wallet": wallet.name, "cash": wallet.cash, "equity": equity,
                "used_initial_margin": used,
                "reserved_initial_margin": reserved,
                "free_collateral": available,
                "open_positions": len(opened),
                "pending_orders": len(pending),
            }
            equity_rows.append(snapshot)
            wallet_snapshots.append(snapshot)
        equity_rows.append({
            "timestamp": timestamp, "time_utc": iso(timestamp),
            "wallet": "combined", "cash": sum(w.cash for w in wallets.values()),
            "equity": portfolio_equity,
            "used_initial_margin": sum(row["used_initial_margin"] for row in wallet_snapshots),
            "reserved_initial_margin": sum(row["reserved_initial_margin"] for row in wallet_snapshots),
            "free_collateral": sum(row["free_collateral"] for row in wallet_snapshots),
            "open_positions": sum(row["open_positions"] for row in wallet_snapshots),
            "pending_orders": sum(row["pending_orders"] for row in wallet_snapshots),
        })

    final_marks = {symbol: float(candles[symbol][-1][CLOSE]) for symbol in symbols}
    wallet_summary = {}
    for name, wallet in wallets.items():
        ending = wallet_equity(wallet, final_marks)
        realized_net = sum(
            position.net_pnl for position in wallet.positions
            if position.state == "closed"
        )
        open_net = sum(
            position_pnl(position, final_marks[position.order.symbol]) - position.entry_fee
            for position in open_positions(wallet)
        )
        wallet_summary[name] = {
            "starting_equity": WALLET_START,
            "ending_equity": ending,
            "net_pnl": ending - WALLET_START,
            "realized_net_pnl": realized_net,
            "open_mark_net_pnl": open_net,
            "fees": wallet.fees,
            "max_drawdown": wallet.max_drawdown,
            "liquidations": wallet.liquidations,
            "orders": len(wallet.orders),
            "fills": sum(order.state == "filled" for order in wallet.orders),
            "closed_slices": sum(p.state == "closed" for p in wallet.positions),
            "open_slices": len(open_positions(wallet)),
            "pending_orders": len(pending_orders(wallet)),
            "margin_rejected_orders": sum("margin_rejected" in order.state for order in wallet.orders),
        }

    combined_ending = sum(item["ending_equity"] for item in wallet_summary.values())
    combined_curve = [row for row in equity_rows if row["wallet"] == "combined"]
    peak = WALLET_START * 4
    max_dd = 0.0
    for row in combined_curve:
        peak = max(peak, float(row["equity"]))
        max_dd = max(max_dd, peak - float(row["equity"]))

    # Preserve source candles at their actual grain; execution is aggregated to 15m.
    raw_rows = []
    for symbol, series in raw.items():
        for row in series:
            raw_rows.append({
                "symbol": symbol, "timestamp": int(row[TS]),
                "time_utc": iso(int(row[TS])), "open": row[OPEN],
                "high": row[HIGH], "low": row[LOW], "close": row[CLOSE],
                "volume": row[5],
            })

    quality = {
        symbol: {
            "rows_5m": len(series),
            "duplicate_timestamps": len(series) - len({int(row[TS]) for row in series}),
            "missing_5m_intervals": sum(
                int(right[TS]) - int(left[TS]) != 5 * 60 * 1000
                for left, right in zip(series, series[1:])
            ),
            "misaligned_timestamps": sum(
                int(row[TS]) % (5 * 60 * 1000) != 0 for row in series
            ),
            "start_utc": iso(int(series[0][TS])),
            "end_utc": iso(int(series[-1][TS])),
            "non_positive_prices": sum(
                any(float(row[index]) <= 0 for index in (OPEN, HIGH, LOW, CLOSE))
                for row in series
            ),
            "invalid_ohlc": sum(
                not (
                    float(row[LOW]) <= float(row[OPEN]) <= float(row[HIGH])
                    and float(row[LOW]) <= float(row[CLOSE]) <= float(row[HIGH])
                )
                for row in series
            ),
        }
        for symbol, series in raw.items()
    }
    configured_campaign_margin = (
        WALLET_START * campaign_margin_pct
        if campaign_margin_pct is not None else RUNG_MARGIN * RUNG_COUNT
    )
    configured_rung_margin = configured_campaign_margin / RUNG_COUNT
    configured_core_initial_size = (
        f"one ${configured_campaign_margin:,.2f} campaign with {RUNG_COUNT} "
        f"${configured_rung_margin:,.2f} rungs entering together at the alert"
        if enter_all_rungs_at_alert else
        f"one ${configured_campaign_margin:,.2f} campaign with {RUNG_COUNT} "
        f"pre-authorized ${configured_rung_margin:,.2f} rungs at 0.5% intervals"
    )

    summary = {
        "scope": {
            "symbols": list(symbols), "symbol_count": len(symbols),
            "target_start_utc": iso(target_start_ms),
            "target_end_utc": iso(max(timeline)),
            "entry_timeframe": "15m",
            "entry_signal": (
                symbol_entry_signals if entry_signal_by_symbol else entry_signal
            ),
            "htf_entry_gate": (
                "exact 1h and 4h BOS agreement with direction"
                if strict_aligned_rules else "graded after detection"
            ),
            "wallet_rules": {
                "long": "new entries require bullish 1h + bullish 4h; exit when bullish 4h thesis is lost",
                "short": "new entries require bearish 1h + bearish 4h; exit when bearish 4h thesis is lost",
                "hedge": (
                    "no pre-Hedge on strict entries; a 15m sweep opposite a mutually aligned 1h/4h bias opens a $125 Hedge targeting two favorable 0.5% steps, with an unpaired adverse boundary at the next 0.5% step"
                    if eth_strict_opposite_hedge else
                    "five-rung opposite exposure opens at the signal and trails two 0.5% steps behind the deepest favorable move after step 5; an unpaired adverse move requests resizing instead of forcing a loss sale"
                    if dynamic_trailing_hedge else
                    "opposite exposure opens before the staged core; rung 4 pairs rather than exits, then the Hedge trails two rungs behind its deepest favorable completed-bar move; an unpaired adverse move requests resizing"
                    if pre_entry_ladder_hedge else
                    "inverse exposure only during confirmed 1h opposition while the core 4h thesis remains intact"
                ),
                "strategy": (
                    "disabled for the ETH core-and-Hedge isolation replay"
                    if not include_strategy else
                    "Hunter FVG/retrace opportunities in either direction; reserved plus used initial margin capped at 15% of its wallet"
                ),
            } if strict_aligned_rules else None,
            "wallet_start": WALLET_START, "combined_start": WALLET_START * 4,
            "margin_mode": "four separate cross-margin pools; one event coordinator",
            "risk_caps": (
                "cross-margin deleverage at 2x maintenance using adverse 15m extremes"
                if strict_aligned_rules else "none"
            ),
            "stop_losses": (
                "special opposite Hedge uses a 0.5% unpaired adverse boundary; core uses the account-level cross-margin guard"
                if eth_strict_opposite_hedge else
                "account-level cross-margin guard; no isolated-position stop"
            ),
            "funding": "not modeled; no historical funding series in this dataset",
            "fee_rate_per_fill": FEE_RATE, "slippage_rate_per_fill": SLIPPAGE_RATE,
            "cleanup_1_2": cleanup_1_2,
            "graded_all_signals": graded_all_signals,
            "coordinated_lifecycle": coordinated_lifecycle,
            "candidate_selection": (
                "whole 15m cycle ranked before five-symbol admission"
                if coordinated_lifecycle else "source discovery order"
            ),
            "structural_lifecycle": (
                "ETH core waits at step 5 without the obsolete pre-entry sweep-stop clip; 4h thesis and cross-margin lifecycle govern exits"
                if eth_five_percent_geometry else
                "boundary-first with invalid rung clipping"
            ),
            "sweep_stop_buffer_atr": sweep_stop_buffer_atr,
            "long_quality_gate": (
                "not applied in the ETH Hedge-first isolation replay"
                if eth_five_percent_geometry else
                "session/prior-day liquidity, or swing liquidity with net reward:risk >= 1; rejection entries require ATR momentum ratio >= 1.05; at least three valid ladder rungs"
                if long_quality_gate else "off"
            ),
            "long_ladder": (
                "eight 0.5% adverse steps cover 4%; five $8 rungs enter together at step 5 and steps 6-8 remain staged"
                if eight_rung_dynamic_hedge else
                "five $25 rungs enter together at adverse step 5 (2.5%); total campaign margin is $125"
                if eth_five_percent_geometry else
                "wait three 0.5% spaces; enter rungs 1-3 together at -1.5%; retain rung 4 at -2.0% and rung 5 at -2.5%"
                if long_stage_three_after_three_spaces
                else "standard five-rung ladder"
            ),
            "short_ladder": (
                "eight 0.5% adverse steps cover 4%; five $8 rungs enter together at step 5 and steps 6-8 remain staged"
                if eight_rung_dynamic_hedge else
                "five $25 rungs enter together at adverse step 5 (2.5%); total campaign margin is $125"
                if eth_five_percent_geometry else
                "wait three 0.5% spaces; enter rungs 1-3 together at +1.5%; retain rung 4 at +2.0% and rung 5 at +2.5%"
                if short_stage_three_after_three_spaces
                else "standard five-rung ladder"
            ),
            "pre_entry_ladder_hedge": pre_entry_ladder_hedge,
            "eight_rung_dynamic_hedge": eight_rung_dynamic_hedge,
            "eth_five_rung_five_percent": eth_five_rung_five_percent,
            "eth_strict_opposite_hedge": eth_strict_opposite_hedge,
            "strategy_enabled": include_strategy,
            "core_wallet_filter": core_wallet_filter,
            "campaign_margin_pct": campaign_margin_pct,
            "apply_every_sweep": apply_every_sweep,
            "three_timeframe_vote": three_timeframe_vote,
            "vote_quality_filter": vote_quality_filter,
            "staged_entry_steps": staged_entry_steps,
            "enter_all_rungs_at_alert": enter_all_rungs_at_alert,
            "continuous_core_hedge": continuous_core_hedge,
            "automatic_hedge_enabled": automatic_hedge_enabled,
            "adaptive_unpaired_hedge": adaptive_unpaired_hedge,
            "unpaired_resize_fraction": (
                unpaired_resize_fraction if adaptive_unpaired_hedge else None
            ),
            "unpaired_max_resizes": (
                unpaired_max_resizes if adaptive_unpaired_hedge else None
            ),
            "unpaired_recovery_bars": (
                unpaired_recovery_bars if adaptive_unpaired_hedge else None
            ),
            "unpaired_recovery_roi": (
                unpaired_recovery_roi if adaptive_unpaired_hedge else None
            ),
            "exit_short_on_alignment_loss": exit_short_on_alignment_loss,
            "core_tp_slices": [
                {"position_fraction": fraction, "target_roi": roi}
                for fraction, roi in core_tp_slices
            ],
            "trail_remainder_after_first_target": trail_remainder_after_first_target,
            "trailing_distance_roi": (
                trailing_distance_roi
                if trail_remainder_after_first_target else None
            ),
            "graded_rules": {
                "A": "1h and 4h BOS align with the signal",
                "B": "one HTF aligns and the other is neutral",
                "C": "both HTFs are neutral",
                "D": "at least one HTF opposes the signal",
                "hedge": (
                    "1h opposition inside the live 4h thesis opens matched protection; mutual 1h/4h opposition closes the core and its Hedge"
                    if continuous_core_hedge else
                    "no pre-Hedge; a 15m sweep opposite a mutually aligned 1h/4h bias opens one $125 Hedge with a two-step target and one-step unpaired adverse boundary"
                    if eth_strict_opposite_hedge else
                    "opposite five-rung notional opens immediately on each admitted staged core signal"
                    if dynamic_trailing_hedge else
                    "opposite three-rung notional opens immediately on each admitted staged core signal"
                    if pre_entry_ladder_hedge else
                    "A-grade signal opposite pre-signal net core exposure only"
                ),
                "weak_exit": "after 3 bars, C/D or ATR ratio below 1; whole campaign must be net profitable after modeled costs",
            } if graded_all_signals else None,
            "coordinated_rules": ({
                "campaign_limit": "one active campaign per wallet, symbol, and direction",
                "initial_size": "five $25 rungs enter together at the alert; total core margin is $125",
                "confirmation": "same-direction signals update the active core without stacking size",
                "hedge_entry": "completed 1h structure opposing the core while completed 4h still supports the core opens an exposure-matched Hedge",
                "confirmed_reversal": "completed 1h and 4h structure both opposing the core closes the core and its associated Hedge",
                "hedge_clear": "if 1h returns to the core direction before 4h reverses, close the Hedge and retain the core",
            } if continuous_core_hedge else {
                "campaign_limit": "one active campaign per wallet, symbol, and direction",
                "initial_size": "one $125 core campaign with five $25 rungs staged together at adverse step 5",
                "confirmation": "same-direction signals update the active core campaign without stacking",
                "hedge_entry": "a 15m sweep opposite a mutually aligned 1h/4h bias opens one $125 Hedge, whether core is filled, pending, or flat",
                "hedge_profit_exit": "two 0.5% steps from the opposite-signal entry",
                "hedge_loss_exit": "the next 0.5% adverse step while unpaired; stop-first if target and boundary occur in the same completed 15m candle",
                "pre_hedge": "disabled",
            } if eth_strict_opposite_hedge else {
                "campaign_limit": "one active campaign per wallet, symbol, and direction",
                "initial_size": (
                    "one $64 core campaign with eight pre-authorized $8 rungs across eight 0.5% adverse steps"
                    if eight_rung_dynamic_hedge else
                    "one $125 core campaign with five $25 rungs staged together at adverse step 5"
                if eth_five_percent_geometry else
                    "one $40 campaign with five pre-authorized $8 rungs at 0.5% intervals"
                ),
                "confirmation": "same-direction signals update the active campaign without a new five-rung stack",
                "size_upgrade": "none; a stronger signal upgrades campaign grade without adding another rung or stack",
                "hedge_entry": (
                    "opposite five-rung ($125 margin) notional at the signal price before core entry at adverse step 5"
                if eth_five_percent_geometry else
                    "opposite five-rung ($40 margin) notional at the signal price before core entry at adverse step 5"
                    if eight_rung_dynamic_hedge else
                    "opposite three-rung notional at the signal price before the staged core entry"
                ),
                "hedge_profit_exit": (
                    "after favorable step 5, trail two completed 0.5% steps behind the deepest favorable step"
                    if dynamic_trailing_hedge else
                    "none at virtual rung 4; pairing activates a two-step trailing exit"
                ),
                "hedge_retrace_exit": (
                    "step 5 sets exit at step 3; step 7 sets exit at step 5; deeper moves continue the same two-step trail"
                    if dynamic_trailing_hedge else
                    "rung 4 sets the first trail at rung 2; every deeper favorable rung ratchets the trail by one rung"
                ),
                "hedge_loss_exit": (
                    "at adverse rung 2, add 50% of the initial Hedge size within a 5% campaign-margin cap; seek a fee-adjusted 5% return on filled margin for two completed 15m bars, then exit only when at least two of 1h/4h/1d still favor the core"
                    if adaptive_unpaired_hedge else
                    "no automatic unpaired loss sale; adverse rung 2 records a resize request"
                ),
            } if pre_entry_ladder_hedge else {
                "campaign_limit": "one active campaign per wallet, symbol, and direction",
                "initial_size": configured_core_initial_size,
                "confirmation": "same-direction signals update the active campaign without a new five-rung stack",
                "size_upgrade": "none; a stronger signal upgrades campaign grade without adding another rung or stack",
                "freeze": "first A-grade opposite configured entry signal freezes the old campaign and cancels its pending entries",
                "persistence": "second A-grade configured entry signal in the new direction closes old core and matched hedge",
                "invalidation": "A-grade return to the old direction closes failed new core and hedge, then unfreezes old core",
            }) if coordinated_lifecycle else None,
        },
        "signals": {
            "total": len(signals),
            "trade_signals": sum(
                row["source"] != "environment_change" for row in signals
            ),
            "trade_signals_processed": sum(
                row["source"] != "environment_change"
                and bool(row.get("outcome"))
                for row in signals
            ),
            "trade_signals_placed": sum(
                row["source"] != "environment_change"
                and row.get("outcome") == "campaign_placed"
                for row in signals
            ),
            "by_source": {
                source: sum(row["source"] == source for row in signals)
                for source in sorted({row["source"] for row in signals})
            },
            "by_outcome": {
                outcome: sum(str(row.get("outcome")) == outcome for row in signals)
                for outcome in sorted({str(row.get("outcome")) for row in signals})
            },
            "by_grade": {
                grade: sum(row.get("grade") == grade for row in signals)
                for grade in ("A", "B", "C", "D")
            },
            "clear_reversal_hedges": sum(
                row.get("hedge_action") in {
                    "clear_reversal", "clear_reversal_started",
                } or row.get("source") == "protective_1h_reversal"
                for row in signals
            ),
            "persistent_reversals_completed": sum(
                row.get("hedge_action") == "persistent_reversal_completed"
                for row in signals
            ),
            "reversals_invalidated": sum(
                row.get("hedge_action") == "reversal_invalidated"
                for row in signals
            ),
        },
        "wallets": wallet_summary,
        "combined": {
            "ending_equity": combined_ending,
            "net_pnl": combined_ending - WALLET_START * 4,
            "return_pct": (combined_ending / (WALLET_START * 4) - 1) * 100,
            "max_drawdown": max_dd,
            "fees": sum(wallet.fees for wallet in wallets.values()),
            "liquidations": sum(wallet.liquidations for wallet in wallets.values()),
            "cross_margin_deleverages": sum(
                row["event"] == "cross_margin_deleverage" for row in events
            ),
        },
        "data_quality": quality,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(output_dir / "candles_5m.csv", raw_rows)
    write_csv(output_dir / "environment_15m.csv", environment_rows)
    write_csv(output_dir / "signals.csv", signals)
    write_csv(output_dir / "events.csv", events)
    write_csv(output_dir / "equity_curve.csv", equity_rows)
    order_rows = []
    for wallet in wallets.values():
        for order in wallet.orders:
            row = asdict(order)
            row["created_utc"] = iso(order.created_ts)
            order_rows.append(row)
    write_csv(output_dir / "orders.csv", order_rows)
    position_rows = []
    for wallet in wallets.values():
        for position in wallet.positions:
            row = {
                **asdict(position.order),
                "fill_entry": position.entry, "fill_qty": position.qty,
                "opened_ts": position.opened_ts, "opened_utc": iso(position.opened_ts),
                "position_state": position.state, "gross_pnl": position.gross_pnl,
                "entry_fee": position.entry_fee, "exit_fee": position.exit_fee,
                "net_pnl": position.net_pnl, "closed_ts": position.closed_ts,
                "closed_utc": iso(position.closed_ts) if position.closed_ts else None,
                "exit_price": position.exit_price, "exit_reason": position.exit_reason,
            }
            position_rows.append(row)
    write_csv(output_dir / "positions.csv", position_rows)
    campaign_rows = []
    for wallet in wallets.values():
        campaign_ids = sorted({order.campaign_id for order in wallet.orders})
        for campaign_id in campaign_ids:
            campaign_orders = [
                order for order in wallet.orders
                if order.campaign_id == campaign_id
            ]
            campaign_positions = [
                position for position in wallet.positions
                if position.order.campaign_id == campaign_id
            ]
            closed = [p for p in campaign_positions if p.state == "closed"]
            opened = [p for p in campaign_positions if p.state == "open"]
            realized_net = sum(p.net_pnl for p in closed)
            open_net = sum(
                position_pnl(p, final_marks[p.order.symbol]) - p.entry_fee
                for p in opened
            )
            state = campaign_history.get(campaign_id)
            active = campaign_is_active(wallet, campaign_id)
            campaign_rows.append({
                "campaign_id": campaign_id,
                "wallet": wallet.name,
                "symbol": campaign_orders[0].symbol,
                "side": campaign_orders[0].side,
                "strategy": campaign_orders[0].strategy,
                "grade": campaign_grades.get(campaign_id),
                "confirmations": state.confirmations if state else 1,
                "size_upgrades": state.size_upgrades if state else 0,
                "frozen": state.frozen if state else False,
                "status": (
                    state.status if state and state.status not in {"active", "frozen_reversal"}
                    else "active" if active
                    else "completed"
                ),
                "orders": len(campaign_orders),
                "fills": len(campaign_positions),
                "closed_slices": len(closed),
                "open_slices": len(opened),
                "realized_net_pnl": realized_net,
                "open_mark_net_pnl": open_net,
                "open_liability": min(0.0, open_net),
                "hedge_recovery": (
                    realized_net + open_net if wallet.name == "hedge" else 0.0
                ),
                "coordinated_net_pnl": realized_net + open_net,
            })
    write_csv(output_dir / "coordinated_campaigns.csv", campaign_rows)

    symbol_coordination_rows = []
    for symbol in symbols:
        parts = {}
        for group, names in {
            "core": {"long", "short"},
            "strategy": {"strategy"},
            "hedge": {"hedge"},
        }.items():
            selected = [
                p for name in names for p in wallets[name].positions
                if p.order.symbol == symbol
            ]
            realized = sum(p.net_pnl for p in selected if p.state == "closed")
            open_net = sum(
                position_pnl(p, final_marks[symbol]) - p.entry_fee
                for p in selected if p.state == "open"
            )
            parts[group] = (realized, open_net)
        total_realized = sum(value[0] for value in parts.values())
        total_open = sum(value[1] for value in parts.values())
        symbol_coordination_rows.append({
            "symbol": symbol,
            "core_realized_net_pnl": parts["core"][0],
            "core_open_mark_net_pnl": parts["core"][1],
            "strategy_realized_net_pnl": parts["strategy"][0],
            "strategy_open_mark_net_pnl": parts["strategy"][1],
            "hedge_realized_net_pnl": parts["hedge"][0],
            "hedge_open_mark_net_pnl": parts["hedge"][1],
            "realized_net_pnl": total_realized,
            "open_liability": min(0.0, total_open),
            "open_mark_net_pnl": total_open,
            "coordinated_net_pnl": total_realized + total_open,
            "reversal_state": (
                f"{reversals[symbol].old_side}_to_{reversals[symbol].new_side}"
                if symbol in reversals else "none"
            ),
        })
    write_csv(
        output_dir / "symbol_coordination_summary.csv",
        symbol_coordination_rows,
    )
    symbol_wallet_rows = []
    for wallet in wallets.values():
        for symbol in symbols:
            selected = [p for p in wallet.positions if p.order.symbol == symbol]
            closed = [p for p in selected if p.state == "closed"]
            opened = [p for p in selected if p.state == "open"]
            realized_net = sum(p.net_pnl for p in closed)
            open_net = sum(
                position_pnl(p, final_marks[symbol]) - p.entry_fee for p in opened
            )
            symbol_wallet_rows.append({
                "wallet": wallet.name, "symbol": symbol,
                "campaigns": len({p.order.campaign_id for p in selected}),
                "fills": len(selected), "closed_slices": len(closed),
                "target_closes": sum(p.exit_reason == "target" for p in closed),
                "liquidation_closes": sum(p.exit_reason == "liquidation" for p in closed),
                "open_slices": len(opened), "realized_net_pnl": realized_net,
                "open_net_pnl": open_net, "total_net_pnl": realized_net + open_net,
                "fees": sum(p.entry_fee + p.exit_fee for p in selected),
            })
    write_csv(output_dir / "symbol_wallet_summary.csv", symbol_wallet_rows)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8",
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cleanup-1-2", action="store_true")
    parser.add_argument("--graded-all-signals", action="store_true")
    parser.add_argument("--coordinated-lifecycle", action="store_true")
    parser.add_argument("--aligned-30d-15m", action="store_true")
    parser.add_argument(
        "--entry-signal",
        choices=("break_retest", "liquidity_sweep"),
        default="liquidity_sweep",
    )
    parser.add_argument(
        "--sweep-stop-buffer-atr", type=float,
        default=DEFAULT_SWEEP_STOP_BUFFER_ATR,
    )
    parser.add_argument("--long-quality-gate", action="store_true")
    parser.add_argument(
        "--long-stage-three-after-three-spaces", action="store_true",
    )
    parser.add_argument(
        "--short-stage-three-after-three-spaces", action="store_true",
    )
    parser.add_argument("--pre-entry-ladder-hedge", action="store_true")
    parser.add_argument("--eight-rung-dynamic-hedge", action="store_true")
    parser.add_argument("--eth-five-rung-five-percent", action="store_true")
    parser.add_argument("--eth-strict-opposite-hedge", action="store_true")
    args = parser.parse_args()
    if sum((
        args.cleanup_1_2,
        args.graded_all_signals,
        args.coordinated_lifecycle,
        args.aligned_30d_15m,
    )) > 1:
        parser.error("choose only one replay mode")
    target_start_ms = TARGET_START_MS
    bars_5m = BARS_5M + WARMUP_5M_BARS
    aligned_30d = args.aligned_30d_15m
    if aligned_30d:
        target_start_ms = FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
        bars_5m = 30 * 288 + max(WARMUP_5M_BARS, 4 * 24 * 12)
    cache = (
        ALIGNED_30D_5M_OUTPUT_DIR / "candles_5m.csv"
        if aligned_30d else OUTPUT_DIR / "candles_5m.csv"
    )
    if cache.exists():
        raw = {symbol: [] for symbol in SYMBOLS}
        with cache.open() as handle:
            for row in csv.DictReader(handle):
                raw[row["symbol"]].append([
                    int(row["timestamp"]), float(row["open"]), float(row["high"]),
                    float(row["low"]), float(row["close"]), float(row["volume"]),
                ])
    elif aligned_30d:
        source_cache = ALIGNED_30D_5M_OUTPUT_DIR / "source_cache"
        source_cache.mkdir(parents=True, exist_ok=True)
        raw = {}
        for symbol in SYMBOLS:
            symbol_cache = source_cache / f"{symbol}.json"
            if symbol_cache.exists():
                raw[symbol] = json.loads(symbol_cache.read_text(encoding="utf-8"))
            else:
                raw[symbol] = fetch_apex(symbol, bars_5m)
                symbol_cache.write_text(
                    json.dumps(raw[symbol]), encoding="utf-8",
                )
    else:
        raw = {symbol: fetch_apex(symbol, bars_5m) for symbol in SYMBOLS}
    if args.eth_five_rung_five_percent or args.eth_strict_opposite_hedge:
        raw = {"ETH-USDT": raw["ETH-USDT"]}
    coordinated_lifecycle = (
        args.coordinated_lifecycle or aligned_30d
    )
    sweep_stop_buffer_atr = max(0.0, args.sweep_stop_buffer_atr)
    output_dir = (
        Path(
            "backtest_artifacts/"
            f"four_wallet_30d_15m_{args.entry_signal}_corrected"
            f"{'_v12_eth_strict_core_opposite_two_step_hedge' if args.eth_strict_opposite_hedge else '_v11_eth_five_rung_five_percent_core_hedge' if args.eth_five_rung_five_percent else '_v10_eight_rung_dynamic_hedge' if args.eight_rung_dynamic_hedge else '_v9_pre_entry_ladder_hedge_unpaired_rung_2' if args.pre_entry_ladder_hedge else '_long_quality_v6_both_stage_three_after_three_spaces' if args.long_stage_three_after_three_spaces and args.short_stage_three_after_three_spaces else '_long_quality_v5_stage_three_after_three_spaces' if args.long_stage_three_after_three_spaces else '_short_v1_stage_three_after_three_spaces' if args.short_stage_three_after_three_spaces else '_long_quality_v4_three_rungs' if args.long_quality_gate else ''}"
        ) if args.aligned_30d_15m
        else COORDINATED_OUTPUT_DIR if args.coordinated_lifecycle
        else GRADED_OUTPUT_DIR if args.graded_all_signals
        else CLEANUP_OUTPUT_DIR if args.cleanup_1_2
        else OUTPUT_DIR
    )
    summary = run(
        raw, output_dir,
        cleanup_1_2=args.cleanup_1_2,
        graded_all_signals=args.graded_all_signals,
        coordinated_lifecycle=coordinated_lifecycle,
        target_start_ms=target_start_ms,
        strict_aligned_rules=aligned_30d,
        entry_signal=args.entry_signal,
        sweep_stop_buffer_atr=sweep_stop_buffer_atr,
        long_quality_gate=args.long_quality_gate,
        long_stage_three_after_three_spaces=(
            args.long_stage_three_after_three_spaces
        ),
        short_stage_three_after_three_spaces=(
            args.short_stage_three_after_three_spaces
        ),
        pre_entry_ladder_hedge=args.pre_entry_ladder_hedge,
        eight_rung_dynamic_hedge=args.eight_rung_dynamic_hedge,
        eth_five_rung_five_percent=args.eth_five_rung_five_percent,
        eth_strict_opposite_hedge=args.eth_strict_opposite_hedge,
        include_strategy=not (
            args.eth_five_rung_five_percent or args.eth_strict_opposite_hedge
        ),
    )
    if aligned_30d and summary["combined"]["liquidations"] != 0:
        raise RuntimeError(
            "30-day aligned replay failed the zero-liquidation invariant"
        )
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
