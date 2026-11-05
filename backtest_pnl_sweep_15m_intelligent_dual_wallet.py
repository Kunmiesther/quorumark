"""Research-only intelligent dual-wallet governor; never imported by production."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from backtest_pnl_sweep_15m_50_30_20 import (
    APEX_LEVERAGE,
    APEX_MMR,
    BARS_5M,
    CLOSE,
    FEE_RATE,
    HIGH,
    LOW,
    RUNG_MARGIN,
    SYMBOLS,
    TARGET_START_MS,
    TS,
    WARMUP_5M_BARS,
    Campaign,
    Lot,
    fetch_apex,
    make_campaign,
)
from backtest_pnl_sweep_15m_every_sweep import signals_for
from htf_bos import aggregate_1h, aggregate_4h, detect_htf_bos

WALLET_EQUITY = 2_500.0
PORTFOLIO_EQUITY = WALLET_EQUITY * 2
ACTIVE_CAMPAIGN_CAPS = (2, 5, 10)
PROFIT_LOCK_MINIMUM = PORTFOLIO_EQUITY * 0.02
GIVEBACK_AMBER = 0.20
GIVEBACK_RED = 0.35
GIVEBACK_HALT = 0.50


@dataclass
class Wallet:
    side: str
    cash: float = WALLET_EQUITY
    campaigns: list[Campaign] = field(default_factory=list)
    fees: float = 0.0
    partial_realized: float = 0.0
    liquidated: bool = False
    peak_equity: float = WALLET_EQUITY
    max_drawdown: float = 0.0
    max_open_notional: float = 0.0


def lot_unrealized(campaign: Campaign, lot: Lot, mark: float) -> float:
    move = mark - lot.entry if campaign.side == "long" else lot.entry - mark
    return move * lot.qty


def open_lots(wallet: Wallet):
    return [
        (campaign, lot)
        for campaign in wallet.campaigns
        for lot in campaign.lots
        if lot.state == "open"
    ]


def wallet_open_net(wallet: Wallet, marks: dict[str, float]) -> float:
    return sum(
        lot_unrealized(campaign, lot, marks[campaign.symbol]) - lot.entry_fee
        for campaign, lot in open_lots(wallet)
    )


def wallet_realized(wallet: Wallet) -> float:
    return wallet.partial_realized + sum(
        lot.net_pnl
        for campaign in wallet.campaigns
        for lot in campaign.lots
        if lot.state == "closed"
    )


def close_lot(wallet: Wallet, campaign: Campaign, lot: Lot, price: float, reason: str) -> None:
    gross = ((price - lot.entry) if campaign.side == "long" else (lot.entry - price)) * lot.qty
    exit_fee = price * lot.qty * FEE_RATE
    lot.net_pnl = gross - lot.entry_fee - exit_fee
    lot.state = "closed"
    lot.reason = reason
    wallet.cash += gross - exit_fee
    wallet.fees += exit_fee


def reduce_lot_half(wallet: Wallet, campaign: Campaign, lot: Lot, price: float) -> None:
    close_qty = lot.qty * 0.50
    allocated_entry_fee = lot.entry_fee * 0.50
    gross = ((price - lot.entry) if campaign.side == "long" else (lot.entry - price)) * close_qty
    exit_fee = price * close_qty * FEE_RATE
    wallet.partial_realized += gross - allocated_entry_fee - exit_fee
    wallet.cash += gross - exit_fee
    wallet.fees += exit_fee
    lot.qty -= close_qty
    lot.notional *= 0.50
    lot.entry_fee -= allocated_entry_fee


def htf_states(raw: dict[str, list[list]], signals: dict[str, dict[int, object]]) -> dict:
    states = {}
    for symbol in SYMBOLS:
        one_hour = aggregate_1h(raw[symbol])
        four_hour = aggregate_4h(raw[symbol])
        states[symbol] = {}
        for timestamp in signals[symbol]:
            cutoff = timestamp + 15 * 60 * 1000 - 1
            completed_1h = [row for row in one_hour if int(row[TS]) + 60 * 60 * 1000 - 1 <= cutoff]
            completed_4h = [row for row in four_hour if int(row[TS]) + 4 * 60 * 60 * 1000 - 1 <= cutoff]
            states[symbol][timestamp] = (
                detect_htf_bos(completed_1h, 0.0).state,
                detect_htf_bos(completed_4h, 0.0).state,
            )
    return states


def quality_multiplier(signal: object, state_1h: str, state_4h: str) -> float:
    required = "bullish_bos" if signal.direction == "long" else "bearish_bos"
    aligned_timeframes = sum(state == required for state in (state_1h, state_4h))
    retest = signal.mode == "retest"
    structural_level = signal.level_source in {"prior_day", "equal"}
    if aligned_timeframes == 2 and (retest or structural_level):
        return 1.50
    if aligned_timeframes >= 1:
        return 1.25
    return 1.00


def policy_state(realized: float, open_net: float) -> tuple[str, float]:
    if realized < PROFIT_LOCK_MINIMUM or open_net >= 0:
        return "green", 0.0
    giveback = -open_net / realized
    if giveback >= GIVEBACK_HALT:
        return "halt", giveback
    if giveback >= GIVEBACK_RED:
        return "red", giveback
    if giveback >= GIVEBACK_AMBER:
        return "amber", giveback
    return "green", giveback


def run(raw: dict[str, list[list]], max_active_campaigns: int) -> dict:
    prepared = {symbol: signals_for(series) for symbol, series in raw.items()}
    candles = {symbol: result[0] for symbol, result in prepared.items()}
    signals = {symbol: result[1] for symbol, result in prepared.items()}
    states = htf_states(raw, signals)
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in candles.items()}
    timeline = sorted({ts for series in rows.values() for ts in series if ts >= TARGET_START_MS})
    wallets = {"long": Wallet("long"), "short": Wallet("short")}
    reduced_campaigns: set[int] = set()
    signal_counts = {
        "seen": 0,
        "htf_unaligned": 0,
        "htf_partially_aligned": 0,
        "htf_fully_aligned": 0,
        "risk_rejected": 0,
        "occupied": 0,
        "opened": 0,
    }
    size_counts = {"1.0x": 0, "1.25x": 0, "1.5x": 0}
    state_counts = {"green": 0, "amber": 0, "red": 0, "halt": 0}
    reduction_events = 0
    peak_portfolio_equity = PORTFOLIO_EQUITY
    max_portfolio_drawdown = 0.0

    for timestamp in timeline:
        marks = {symbol: float(rows[symbol][timestamp][CLOSE]) for symbol in SYMBOLS}

        for wallet in wallets.values():
            for campaign in wallet.campaigns:
                candle = rows[campaign.symbol][timestamp]
                for lot in campaign.lots:
                    if lot.state == "pending":
                        touched = candle[LOW] <= lot.entry if campaign.side == "long" else candle[HIGH] >= lot.entry
                        if touched:
                            lot.state = "open"
                            lot.opened_ts = timestamp
                            lot.entry_fee = lot.notional * FEE_RATE
                            wallet.cash -= lot.entry_fee
                            wallet.fees += lot.entry_fee
                    if lot.state == "open" and lot.opened_ts is not None and timestamp > lot.opened_ts:
                        hit = candle[HIGH] >= lot.target if campaign.side == "long" else candle[LOW] <= lot.target
                        if hit:
                            close_lot(wallet, campaign, lot, lot.target, "target")

        for wallet in wallets.values():
            open_notional = sum(lot.notional for _, lot in open_lots(wallet))
            equity = wallet.cash + sum(
                lot_unrealized(campaign, lot, marks[campaign.symbol])
                for campaign, lot in open_lots(wallet)
            )
            wallet.peak_equity = max(wallet.peak_equity, equity)
            wallet.max_drawdown = max(wallet.max_drawdown, wallet.peak_equity - equity)
            wallet.max_open_notional = max(wallet.max_open_notional, open_notional)
            maintenance = sum(
                lot.notional * APEX_MMR[campaign.symbol]
                for campaign, lot in open_lots(wallet)
            )
            if open_notional and equity <= maintenance:
                wallet.liquidated = True
                for campaign, lot in open_lots(wallet):
                    close_lot(wallet, campaign, lot, marks[campaign.symbol], "liquidation")

        realized = sum(wallet_realized(wallet) for wallet in wallets.values())
        open_net = sum(wallet_open_net(wallet, marks) for wallet in wallets.values())
        state, giveback = policy_state(realized, open_net)
        state_counts[state] += 1

        if state in {"red", "halt"}:
            losing_campaigns = []
            for wallet in wallets.values():
                for campaign in wallet.campaigns:
                    campaign_open_net = sum(
                        lot_unrealized(campaign, lot, marks[campaign.symbol]) - lot.entry_fee
                        for lot in campaign.lots
                        if lot.state == "open"
                    )
                    if campaign_open_net < 0 and id(campaign) not in reduced_campaigns:
                        losing_campaigns.append((campaign_open_net, wallet, campaign))
            for _, wallet, campaign in sorted(losing_campaigns, key=lambda item: item[0]):
                for lot in campaign.lots:
                    if lot.state == "pending":
                        lot.state = "cancelled"
                    elif lot.state == "open":
                        reduce_lot_half(wallet, campaign, lot, marks[campaign.symbol])
                reduced_campaigns.add(id(campaign))
                reduction_events += 1

        active_campaigns = sum(
            campaign.active for wallet in wallets.values() for campaign in wallet.campaigns
        )
        for symbol in SYMBOLS:
            signal = signals[symbol].get(timestamp)
            if signal is None:
                continue
            signal_counts["seen"] += 1
            wallet = wallets[signal.direction]
            if any(campaign.symbol == symbol and campaign.active for campaign in wallet.campaigns):
                signal_counts["occupied"] += 1
                continue
            state_1h, state_4h = states[symbol][timestamp]
            required = "bullish_bos" if signal.direction == "long" else "bearish_bos"
            aligned_timeframes = sum(item == required for item in (state_1h, state_4h))
            alignment_label = {
                0: "htf_unaligned",
                1: "htf_partially_aligned",
                2: "htf_fully_aligned",
            }[aligned_timeframes]
            signal_counts[alignment_label] += 1
            if state in {"red", "halt"} or active_campaigns >= max_active_campaigns:
                signal_counts["risk_rejected"] += 1
                continue
            multiplier = 1.0 if state == "amber" else quality_multiplier(signal, state_1h, state_4h)
            campaign = make_campaign(
                symbol,
                timestamp,
                signal,
                APEX_LEVERAGE[symbol],
                RUNG_MARGIN * multiplier,
            )
            for lot in campaign.lots[:3]:
                lot.state = "open"
                lot.opened_ts = timestamp
                lot.entry_fee = lot.notional * FEE_RATE
                wallet.cash -= lot.entry_fee
                wallet.fees += lot.entry_fee
            wallet.campaigns.append(campaign)
            active_campaigns += 1
            signal_counts["opened"] += 1
            size_counts[f"{multiplier}x"] += 1

        portfolio_equity = sum(
            wallet.cash
            + sum(
                lot_unrealized(campaign, lot, marks[campaign.symbol])
                for campaign, lot in open_lots(wallet)
            )
            for wallet in wallets.values()
        )
        peak_portfolio_equity = max(peak_portfolio_equity, portfolio_equity)
        max_portfolio_drawdown = max(
            max_portfolio_drawdown,
            peak_portfolio_equity - portfolio_equity,
        )

    final_marks = {symbol: float(candles[symbol][-1][CLOSE]) for symbol in SYMBOLS}
    wallet_results = {}
    for name, wallet in wallets.items():
        realized = wallet_realized(wallet)
        open_net = wallet_open_net(wallet, final_marks)
        ending_equity = WALLET_EQUITY + realized + open_net
        cash_equity = wallet.cash + sum(
            lot_unrealized(campaign, lot, final_marks[campaign.symbol])
            for campaign, lot in open_lots(wallet)
        )
        assert abs(cash_equity - ending_equity) < 1e-6
        wallet_results[name] = {
            "ending_equity": ending_equity,
            "net_pnl": ending_equity - WALLET_EQUITY,
            "realized_net_pnl": realized,
            "open_net_pnl_after_entry_fees": open_net,
            "fees": wallet.fees,
            "campaigns": len(wallet.campaigns),
            "open_slices": len(open_lots(wallet)),
            "max_drawdown": wallet.max_drawdown,
            "max_open_notional": wallet.max_open_notional,
            "liquidated": wallet.liquidated,
        }
    combined_realized = sum(result["realized_net_pnl"] for result in wallet_results.values())
    combined_open = sum(result["open_net_pnl_after_entry_fees"] for result in wallet_results.values())
    ending_equity = PORTFOLIO_EQUITY + combined_realized + combined_open
    assert signal_counts["seen"] == (
        signal_counts["occupied"]
        + signal_counts["risk_rejected"]
        + signal_counts["opened"]
    )
    return {
        "wallets": wallet_results,
        "combined": {
            "starting_equity": PORTFOLIO_EQUITY,
            "ending_equity": ending_equity,
            "net_pnl": ending_equity - PORTFOLIO_EQUITY,
            "return_pct": (ending_equity / PORTFOLIO_EQUITY - 1) * 100,
            "realized_net_pnl": combined_realized,
            "open_net_pnl_after_entry_fees": combined_open,
            "fees": sum(wallet.fees for wallet in wallets.values()),
            "max_drawdown": max_portfolio_drawdown,
        },
        "signals": signal_counts,
        "position_sizes": size_counts,
        "governor_states": state_counts,
        "half_reduction_events": reduction_events,
        "rules": {
            "max_active_campaigns": max_active_campaigns,
            "profit_lock_minimum": PROFIT_LOCK_MINIMUM,
            "giveback_thresholds": {
                "amber": GIVEBACK_AMBER,
                "red": GIVEBACK_RED,
                "halt": GIVEBACK_HALT,
            },
            "htf_alignment_use": "position_sizing",
            "reversals": False,
        },
    }


def main() -> None:
    raw = {
        symbol: fetch_apex(symbol, BARS_5M + WARMUP_5M_BARS)
        for symbol in SYMBOLS
    }
    print(json.dumps({
        f"max_{cap}_active_campaigns": run(raw, cap)
        for cap in ACTIVE_CAMPAIGN_CAPS
    }, sort_keys=True))


if __name__ == "__main__":
    main()
