"""Research-only owner-specified sweep test; no production imports this file."""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

from backtest_pnl_sweep_15m_four_rung import (
    BARS_5M, CLOSE, FEE_RATE, FIXED_END_SECONDS, HIGH, LOW, TS,
)
from backtest_pnl_sweep_15m_every_sweep import signals_for

STARTING_EQUITY = 2_500.0
OPEN = 1
RUNG_MARGIN = 8.0
RUNG_STEP = 0.005
RUNG_COUNT = 5
WARMUP_5M_BARS = 180
TARGET_15M_BARS = 480
TARGET_START_MS = FIXED_END_SECONDS * 1000 - (TARGET_15M_BARS - 1) * 15 * 60 * 1000
TP_SLICES = ((0.50, 0.50), (0.30, 0.80), (0.20, 1.00))
APEX_LEVERAGE = {
    "BTC-USDT": 100, "ETH-USDT": 100, "SOL-USDT": 50,
    "XRP-USDT": 50, "ADA-USDT": 50, "AVAX-USDT": 50,
    "LINK-USDT": 50, "SUI-USDT": 50, "LTC-USDT": 50,
    "DOGE-USDT": 25,
    "BNB-USDT": 50, "TRX-USDT": 50, "BCH-USDT": 50,
    "UNI-USDT": 50, "AAVE-USDT": 50, "NEAR-USDT": 50,
    "APT-USDT": 50, "ARB-USDT": 50, "OP-USDT": 50, "FIL-USDT": 50,
}
APEX_MMR = {
    "BTC-USDT": 0.005, "ETH-USDT": 0.005, "DOGE-USDT": 0.015,
    "SOL-USDT": 0.01, "XRP-USDT": 0.01, "ADA-USDT": 0.01,
    "AVAX-USDT": 0.01, "LINK-USDT": 0.01, "SUI-USDT": 0.01,
    "LTC-USDT": 0.01,
    "BNB-USDT": 0.01, "TRX-USDT": 0.01, "BCH-USDT": 0.01,
    "UNI-USDT": 0.01, "AAVE-USDT": 0.01, "NEAR-USDT": 0.01,
    "APT-USDT": 0.01, "ARB-USDT": 0.01, "OP-USDT": 0.01,
    "FIL-USDT": 0.01,
}
SYMBOLS = list(APEX_LEVERAGE)


@dataclass
class Lot:
    entry: float
    qty: float
    target: float
    notional: float
    state: str = "pending"
    opened_ts: int | None = None
    entry_fee: float = 0.0
    net_pnl: float = 0.0
    reason: str = ""


@dataclass
class Campaign:
    symbol: str
    side: str
    signal_ts: int
    lots: list[Lot] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return any(lot.state in {"pending", "open"} for lot in self.lots)


def make_campaign(
    symbol: str,
    timestamp: int,
    signal: object,
    leverage: int,
    rung_margin: float = RUNG_MARGIN,
) -> Campaign:
    side = signal.direction
    base = float(signal.entry)
    entry_sign = -1 if side == "long" else 1
    target_sign = 1 if side == "long" else -1
    lots = []
    for rung in range(RUNG_COUNT):
        entry = base * (1 + entry_sign * RUNG_STEP * rung)
        for quantity_fraction, roi in TP_SLICES:
            margin = rung_margin * quantity_fraction
            notional = margin * leverage
            lots.append(Lot(
                entry=entry,
                qty=notional / entry,
                target=entry * (1 + target_sign * roi / leverage),
                notional=notional,
            ))
    return Campaign(symbol, side, timestamp, lots)


def fetch_apex(symbol: str, bar_count: int) -> list[list]:
    market = symbol.replace("-", "")
    end = FIXED_END_SECONDS
    rows = {}
    while len(rows) < bar_count:
        prior_count = len(rows)
        start = end - 199 * 300
        query = urllib.parse.urlencode({"symbol": market, "interval": 5, "start": start, "end": end, "limit": 200})
        request = urllib.request.Request(
            f"https://omni.apex.exchange/api/v3/klines?{query}",
            headers={"User-Agent": "TurtleBot-Backtest/1.0", "Accept": "application/json"},
        )
        payload = json.loads(urllib.request.urlopen(request, timeout=20).read())
        series = payload.get("data", {}).get(market, [])
        if not series:
            raise RuntimeError(f"No ApeX candles returned for {market}")
        for row in series:
            ts = int(row["t"])
            rows[ts] = [ts, float(row["o"]), float(row["h"]), float(row["l"]), float(row["c"]), float(row["v"])]
        end = min(int(row["t"]) for row in series) // 1000 - 300
        if len(rows) == prior_count:
            raise RuntimeError(
                f"ApeX candle pagination made no progress for {market} "
                f"at end={end}"
            )
        time.sleep(0.05)
    return [rows[key] for key in sorted(rows)][-bar_count:]


def unrealized(campaign: Campaign, lot: Lot, mark: float) -> float:
    move = mark - lot.entry if campaign.side == "long" else lot.entry - mark
    return move * lot.qty


def simulate(
    raw: dict[str, list[list]],
    leverage_by_symbol: dict[str, int],
    *,
    allowed_side: Optional[str] = None,
    starting_equity: float = STARTING_EQUITY,
    rung_margin: float = RUNG_MARGIN,
    max_hold_hours: Optional[int] = None,
) -> dict:
    prepared = {symbol: signals_for(series) for symbol, series in raw.items()}
    candles = {symbol: result[0] for symbol, result in prepared.items()}
    signals = {symbol: result[1] for symbol, result in prepared.items()}
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in candles.items()}
    timeline = sorted({ts for series in rows.values() for ts in series if ts >= TARGET_START_MS})

    campaigns: list[Campaign] = []
    cash = starting_equity
    fees = 0.0
    signals_seen = 0
    ineligible_direction_signals = 0
    campaigns_opened = 0
    opposite_replacements = 0
    same_direction_signals_held = 0
    opposite_direction_signals_held = 0
    reversals = 0
    liquidated = False
    peak_equity = STARTING_EQUITY
    max_drawdown = 0.0
    max_notional = 0.0
    max_active = 0

    def open_lots():
        return [(campaign, lot) for campaign in campaigns for lot in campaign.lots if lot.state == "open"]

    def equity(marks):
        return cash + sum(unrealized(c, lot, marks[c.symbol]) for c, lot in open_lots())

    def close_lot(campaign, lot, price, reason):
        nonlocal cash, fees
        gross = ((price - lot.entry) if campaign.side == "long" else (lot.entry - price)) * lot.qty
        exit_fee = price * lot.qty * FEE_RATE
        lot.net_pnl = gross - lot.entry_fee - exit_fee
        lot.state = "closed"
        lot.reason = reason
        cash += gross - exit_fee
        fees += exit_fee

    def close_campaign(campaign, price, reason):
        for lot in campaign.lots:
            if lot.state == "open":
                close_lot(campaign, lot, price, reason)
            elif lot.state == "pending":
                lot.state = "cancelled"

    for timestamp in timeline:
        marks = {s: float(rows[s][timestamp][CLOSE]) for s in SYMBOLS if timestamp in rows[s]}
        if len(marks) != len(SYMBOLS):
            continue

        if max_hold_hours is not None:
            max_hold_ms = max_hold_hours * 60 * 60 * 1000
            for campaign in campaigns:
                if campaign.active and timestamp >= campaign.signal_ts + max_hold_ms:
                    close_campaign(
                        campaign,
                        float(rows[campaign.symbol][timestamp][OPEN]),
                        "campaign_timeout",
                    )

        for campaign in campaigns:
            candle = rows[campaign.symbol][timestamp]
            for lot in campaign.lots:
                if lot.state == "pending":
                    touched = candle[LOW] <= lot.entry if campaign.side == "long" else candle[HIGH] >= lot.entry
                    if touched:
                        lot.state = "open"
                        lot.opened_ts = timestamp
                        lot.entry_fee = lot.notional * FEE_RATE
                        cash -= lot.entry_fee
                        fees += lot.entry_fee
                if lot.state == "open" and lot.opened_ts is not None and timestamp > lot.opened_ts:
                    hit = candle[HIGH] >= lot.target if campaign.side == "long" else candle[LOW] <= lot.target
                    if hit:
                        close_lot(campaign, lot, lot.target, "target")

        open_notional = sum(lot.notional for _, lot in open_lots())
        account_equity = equity(marks)
        peak_equity = max(peak_equity, account_equity)
        max_drawdown = max(max_drawdown, peak_equity - account_equity)
        max_notional = max(max_notional, open_notional)
        maintenance = sum(lot.notional * APEX_MMR[campaign.symbol] for campaign, lot in open_lots())
        if open_notional and account_equity <= maintenance:
            liquidated = True
            for campaign, lot in open_lots():
                close_lot(campaign, lot, marks[campaign.symbol], "liquidation")
            break

        for symbol in SYMBOLS:
            signal = signals[symbol].get(timestamp)
            if signal is None:
                continue
            signals_seen += 1
            if allowed_side is not None and signal.direction != allowed_side:
                ineligible_direction_signals += 1
                continue
            sides = {c.side for c in campaigns if c.symbol == symbol and c.active}
            if sides:
                if signal.direction not in sides:
                    opposite_direction_signals_held += 1
                else:
                    same_direction_signals_held += 1
                continue
            campaign = make_campaign(
                symbol,
                timestamp,
                signal,
                leverage_by_symbol[symbol],
                rung_margin,
            )
            for lot in campaign.lots[:3]:
                lot.state = "open"
                lot.opened_ts = timestamp
                lot.entry_fee = lot.notional * FEE_RATE
                cash -= lot.entry_fee
                fees += lot.entry_fee
            campaigns.append(campaign)
            campaigns_opened += 1
            max_active = max(max_active, sum(c.active for c in campaigns))

        for symbol in SYMBOLS:
            assert len({c.side for c in campaigns if c.symbol == symbol and c.active}) <= 1

    final_marks = {s: float(candles[s][-1][CLOSE]) for s in SYMBOLS}
    ending_unrealized = sum(unrealized(c, lot, final_marks[c.symbol]) for c, lot in open_lots())
    all_lots = [lot for campaign in campaigns for lot in campaign.lots]
    assert signals_seen == (
        campaigns_opened
        + same_direction_signals_held
        + opposite_direction_signals_held
        + ineligible_direction_signals
    )
    assert opposite_replacements == 0 and reversals == 0
    assert all(lot.reason != "opposite_reversal" for lot in all_lots)
    ending_equity = cash + ending_unrealized
    realized_net = sum(lot.net_pnl for lot in all_lots if lot.state == "closed")
    open_net = sum(
        unrealized(campaign, lot, final_marks[campaign.symbol]) - lot.entry_fee
        for campaign, lot in open_lots()
    )
    assert abs(starting_equity + realized_net + open_net - ending_equity) < 1e-6
    reasons = sorted({lot.reason for lot in all_lots if lot.state == "closed"})
    return {
        "margin_mode": "cross_only",
        "allowed_side": allowed_side or "both",
        "starting_equity": starting_equity,
        "rung_margin": rung_margin,
        "max_hold_hours": max_hold_hours,
        "leverage_by_symbol": leverage_by_symbol,
        "signals": signals_seen,
        "ineligible_direction_signals": ineligible_direction_signals,
        "campaigns_opened": campaigns_opened,
        "opposite_replacements": opposite_replacements,
        "same_direction_signals_held": same_direction_signals_held,
        "opposite_direction_signals_held": opposite_direction_signals_held,
        "reversals": reversals,
        "tp50_slices": sum(lot.reason == "target" for i, lot in enumerate(all_lots) if i % 3 == 0),
        "tp80_slices": sum(lot.reason == "target" for i, lot in enumerate(all_lots) if i % 3 == 1),
        "tp100_slices": sum(lot.reason == "target" for i, lot in enumerate(all_lots) if i % 3 == 2),
        "open_slices": sum(lot.state == "open" for lot in all_lots),
        "pending_slices": sum(lot.state == "pending" for lot in all_lots),
        "fees": fees,
        "ending_unrealized": ending_unrealized,
        "ending_equity": ending_equity,
        "net_pnl": ending_equity - starting_equity,
        "realized_net_pnl": realized_net,
        "open_net_pnl_after_entry_fees": open_net,
        "closed_lots_by_reason": {
            reason: sum(lot.state == "closed" and lot.reason == reason for lot in all_lots)
            for reason in reasons
        },
        "closed_pnl_by_reason": {
            reason: sum(lot.net_pnl for lot in all_lots if lot.state == "closed" and lot.reason == reason)
            for reason in reasons
        },
        "target_net_pnl_by_tier": {
            "tp50": sum(lot.net_pnl for i, lot in enumerate(all_lots) if i % 3 == 0 and lot.reason == "target"),
            "tp80": sum(lot.net_pnl for i, lot in enumerate(all_lots) if i % 3 == 1 and lot.reason == "target"),
            "tp100": sum(lot.net_pnl for i, lot in enumerate(all_lots) if i % 3 == 2 and lot.reason == "target"),
        },
        "max_drawdown": max_drawdown,
        "max_open_notional": max_notional,
        "max_active_campaigns": max_active,
        "liquidated": liquidated,
    }


def main():
    raw = {symbol: fetch_apex(symbol, BARS_5M + WARMUP_5M_BARS) for symbol in SYMBOLS}
    print(json.dumps(simulate(raw, APEX_LEVERAGE), sort_keys=True))


if __name__ == "__main__":
    main()
