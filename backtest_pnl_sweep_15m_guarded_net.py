"""Research-only guarded 15m sweep backtest for ApeX-style net positions.

The venue book is modeled as one direction per symbol. Same-direction sweeps
may add a four-rung campaign to that net position; an opposite sweep closes
and reconciles the symbol before a new campaign can open.

No production paper/live execution module imports this file.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

from backtest_pnl_sweep_15m_every_sweep import (
    BARS_5M, CLOSE, FEE_RATE, FIXED_END_SECONDS, HIGH, LEVERAGE, LOW,
    MAINTENANCE_MARGIN_RATE, MARGIN_PER_RUNG, RUNG_COUNT, RUNG_NOTIONAL,
    RUNG_STEP, STARTING_EQUITY, SYMBOLS, TARGET_15M_BARS, TARGET_START_MS,
    TS, WARMUP_5M_BARS, fetch_coinbase, signals_for,
)

BAR_MS = 15 * 60 * 1000
PENDING_TTL_BARS = 8
MAX_HOLD_BARS = 96
MAX_ACTIVE_CAMPAIGNS = 10
MAX_CAMPAIGNS_PER_SYMBOL = 4
MAX_GROSS_LEVERAGE = 10.0
MAINTENANCE_BUFFER_MULTIPLE = 4.0
CAMPAIGN_LOSS_LIMIT = 16.0
PROTECT_AT_MOVE = 0.005
NET_TARGET_PROFIT = 8.0
DAILY_PAUSE_DRAWDOWN = 0.02
DAILY_KILL_DRAWDOWN = 0.05


@dataclass
class Leg:
    entry: float
    qty: float
    target: float
    breakeven: float
    state: str = "pending"
    opened_ts: int | None = None
    protected: bool = False
    entry_fee: float = 0.0
    realized_net: float = 0.0
    close_reason: str = ""


@dataclass
class Campaign:
    campaign_id: int
    symbol: str
    side: str
    signal_ts: int
    invalidation: float
    legs: list[Leg] = field(default_factory=list)
    closes_beyond: int = 0

    @property
    def active(self) -> bool:
        return any(leg.state in {"pending", "open"} for leg in self.legs)


def target_move(side: str) -> float:
    # Solve for exactly $8 net after one entry and one exit fee.
    fee_pair = 2.0 * RUNG_NOTIONAL * FEE_RATE
    denominator = RUNG_NOTIONAL * (1.0 - FEE_RATE if side == "long" else 1.0 + FEE_RATE)
    return (NET_TARGET_PROFIT + fee_pair) / denominator


def breakeven_move(side: str) -> float:
    fee_pair = 2.0 * RUNG_NOTIONAL * FEE_RATE
    denominator = RUNG_NOTIONAL * (1.0 - FEE_RATE if side == "long" else 1.0 + FEE_RATE)
    return fee_pair / denominator


def make_campaign(campaign_id: int, symbol: str, timestamp: int, signal: object) -> Campaign:
    side = signal.direction
    base = float(signal.entry)
    entry_sign = -1.0 if side == "long" else 1.0
    exit_sign = 1.0 if side == "long" else -1.0
    target_delta = target_move(side)
    breakeven_delta = breakeven_move(side)
    legs = []
    for index in range(RUNG_COUNT):
        entry = base * (1.0 + entry_sign * RUNG_STEP * index)
        legs.append(Leg(
            entry=entry,
            qty=RUNG_NOTIONAL / entry,
            target=entry * (1.0 + exit_sign * target_delta),
            breakeven=entry * (1.0 + exit_sign * breakeven_delta),
        ))
    invalidation = base * (1.0 + entry_sign * RUNG_STEP * RUNG_COUNT)
    return Campaign(campaign_id, symbol, side, timestamp, invalidation, legs)


def leg_unrealized(campaign: Campaign, leg: Leg, mark: float) -> float:
    move = mark - leg.entry if campaign.side == "long" else leg.entry - mark
    return move * leg.qty


def campaign_pnl(campaign: Campaign, mark: float) -> float:
    total = sum(leg.realized_net for leg in campaign.legs if leg.state == "closed")
    for leg in campaign.legs:
        if leg.state == "open":
            total += leg_unrealized(campaign, leg, mark) - leg.entry_fee
    return total


def run(raw: dict[str, list[list]]) -> dict:
    prepared = {symbol: signals_for(series) for symbol, series in raw.items()}
    candles = {symbol: item[0] for symbol, item in prepared.items()}
    signals = {symbol: item[1] for symbol, item in prepared.items()}
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in candles.items()}
    timeline = sorted({ts for series in rows.values() for ts in series if ts >= TARGET_START_MS})

    campaigns: list[Campaign] = []
    cash = STARTING_EQUITY
    fees = 0.0
    next_campaign_id = 1
    processed_signals = 0
    opened_campaigns = 0
    same_side_adds = 0
    reversals = 0
    signal_refusals = 0
    rung_risk_cancellations = 0
    daily_pauses = 0
    stale_cancellations = 0
    campaign_loss_exits = 0
    structural_exits = 0
    time_exits = 0
    protected_exits = 0
    liquidated = False
    kill_switch = False
    peak_equity = STARTING_EQUITY
    max_drawdown = 0.0
    max_open_notional = 0.0
    max_active_campaigns = 0
    day_key = None
    day_start_equity = STARTING_EQUITY
    paused_day = None

    def open_legs() -> list[tuple[Campaign, Leg]]:
        return [(campaign, leg) for campaign in campaigns for leg in campaign.legs if leg.state == "open"]

    def current_equity(marks: dict[str, float]) -> float:
        return cash + sum(
            leg_unrealized(campaign, leg, marks[campaign.symbol])
            for campaign, leg in open_legs()
        )

    def close_leg(campaign: Campaign, leg: Leg, price: float, reason: str) -> None:
        nonlocal cash, fees
        gross = ((price - leg.entry) if campaign.side == "long" else (leg.entry - price)) * leg.qty
        exit_fee = price * leg.qty * FEE_RATE
        cash += gross - exit_fee
        fees += exit_fee
        leg.realized_net = gross - leg.entry_fee - exit_fee
        leg.state = "closed"
        leg.close_reason = reason

    def close_symbol(symbol: str, price: float, reason: str) -> None:
        for campaign in campaigns:
            if campaign.symbol != symbol or not campaign.active:
                continue
            for leg in campaign.legs:
                if leg.state == "open":
                    close_leg(campaign, leg, price, reason)
                elif leg.state == "pending":
                    leg.state = "cancelled"
                    leg.close_reason = reason

    for timestamp in timeline:
        marks = {symbol: float(rows[symbol][timestamp][CLOSE]) for symbol in SYMBOLS if timestamp in rows[symbol]}
        if len(marks) != len(SYMBOLS):
            continue

        utc_day = datetime.fromtimestamp(timestamp / 1000, timezone.utc).date().isoformat()
        if utc_day != day_key:
            day_key = utc_day
            day_start_equity = current_equity(marks)

        # Expire old limits, then allow touched limits to fill only if the
        # account-level notional and maintenance buffers remain intact.
        for campaign in campaigns:
            candle = rows[campaign.symbol].get(timestamp)
            if candle is None or not campaign.active:
                continue
            for leg in campaign.legs:
                if leg.state != "pending":
                    continue
                age_bars = (timestamp - campaign.signal_ts) // BAR_MS
                if age_bars >= PENDING_TTL_BARS:
                    leg.state = "expired"
                    stale_cancellations += 1
                    continue
                touched = candle[LOW] <= leg.entry if campaign.side == "long" else candle[HIGH] >= leg.entry
                if not touched:
                    continue
                equity = current_equity(marks)
                prospective_notional = (len(open_legs()) + 1) * RUNG_NOTIONAL
                maintenance = prospective_notional * MAINTENANCE_MARGIN_RATE
                if (prospective_notional > MAX_GROSS_LEVERAGE * max(equity, 0.0)
                        or equity < MAINTENANCE_BUFFER_MULTIPLE * maintenance):
                    leg.state = "risk_cancelled"
                    rung_risk_cancellations += 1
                    continue
                leg.state = "open"
                leg.opened_ts = timestamp
                leg.entry_fee = leg.entry * leg.qty * FEE_RATE
                cash -= leg.entry_fee
                fees += leg.entry_fee

        # Conservative OHLC check: assume every open leg sees the adverse
        # extreme of this bar before receiving credit for a favorable target.
        active_legs = open_legs()
        open_notional = len(active_legs) * RUNG_NOTIONAL
        worst_equity = cash
        for campaign, leg in active_legs:
            candle = rows[campaign.symbol][timestamp]
            adverse = float(candle[LOW] if campaign.side == "long" else candle[HIGH])
            worst_equity += leg_unrealized(campaign, leg, adverse)
        if open_notional and worst_equity <= open_notional * MAINTENANCE_MARGIN_RATE:
            liquidated = True
            for campaign, leg in active_legs:
                candle = rows[campaign.symbol][timestamp]
                adverse = float(candle[LOW] if campaign.side == "long" else candle[HIGH])
                close_leg(campaign, leg, adverse, "liquidation")
            for campaign in campaigns:
                for leg in campaign.legs:
                    if leg.state == "pending":
                        leg.state = "cancelled"
            break

        # Manage protection and targets. Protection armed on this candle can
        # only trigger from the next candle because intrabar path is unknown.
        for campaign in campaigns:
            candle = rows[campaign.symbol].get(timestamp)
            if candle is None or not campaign.active:
                continue
            close = float(candle[CLOSE])
            beyond = close < campaign.invalidation if campaign.side == "long" else close > campaign.invalidation
            campaign.closes_beyond = campaign.closes_beyond + 1 if beyond else 0
            for leg in campaign.legs:
                if leg.state != "open" or leg.opened_ts is None or timestamp <= leg.opened_ts:
                    continue
                if leg.protected:
                    protection_hit = candle[LOW] <= leg.breakeven if campaign.side == "long" else candle[HIGH] >= leg.breakeven
                    if protection_hit:
                        close_leg(campaign, leg, leg.breakeven, "protected_breakeven")
                        protected_exits += 1
                        continue
                target_hit = candle[HIGH] >= leg.target if campaign.side == "long" else candle[LOW] <= leg.target
                if target_hit:
                    close_leg(campaign, leg, leg.target, "net_target")
                    continue
                protect_hit = candle[HIGH] >= leg.entry * (1 + PROTECT_AT_MOVE) if campaign.side == "long" else candle[LOW] <= leg.entry * (1 - PROTECT_AT_MOVE)
                if protect_hit:
                    leg.protected = True

            reason = ""
            if campaign.closes_beyond >= 2:
                reason = "structural_invalidation"
                structural_exits += 1
            elif (timestamp - campaign.signal_ts) // BAR_MS >= MAX_HOLD_BARS:
                reason = "time_exit"
                time_exits += 1
            elif campaign_pnl(campaign, close) <= -CAMPAIGN_LOSS_LIMIT:
                reason = "campaign_loss_limit"
                campaign_loss_exits += 1
            if reason:
                for leg in campaign.legs:
                    if leg.state == "open":
                        close_leg(campaign, leg, close, reason)
                    elif leg.state == "pending":
                        leg.state = "cancelled"
                        leg.close_reason = reason

        equity = current_equity(marks)
        if equity <= day_start_equity * (1.0 - DAILY_KILL_DRAWDOWN):
            kill_switch = True
            for symbol in SYMBOLS:
                close_symbol(symbol, marks[symbol], "daily_kill_switch")
            continue
        if equity <= day_start_equity * (1.0 - DAILY_PAUSE_DRAWDOWN) and paused_day != day_key:
            paused_day = day_key
            daily_pauses += 1

        # Process every signal, but obey a one-direction-per-symbol venue book.
        for symbol in SYMBOLS:
            signal = signals[symbol].get(timestamp)
            if signal is None:
                continue
            processed_signals += 1
            live_sides = {
                campaign.side for campaign in campaigns
                if campaign.symbol == symbol and campaign.active
            }
            if live_sides and signal.direction not in live_sides:
                close_symbol(symbol, marks[symbol], "opposite_sweep_reversal")
                reversals += 1
                live_sides.clear()
            elif live_sides:
                same_side_adds += 1

            active = [campaign for campaign in campaigns if campaign.active]
            symbol_active = [campaign for campaign in active if campaign.symbol == symbol]
            equity = current_equity(marks)
            prospective_notional = (len(open_legs()) + 1) * RUNG_NOTIONAL
            reserved_margin = sum(
                MARGIN_PER_RUNG for campaign in active for leg in campaign.legs
                if leg.state in {"pending", "open"}
            )
            refuse = (
                kill_switch
                or paused_day == day_key
                or len(active) >= MAX_ACTIVE_CAMPAIGNS
                or len(symbol_active) >= MAX_CAMPAIGNS_PER_SYMBOL
                or reserved_margin + RUNG_COUNT * MARGIN_PER_RUNG > max(equity, 0.0)
                or prospective_notional > MAX_GROSS_LEVERAGE * max(equity, 0.0)
                or equity < MAINTENANCE_BUFFER_MULTIPLE * prospective_notional * MAINTENANCE_MARGIN_RATE
            )
            if refuse:
                signal_refusals += 1
                continue

            campaign = make_campaign(next_campaign_id, symbol, timestamp, signal)
            next_campaign_id += 1
            first = campaign.legs[0]
            first.state = "open"
            first.opened_ts = timestamp
            first.entry_fee = first.entry * first.qty * FEE_RATE
            cash -= first.entry_fee
            fees += first.entry_fee
            campaigns.append(campaign)
            opened_campaigns += 1

        for symbol in SYMBOLS:
            active_sides = {
                campaign.side for campaign in campaigns
                if campaign.symbol == symbol and campaign.active
            }
            assert len(active_sides) <= 1, f"opposing {symbol} positions escaped reconciliation"

        equity = current_equity(marks)
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        max_open_notional = max(max_open_notional, len(open_legs()) * RUNG_NOTIONAL)
        max_active_campaigns = max(max_active_campaigns, sum(campaign.active for campaign in campaigns))

    final_marks = {symbol: float(candles[symbol][-1][CLOSE]) for symbol in SYMBOLS}
    ending_unrealized = sum(
        leg_unrealized(campaign, leg, final_marks[campaign.symbol])
        for campaign, leg in open_legs()
    )
    ending_equity = cash + ending_unrealized
    all_legs = [leg for campaign in campaigns for leg in campaign.legs]
    closed_reasons = sorted({leg.close_reason for leg in all_legs if leg.state == "closed"})
    return {
        "signals_processed": processed_signals,
        "campaigns_opened": opened_campaigns,
        "same_side_adds": same_side_adds,
        "close_before_reversals": reversals,
        "signal_refusals": signal_refusals,
        "rung_risk_cancellations": rung_risk_cancellations,
        "net_target_rungs": sum(leg.close_reason == "net_target" for leg in all_legs),
        "protected_breakeven_exits": protected_exits,
        "campaign_loss_exits": campaign_loss_exits,
        "structural_exits": structural_exits,
        "time_exits": time_exits,
        "stale_pending_rungs_cancelled": stale_cancellations,
        "open_rungs": sum(leg.state == "open" for leg in all_legs),
        "pending_rungs": sum(leg.state == "pending" for leg in all_legs),
        "fees_paid": fees,
        "ending_unrealized_pnl": ending_unrealized,
        "ending_equity": ending_equity,
        "net_equity_change": ending_equity - STARTING_EQUITY,
        "max_drawdown": max_drawdown,
        "max_open_notional": max_open_notional,
        "max_active_campaigns": max_active_campaigns,
        "daily_pauses": daily_pauses,
        "kill_switch_triggered": kill_switch,
        "liquidated": liquidated,
        "target_move_pct": target_move("long") * 100,
        "window_15m_bars": TARGET_15M_BARS,
        "closed_legs_by_reason": {
            reason: sum(leg.state == "closed" and leg.close_reason == reason for leg in all_legs)
            for reason in closed_reasons
        },
        "closed_pnl_by_reason": {
            reason: sum(leg.realized_net for leg in all_legs if leg.state == "closed" and leg.close_reason == reason)
            for reason in closed_reasons
        },
    }


def main() -> None:
    raw = {symbol: fetch_coinbase(symbol, BARS_5M + WARMUP_5M_BARS) for symbol in SYMBOLS}
    print(json.dumps(run(raw), sort_keys=True))


if __name__ == "__main__":
    main()
