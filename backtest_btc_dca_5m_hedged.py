"""BTC-only 5m break/retest DCA plus opposing-environment Hedge replay."""

from __future__ import annotations

from bisect import bisect_right
import csv
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path

import accumulator_signal
from backtest_four_wallet_raw import (
    ALIGNED_30D_5M_OUTPUT_DIR,
    DAY_MS,
    aggregate_1d,
    bos_state_series,
    daily_trend_state_series,
)
from backtest_pnl_sweep_15m_50_30_20 import CLOSE, HIGH, LOW, TS
from backtest_pnl_sweep_15m_four_rung import FIXED_END_SECONDS
from htf_bos import aggregate_1h, aggregate_4h
from shared.parity_constants import get as parity_get


OUTPUT_DIR = Path("backtest_artifacts/btc_dca_5m_hedged_30d")
WALLET_START = 2_500.0
LEVERAGE = 100.0
RUNG_COUNT = int(parity_get("ladder", "dca_rungs_max"))
TOTAL_MARGIN = float(parity_get("ladder", "dca_total_margin_usd"))
RUNG_MARGIN = TOTAL_MARGIN / RUNG_COUNT
SPAN = 0.025
CORE_NEUTRAL_ROI = 1.0
CORE_ALIGNED_ROI = 3.0
HEDGE_ROI = 2.0
HARD_STOP_BEYOND = float(parity_get("ladder", "hard_stop_beyond_last_rung_pct"))
TAKER_FEE = 0.0005
EXIT_SLIPPAGE = 0.0002
BTC_MMR = 0.005


def utc(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat()


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


def load_btc() -> list[list]:
    rows = []
    with (ALIGNED_30D_5M_OUTPUT_DIR / "candles_5m.csv").open() as handle:
        for row in csv.DictReader(handle):
            if row["symbol"] != "BTC-USDT":
                continue
            rows.append([
                int(row["timestamp"]), float(row["open"]), float(row["high"]),
                float(row["low"]), float(row["close"]), float(row["volume"]),
            ])
    if not rows:
        raise RuntimeError("BTC-USDT is absent from the cached 5m dataset")
    return rows


def signal_map(candles: list[list], start_ms: int) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for direction in ("long", "short"):
        result = accumulator_signal.evaluate(candles, direction, 0.0)
        for retest in result["entries"]:
            if retest.retest_index is None or retest.retest_ts is None:
                continue
            timestamp = int(retest.retest_ts)
            if timestamp < start_ms:
                continue
            row = candles[int(retest.retest_index)]
            out.setdefault(timestamp, []).append({
                "side": direction,
                "entry": float(row[CLOSE]),
            })
    return out


def environment_cache(candles: list[list]) -> dict[int, tuple[str, str, str]]:
    one = aggregate_1h(candles)
    four = aggregate_4h(candles)
    daily = aggregate_1d(candles)
    one_states = bos_state_series(one)
    four_states = bos_state_series(four)
    daily_states = daily_trend_state_series(daily)
    one_closes = [int(row[TS]) + 60 * 60 * 1000 - 1 for row in one]
    four_closes = [int(row[TS]) + 4 * 60 * 60 * 1000 - 1 for row in four]
    daily_closes = [int(row[TS]) + DAY_MS - 1 for row in daily]
    out = {}
    for row in candles:
        timestamp = int(row[TS])
        cutoff = timestamp + 5 * 60 * 1000 - 1
        one_count = bisect_right(one_closes, cutoff)
        four_count = bisect_right(four_closes, cutoff)
        daily_count = bisect_right(daily_closes, cutoff)
        out[timestamp] = (
            one_states[one_count - 1] if one_count else "none",
            four_states[four_count - 1] if four_count else "none",
            daily_states[daily_count - 1] if daily_count else "none",
        )
    return out


def market_bias(states: tuple[str, str, str]) -> str:
    if sum(state == "bullish_bos" for state in states) >= 2:
        return "bullish"
    if sum(state == "bearish_bos" for state in states) >= 2:
        return "bearish"
    return "neutral"


def is_against(side: str, bias: str) -> bool:
    return (bias == "bullish" and side == "short") or (
        bias == "bearish" and side == "long"
    )


def build_rungs(side: str, entry: float) -> list[float]:
    return [
        entry * (1 - index / (RUNG_COUNT - 1) * SPAN)
        if side == "long" else
        entry * (1 + index / (RUNG_COUNT - 1) * SPAN)
        for index in range(RUNG_COUNT)
    ]


@dataclass
class Lot:
    rung: int
    entry: float
    qty: float
    opened_ts: int


@dataclass
class Campaign:
    campaign_id: str
    book: str
    side: str
    signal_ts: int
    rungs: list[float]
    pending: list[int]
    lots: list[Lot] = field(default_factory=list)
    filled_rungs: int = 0
    realized: float = 0.0
    fees: float = 0.0
    status: str = "open"


@dataclass
class Book:
    name: str
    cash: float = WALLET_START
    active: Campaign | None = None
    campaigns: list[Campaign] = field(default_factory=list)
    fills: list[dict] = field(default_factory=list)
    trades: list[dict] = field(default_factory=list)
    peak_equity: float = WALLET_START
    max_drawdown: float = 0.0
    liquidations: int = 0
    sequence: int = 0


def target_roi(campaign: Campaign, bias: str) -> float:
    if campaign.book == "hedge":
        return HEDGE_ROI
    aligned = (campaign.side == "long" and bias == "bullish") or (
        campaign.side == "short" and bias == "bearish"
    )
    return CORE_ALIGNED_ROI if aligned else CORE_NEUTRAL_ROI


def target_price(lot: Lot, side: str, roi: float) -> float:
    move = roi / LEVERAGE
    return lot.entry * (1 + move if side == "long" else 1 - move)


def unrealized(lot: Lot, side: str, price: float) -> float:
    return (price - lot.entry) * lot.qty if side == "long" else (lot.entry - price) * lot.qty


def add_fill(book: Book, campaign: Campaign, rung_index: int,
             timestamp: int, bias: str) -> None:
    price = campaign.rungs[rung_index]
    lot = Lot(rung_index + 1, price, RUNG_MARGIN * LEVERAGE / price, timestamp)
    campaign.lots.append(lot)
    campaign.filled_rungs += 1
    roi = target_roi(campaign, bias)
    book.fills.append({
        "book": book.name, "campaign_id": campaign.campaign_id,
        "timestamp": timestamp, "time_utc": utc(timestamp),
        "action": "buy" if campaign.side == "long" else "sell",
        "side": campaign.side, "rung": lot.rung, "fill_price": lot.entry,
        "quantity": lot.qty, "margin": RUNG_MARGIN,
        "notional": RUNG_MARGIN * LEVERAGE,
        "market_bias_at_fill": bias,
        "target_margin_roi_at_fill_pct": roi * 100,
        "target_price_at_fill": target_price(lot, campaign.side, roi),
    })


def close_lot(book: Book, campaign: Campaign, lot: Lot, raw_price: float,
              timestamp: int, reason: str, roi: float | None = None) -> None:
    exit_price = raw_price * (1 - EXIT_SLIPPAGE if campaign.side == "long" else 1 + EXIT_SLIPPAGE)
    gross = unrealized(lot, campaign.side, exit_price)
    fee = abs(lot.qty * exit_price) * TAKER_FEE
    net = gross - fee
    campaign.realized += net
    campaign.fees += fee
    book.cash += net
    book.trades.append({
        "book": book.name, "campaign_id": campaign.campaign_id,
        "rung": lot.rung, "side": campaign.side,
        "entry": lot.entry, "exit": exit_price,
        "opened_ts": lot.opened_ts, "opened_utc": utc(lot.opened_ts),
        "closed_ts": timestamp, "closed_utc": utc(timestamp),
        "exit_reason": reason, "target_margin_roi_pct": roi * 100 if roi is not None else None,
        "gross_pnl": gross, "exit_fee": fee, "net_pnl": net,
    })


def process_book(book: Book, timestamp: int, high: float, low: float,
                 close: float, bias: str) -> None:
    campaign = book.active
    if campaign is None:
        return

    survivors = []
    for lot in campaign.lots:
        roi = target_roi(campaign, bias)
        target = target_price(lot, campaign.side, roi)
        touched = high >= target if campaign.side == "long" else low <= target
        if touched:
            close_lot(book, campaign, lot, target, timestamp, "per_rung_tp", roi)
        else:
            survivors.append(lot)
    campaign.lots = survivors
    if not campaign.lots:
        campaign.pending.clear()
        campaign.status = "target_complete"
        book.active = None
        return

    still_pending = []
    for rung_index in campaign.pending:
        price = campaign.rungs[rung_index]
        touched = low <= price if campaign.side == "long" else high >= price
        if touched:
            add_fill(book, campaign, rung_index, timestamp, bias)
        else:
            still_pending.append(rung_index)
    campaign.pending = still_pending

    if campaign.filled_rungs == RUNG_COUNT:
        deepest = campaign.rungs[-1]
        stop = deepest * (
            1 - HARD_STOP_BEYOND if campaign.side == "long" else 1 + HARD_STOP_BEYOND
        )
        touched = low <= stop if campaign.side == "long" else high >= stop
        if touched:
            for lot in list(campaign.lots):
                close_lot(book, campaign, lot, stop, timestamp, "armed_hard_stop")
            campaign.lots.clear()
            campaign.status = "armed_hard_stop"
            book.active = None
            return

    adverse = low if campaign.side == "long" else high
    equity = book.cash + sum(unrealized(lot, campaign.side, adverse) for lot in campaign.lots)
    maintenance = sum(abs(lot.qty * adverse) for lot in campaign.lots) * BTC_MMR
    if equity <= maintenance:
        for lot in list(campaign.lots):
            close_lot(book, campaign, lot, adverse, timestamp, "cross_margin_liquidation")
        campaign.lots.clear()
        campaign.pending.clear()
        campaign.status = "liquidated"
        book.active = None
        book.liquidations += 1


def open_campaign(book: Book, side: str, entry: float,
                  timestamp: int, bias: str) -> Campaign:
    book.sequence += 1
    campaign = Campaign(
        f"BTC-{book.name.upper()}-{book.sequence:04d}", book.name, side,
        timestamp, build_rungs(side, entry), list(range(1, RUNG_COUNT)),
    )
    add_fill(book, campaign, 0, timestamp, bias)
    book.active = campaign
    book.campaigns.append(campaign)
    return campaign


def book_equity(book: Book, mark: float) -> float:
    if book.active is None:
        return book.cash
    return book.cash + sum(
        unrealized(lot, book.active.side, mark) for lot in book.active.lots
    )


def summarize(book: Book, final_mark: float) -> dict:
    closed = [campaign for campaign in book.campaigns if campaign.status != "open"]
    ending = book_equity(book, final_mark)
    return {
        "starting_equity": WALLET_START, "ending_equity": ending,
        "realized_net_pnl": book.cash - WALLET_START,
        "open_mark_net_pnl": ending - book.cash,
        "net_pnl": ending - WALLET_START,
        "campaigns": len(book.campaigns), "closed_campaigns": len(closed),
        "open_campaigns": len(book.campaigns) - len(closed),
        "wins": sum(campaign.realized > 0 for campaign in closed),
        "losses": sum(campaign.realized < 0 for campaign in closed),
        "filled_rungs": len(book.fills), "closed_rungs": len(book.trades),
        "fees": sum(campaign.fees for campaign in book.campaigns),
        "max_drawdown": book.max_drawdown, "liquidations": book.liquidations,
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = load_btc()
    start_ms = FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
    signals = signal_map(raw, start_ms)
    states = environment_cache(raw)
    dca = Book("dca")
    hedge = Book("hedge")
    signal_rows = []
    equity_rows = []

    for candle in raw:
        timestamp = int(candle[TS])
        if timestamp < start_ms:
            continue
        high, low, close = float(candle[HIGH]), float(candle[LOW]), float(candle[CLOSE])
        bias = market_bias(states[timestamp])
        process_book(dca, timestamp, high, low, close, bias)
        process_book(hedge, timestamp, high, low, close, bias)

        for signal in signals.get(timestamp, []):
            against = is_against(signal["side"], bias)
            book = hedge if against else dca
            outcome = "slot_occupied"
            campaign_id = ""
            if book.active is None:
                campaign = open_campaign(
                    book, signal["side"], signal["entry"], timestamp, bias,
                )
                campaign_id = campaign.campaign_id
                outcome = "hedge_placed" if against else "dca_placed"
            signal_rows.append({
                "timestamp": timestamp, "time_utc": utc(timestamp),
                "side": signal["side"], "entry": signal["entry"],
                "market_bias": bias, "against_environment": against,
                "routed_book": book.name, "outcome": outcome,
                "campaign_id": campaign_id,
                "state_1h": states[timestamp][0],
                "state_4h": states[timestamp][1],
                "state_1d": states[timestamp][2],
            })

        dca_equity = book_equity(dca, close)
        hedge_equity = book_equity(hedge, close)
        for book, equity in ((dca, dca_equity), (hedge, hedge_equity)):
            book.peak_equity = max(book.peak_equity, equity)
            book.max_drawdown = max(book.max_drawdown, book.peak_equity - equity)
        equity_rows.append({
            "timestamp": timestamp, "time_utc": utc(timestamp),
            "dca_equity": dca_equity, "hedge_equity": hedge_equity,
            "combined_equity": dca_equity + hedge_equity,
        })

    final_mark = float(raw[-1][CLOSE])
    dca_summary = summarize(dca, final_mark)
    hedge_summary = summarize(hedge, final_mark)
    peak = 2 * WALLET_START
    combined_drawdown = 0.0
    for row in equity_rows:
        equity = float(row["combined_equity"])
        peak = max(peak, equity)
        combined_drawdown = max(combined_drawdown, peak - equity)
    ending = dca_summary["ending_equity"] + hedge_summary["ending_equity"]
    summary = {
        "scope": {
            "symbol": "BTC-USDT", "entry_timeframe": "5m",
            "entry_signal": "break-and-retest",
            "observed_start_utc": equity_rows[0]["time_utc"],
            "observed_end_utc": equity_rows[-1]["time_utc"],
            "completed_5m_bars": len(equity_rows),
            "environment": "2 of completed 1h/4h/1d defines bullish or bearish; otherwise neutral",
        },
        "configuration": {
            "wallet_start_each": WALLET_START, "leverage": LEVERAGE,
            "rungs_per_campaign": RUNG_COUNT,
            "margin_per_rung": RUNG_MARGIN, "margin_per_campaign": TOTAL_MARGIN,
            "ladder_span_pct": SPAN * 100,
            "dca_targets": "100% margin ROI neutral; long 300% bullish; short 300% bearish",
            "hedge_routing": "every signal against the current environment routes to the Hedge book",
            "hedge_target_margin_roi_pct": HEDGE_ROI * 100,
            "hard_stop": "1% beyond rung 8, armed only after all eight rungs fill",
            "costs": "maker entries; exits include 5 bps taker fee and 2 bps slippage",
            "funding": "not modeled; historical series unavailable",
        },
        "signals": {
            "total": len(signal_rows),
            "dca_routed": sum(row["routed_book"] == "dca" for row in signal_rows),
            "hedge_routed": sum(row["routed_book"] == "hedge" for row in signal_rows),
            "dca_placed": sum(row["outcome"] == "dca_placed" for row in signal_rows),
            "hedge_placed": sum(row["outcome"] == "hedge_placed" for row in signal_rows),
        },
        "dca": dca_summary,
        "hedge": hedge_summary,
        "combined": {
            "starting_equity": 2 * WALLET_START,
            "ending_equity": ending,
            "net_pnl": ending - 2 * WALLET_START,
            "return_pct": (ending / (2 * WALLET_START) - 1) * 100,
            "max_drawdown": combined_drawdown,
            "liquidations": dca.liquidations + hedge.liquidations,
        },
    }
    write_csv(OUTPUT_DIR / "signals.csv", signal_rows)
    write_csv(OUTPUT_DIR / "fills.csv", dca.fills + hedge.fills)
    write_csv(OUTPUT_DIR / "trades.csv", dca.trades + hedge.trades)
    write_csv(OUTPUT_DIR / "equity_curve.csv", equity_rows)
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
