"""Research-only: take every 15m sweep with four independent 100%-ROI rungs.

Cross-margin assumptions requested by the owner:
  * $2,500 shared collateral; no isolated-position stop.
  * Four $8-margin rungs per sweep, 100x leverage ($800 notional per rung).
  * Rungs are 0.5% apart and each exits at +100% gross margin ROI (+1% price).
  * Every canonical 15m sweep is accepted while shared free margin permits it.

The simulation leaves unfinished rungs open at the window-end mark. It does
not alter or import into TurtleBot's paper/live execution engines.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from backtest_pnl_sweep_15m_four_rung import (
    BARS_5M, CLOSE, FIXED_END_SECONDS, HIGH, LOW, SYMBOLS as TEN_SYMBOLS, TS, _aggregate_15m,
    atr_series, detect_sweep, fetch_coinbase,
)

SYMBOLS = [symbol for symbol in TEN_SYMBOLS if symbol in {"BTC-USDT", "ETH-USDT", "SOL-USDT"}]
STARTING_EQUITY = 2_500.0
LEVERAGE = 100.0
MARGIN_PER_RUNG = 8.0
RUNG_NOTIONAL = MARGIN_PER_RUNG * LEVERAGE
RUNG_STEP = 0.005
RUNG_COUNT = 4
TARGET_ROI = 1.0
TARGET_MOVE = TARGET_ROI / LEVERAGE
FEE_RATE = 0.0004
MAINTENANCE_MARGIN_RATE = 0.005
WARMUP_5M_BARS = 60 * 3
TARGET_15M_BARS = 5 * 24 * 4
TARGET_START_MS = (FIXED_END_SECONDS * 1000) - (TARGET_15M_BARS - 1) * 15 * 60 * 1000


@dataclass
class Leg:
    entry: float
    qty: float
    target: float
    state: str = "pending"
    opened_ts: int | None = None
    entry_fee: float = 0.0
    net_pnl: float = 0.0


@dataclass
class Campaign:
    symbol: str
    side: str
    signal_ts: int
    legs: list[Leg] = field(default_factory=list)


def signals_for(candles_5m: list[list]) -> tuple[list[list], dict[int, object]]:
    candles_15m = _aggregate_15m(candles_5m)
    atr = atr_series(candles_15m)
    signals: dict[int, object] = {}
    for index in range(60, len(candles_15m)):
        # "Every sweep" means no higher-timeframe directional veto. The
        # canonical detector's ATR, RSI, body, displacement and reclaim rules
        # remain intact so random candle touches are not renamed as sweeps.
        signal = detect_sweep(candles_15m[: index + 1], atr[: index + 1], "none", 0.0)
        if signal is not None and int(candles_15m[index][TS]) >= TARGET_START_MS:
            signals[int(candles_15m[index][TS])] = signal
    return candles_15m, signals


def make_campaign(symbol: str, timestamp: int, signal: object) -> Campaign:
    side = signal.direction
    sign = -1.0 if side == "long" else 1.0
    base = float(signal.entry)
    legs = []
    for index in range(RUNG_COUNT):
        entry = base * (1.0 + sign * RUNG_STEP * index)
        target_sign = 1.0 if side == "long" else -1.0
        target = entry * (1.0 + target_sign * TARGET_MOVE)
        legs.append(Leg(entry=entry, qty=RUNG_NOTIONAL / entry, target=target))
    return Campaign(symbol=symbol, side=side, signal_ts=timestamp, legs=legs)


def unrealized(campaign: Campaign, mark: float) -> float:
    total = 0.0
    for leg in campaign.legs:
        if leg.state != "open":
            continue
        move = mark - leg.entry if campaign.side == "long" else leg.entry - mark
        total += move * leg.qty
    return total


def run(raw: dict[str, list[list]]) -> dict:
    prepared = {symbol: signals_for(series) for symbol, series in raw.items()}
    candles = {symbol: item[0] for symbol, item in prepared.items()}
    signals = {symbol: item[1] for symbol, item in prepared.items()}
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in candles.items()}
    timeline = sorted({timestamp for series in rows.values() for timestamp in series})

    campaigns: list[Campaign] = []
    realized_balance = STARTING_EQUITY
    fees_paid = 0.0
    realized_trade_pnl = 0.0
    peak_equity = STARTING_EQUITY
    max_drawdown = 0.0
    max_open_notional = 0.0
    max_open_legs = 0
    max_campaigns = 0
    placed = 0
    refused_margin = 0
    liquidated = False

    for timestamp in timeline:
        marks = {symbol: float(rows[symbol][timestamp][CLOSE]) for symbol in SYMBOLS if timestamp in rows[symbol]}

        for campaign in campaigns:
            candle = rows[campaign.symbol].get(timestamp)
            if candle is None:
                continue
            for leg in campaign.legs:
                if leg.state == "pending":
                    touched = candle[LOW] <= leg.entry if campaign.side == "long" else candle[HIGH] >= leg.entry
                    if touched:
                        leg.state = "open"
                        leg.opened_ts = timestamp
                        leg.entry_fee = leg.entry * leg.qty * FEE_RATE
                        fees_paid += leg.entry_fee
                        realized_balance -= leg.entry_fee
                # A newly filled limit cannot also claim a target on the same
                # OHLC bar because the intrabar path is unknown.
                if leg.state == "open" and leg.opened_ts is not None and timestamp > leg.opened_ts:
                    target_hit = candle[HIGH] >= leg.target if campaign.side == "long" else candle[LOW] <= leg.target
                    if target_hit:
                        gross = abs(leg.target - leg.entry) * leg.qty
                        exit_fee = leg.target * leg.qty * FEE_RATE
                        leg.net_pnl = gross - leg.entry_fee - exit_fee
                        leg.state = "closed"
                        fees_paid += exit_fee
                        realized_balance += gross - exit_fee
                        realized_trade_pnl += leg.net_pnl

        open_legs = [(campaign, leg) for campaign in campaigns for leg in campaign.legs if leg.state == "open"]
        open_notional = len(open_legs) * RUNG_NOTIONAL
        open_pnl = sum(unrealized(campaign, marks.get(campaign.symbol, campaign.legs[0].entry)) for campaign in campaigns)
        equity = realized_balance + open_pnl
        maintenance = open_notional * MAINTENANCE_MARGIN_RATE
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        max_open_notional = max(max_open_notional, open_notional)
        max_open_legs = max(max_open_legs, len(open_legs))
        max_campaigns = max(max_campaigns, sum(any(leg.state != "closed" for leg in campaign.legs) for campaign in campaigns))

        if open_notional and equity <= maintenance:
            liquidated = True
            # Settle all open legs at the current 15m close. Pending orders are
            # cancelled. Intrabar liquidation is not modeled.
            for campaign, leg in open_legs:
                mark = marks.get(campaign.symbol, leg.entry)
                gross = (mark - leg.entry) * leg.qty if campaign.side == "long" else (leg.entry - mark) * leg.qty
                exit_fee = mark * leg.qty * FEE_RATE
                leg.net_pnl = gross - leg.entry_fee - exit_fee
                leg.state = "liquidated"
                fees_paid += exit_fee
                realized_balance += gross - exit_fee
            break

        # Submit every detected sweep. Four pending/open rungs reserve $32 of
        # initial margin until they close; if collateral is exhausted, record
        # the refusal rather than inventing leverage beyond the account.
        reserved_margin = sum(MARGIN_PER_RUNG for campaign in campaigns for leg in campaign.legs if leg.state in {"pending", "open"})
        for symbol in SYMBOLS:
            signal = signals[symbol].get(timestamp)
            if signal is None:
                continue
            if equity - reserved_margin < MARGIN_PER_RUNG * RUNG_COUNT:
                refused_margin += 1
                continue
            campaign = make_campaign(symbol, timestamp, signal)
            # Rung 1 fills after the completed sweep; deeper rungs are limits.
            first = campaign.legs[0]
            first.state = "open"
            first.opened_ts = timestamp
            first.entry_fee = first.entry * first.qty * FEE_RATE
            fees_paid += first.entry_fee
            realized_balance -= first.entry_fee
            campaigns.append(campaign)
            placed += 1
            reserved_margin += MARGIN_PER_RUNG * RUNG_COUNT

    final_marks = {symbol: float(candles[symbol][-1][CLOSE]) for symbol in SYMBOLS}
    ending_unrealized = sum(unrealized(campaign, final_marks[campaign.symbol]) for campaign in campaigns)
    completed_legs = [leg for campaign in campaigns for leg in campaign.legs if leg.state == "closed"]
    open_legs = [leg for campaign in campaigns for leg in campaign.legs if leg.state == "open"]
    pending_legs = [leg for campaign in campaigns for leg in campaign.legs if leg.state == "pending"]
    ending_equity = realized_balance + ending_unrealized
    return {
        "signals": sum(len(items) for items in signals.values()),
        "campaigns_placed": placed,
        "margin_refusals": refused_margin,
        "rungs_completed_at_100pct_roi": len(completed_legs),
        "open_rungs": len(open_legs),
        "pending_rungs": len(pending_legs),
        "realized_trade_pnl_after_fees": realized_trade_pnl,
        "fees_paid": fees_paid,
        "ending_unrealized_pnl": ending_unrealized,
        "ending_equity": ending_equity,
        "net_equity_change": ending_equity - STARTING_EQUITY,
        "max_drawdown": max_drawdown,
        "max_open_notional": max_open_notional,
        "max_open_legs": max_open_legs,
        "max_active_campaigns": max_campaigns,
        "liquidated": liquidated,
        "signals_by_symbol": {symbol: len(signals[symbol]) for symbol in SYMBOLS},
        "completed_rungs_by_symbol": {
            symbol: sum(leg.state == "closed" for campaign in campaigns if campaign.symbol == symbol for leg in campaign.legs)
            for symbol in SYMBOLS
        },
    }


def main() -> None:
    raw = {symbol: fetch_coinbase(symbol, BARS_5M + WARMUP_5M_BARS) for symbol in SYMBOLS}
    print(json.dumps(run(raw), sort_keys=True))


if __name__ == "__main__":
    main()
