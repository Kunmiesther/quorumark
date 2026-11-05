"""Concurrent 30-day ETH sweep, SOL break/retest, and BTC DCA replay.

BTC uses the owner-directed research variant: 100x, 8 x $7.50 rungs across a
2.5% total adverse span. Every filled rung is tracked independently. Rungs
target 100% margin ROI in a neutral environment, long rungs target 300% in a
bullish environment, and short rungs target 300% in a bearish environment.
"""

from __future__ import annotations

from bisect import bisect_right
import csv
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path

from backtest_four_wallet_raw import (
    ALIGNED_30D_5M_OUTPUT_DIR,
    DAY_MS,
    aggregate_1d,
    bos_state_series,
    break_retest_signals_for_15m,
    daily_trend_state_series,
    timeframe_alignment_votes,
    run,
)
from backtest_pnl_sweep_15m_50_30_20 import CLOSE, HIGH, LOW, TS
from backtest_pnl_sweep_15m_four_rung import FIXED_END_SECONDS
from htf_bos import aggregate_1h, aggregate_4h
from shared.parity_constants import get as parity_get


OUTPUT_DIR = Path("backtest_artifacts/eth_sweep_sol_break_retest_btc_dca_concurrent_30d")
CORE_OUTPUT_DIR = OUTPUT_DIR / "eth_sol_core"
SYMBOLS = {"ETH-USDT", "SOL-USDT", "BTC-USDT"}
BTC = "BTC-USDT"
WALLET_START = 2_500.0
LEVERAGE = 100.0
RUNG_COUNT = int(parity_get("ladder", "dca_rungs_max"))
TOTAL_MARGIN = float(parity_get("ladder", "dca_total_margin_usd"))
RUNG_MARGIN = TOTAL_MARGIN / RUNG_COUNT
SPAN = 0.025
NEUTRAL_TARGET_MARGIN_ROI = 1.0
ALIGNED_TARGET_MARGIN_ROI = 3.0
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


def load_source() -> dict[str, list[list]]:
    raw = {symbol: [] for symbol in SYMBOLS}
    source = ALIGNED_30D_5M_OUTPUT_DIR / "candles_5m.csv"
    with source.open() as handle:
        for row in csv.DictReader(handle):
            symbol = row["symbol"]
            if symbol not in raw:
                continue
            raw[symbol].append([
                int(row["timestamp"]), float(row["open"]), float(row["high"]),
                float(row["low"]), float(row["close"]), float(row["volume"]),
            ])
    if any(not rows for rows in raw.values()):
        raise RuntimeError(f"Missing BTC, ETH, or SOL candles in {source}")
    return raw


@dataclass
class Lot:
    rung: int
    entry: float
    qty: float
    opened_ts: int


@dataclass
class Campaign:
    campaign_id: str
    side: str
    signal_ts: int
    rungs: list[float]
    pending: list[int]
    lots: list[Lot] = field(default_factory=list)
    filled_rungs: int = 0
    realized: float = 0.0
    fees: float = 0.0
    status: str = "open"


def environment_cache(raw: list[list], candles_15m: list[list]) -> dict[int, tuple[str, str, str]]:
    one = aggregate_1h(raw)
    four = aggregate_4h(raw)
    daily = aggregate_1d(raw)
    one_states = bos_state_series(one)
    four_states = bos_state_series(four)
    daily_states = daily_trend_state_series(daily)
    one_closes = [int(row[TS]) + 60 * 60 * 1000 - 1 for row in one]
    four_closes = [int(row[TS]) + 4 * 60 * 60 * 1000 - 1 for row in four]
    daily_closes = [int(row[TS]) + DAY_MS - 1 for row in daily]
    out = {}
    for row in candles_15m:
        timestamp = int(row[TS])
        cutoff = timestamp + 15 * 60 * 1000 - 1
        one_count = bisect_right(one_closes, cutoff)
        four_count = bisect_right(four_closes, cutoff)
        daily_count = bisect_right(daily_closes, cutoff)
        out[timestamp] = (
            one_states[one_count - 1] if one_count else "none",
            four_states[four_count - 1] if four_count else "none",
            daily_states[daily_count - 1] if daily_count else "none",
        )
    return out


def build_rungs(side: str, entry: float) -> list[float]:
    prices = []
    for index in range(RUNG_COUNT):
        fraction = index / (RUNG_COUNT - 1) * SPAN
        prices.append(entry * (1 - fraction if side == "long" else 1 + fraction))
    return prices


def market_bias(states: tuple[str, str, str]) -> str:
    bullish = sum(state == "bullish_bos" for state in states)
    bearish = sum(state == "bearish_bos" for state in states)
    if bullish >= 2:
        return "bullish"
    if bearish >= 2:
        return "bearish"
    return "neutral"


def target_margin_roi(side: str, bias: str) -> float:
    if (side == "long" and bias == "bullish") or (
        side == "short" and bias == "bearish"
    ):
        return ALIGNED_TARGET_MARGIN_ROI
    return NEUTRAL_TARGET_MARGIN_ROI


def lot_target(lot: Lot, side: str, margin_roi: float) -> float:
    move = margin_roi / LEVERAGE
    return lot.entry * (1 + move if side == "long" else 1 - move)


def lot_unrealized(lot: Lot, side: str, price: float) -> float:
    return (price - lot.entry) * lot.qty if side == "long" else (lot.entry - price) * lot.qty


def record_fill(campaign: Campaign, lot: Lot, timestamp: int, bias: str) -> dict:
    margin_roi = target_margin_roi(campaign.side, bias)
    return {
        "campaign_id": campaign.campaign_id,
        "timestamp": timestamp,
        "time_utc": utc(timestamp),
        "action": "buy" if campaign.side == "long" else "sell",
        "side": campaign.side,
        "rung": lot.rung,
        "fill_price": lot.entry,
        "quantity": lot.qty,
        "margin": RUNG_MARGIN,
        "notional": RUNG_MARGIN * LEVERAGE,
        "market_bias_at_fill": bias,
        "target_margin_roi_at_fill": margin_roi * 100,
        "target_price_at_fill": lot_target(lot, campaign.side, margin_roi),
    }


def close_lot(campaign: Campaign, lot: Lot, raw_price: float, timestamp: int,
              reason: str, trades: list[dict], margin_roi: float | None = None) -> float:
    exit_price = raw_price * (1 - EXIT_SLIPPAGE if campaign.side == "long" else 1 + EXIT_SLIPPAGE)
    gross = lot_unrealized(lot, campaign.side, exit_price)
    fee = abs(lot.qty * exit_price) * TAKER_FEE
    net = gross - fee
    campaign.realized += net
    campaign.fees += fee
    trades.append({
        "campaign_id": campaign.campaign_id, "rung": lot.rung,
        "side": campaign.side, "entry": lot.entry, "exit": exit_price,
        "opened_ts": lot.opened_ts, "opened_utc": utc(lot.opened_ts),
        "closed_ts": timestamp, "closed_utc": utc(timestamp),
        "exit_reason": reason, "gross_pnl": gross, "exit_fee": fee,
        "net_pnl": net, "target_margin_roi": margin_roi,
    })
    return net


def replay_btc_dca(raw: list[list], target_start_ms: int) -> dict:
    candles, signals = break_retest_signals_for_15m(raw, target_start_ms)
    states = environment_cache(raw, candles)
    wallet_cash = WALLET_START
    peak_equity = WALLET_START
    max_drawdown = 0.0
    liquidations = 0
    sequence = 0
    active: Campaign | None = None
    campaigns: list[Campaign] = []
    fills: list[dict] = []
    trades: list[dict] = []
    signal_rows: list[dict] = []
    equity_rows: list[dict] = []

    for candle in candles:
        timestamp = int(candle[TS])
        if timestamp < target_start_ms:
            continue
        high, low, close = float(candle[HIGH]), float(candle[LOW]), float(candle[CLOSE])
        current_states = states[timestamp]
        current_bias = market_bias(current_states)

        if active is not None:
            # Existing lots can take profit; a newly filled rung cannot also
            # take profit using price action that occurred before its fill.
            survivors = []
            for lot in active.lots:
                margin_roi = target_margin_roi(active.side, current_bias)
                target = lot_target(lot, active.side, margin_roi)
                touched = high >= target if active.side == "long" else low <= target
                if touched:
                    wallet_cash += close_lot(
                        active, lot, target, timestamp, "per_rung_tp", trades,
                        margin_roi=margin_roi,
                    )
                else:
                    survivors.append(lot)
            active.lots = survivors
            if not active.lots:
                active.pending.clear()
                active.status = "target_complete"
                active = None

        if active is not None:
            newly_filled = []
            still_pending = []
            for rung_index in active.pending:
                price = active.rungs[rung_index]
                touched = low <= price if active.side == "long" else high >= price
                if touched:
                    qty = (RUNG_MARGIN * LEVERAGE) / price
                    lot = Lot(rung_index + 1, price, qty, timestamp)
                    active.lots.append(lot)
                    fills.append(record_fill(active, lot, timestamp, current_bias))
                    active.filled_rungs += 1
                    newly_filled.append(rung_index)
                else:
                    still_pending.append(rung_index)
            active.pending = still_pending

            if active.filled_rungs == RUNG_COUNT:
                deepest = active.rungs[-1]
                hard_stop = deepest * (
                    1 - HARD_STOP_BEYOND if active.side == "long" else 1 + HARD_STOP_BEYOND
                )
                stopped = low <= hard_stop if active.side == "long" else high >= hard_stop
                if stopped:
                    for lot in list(active.lots):
                        wallet_cash += close_lot(active, lot, hard_stop, timestamp, "armed_hard_stop", trades)
                    active.lots.clear()
                    active.status = "armed_hard_stop"
                    active = None

        if active is not None:
            adverse = low if active.side == "long" else high
            unrealized_adverse = sum(lot_unrealized(lot, active.side, adverse) for lot in active.lots)
            maintenance = sum(abs(lot.qty * adverse) for lot in active.lots) * BTC_MMR
            if wallet_cash + unrealized_adverse <= maintenance:
                for lot in list(active.lots):
                    wallet_cash += close_lot(active, lot, adverse, timestamp, "cross_margin_liquidation", trades)
                active.lots.clear()
                active.pending.clear()
                active.status = "liquidated"
                liquidations += 1
                active = None

        signal = signals.get(timestamp)
        if signal is not None:
            state_1h, state_4h, state_1d = states[timestamp]
            votes = timeframe_alignment_votes(signal.direction, state_1h, state_4h, state_1d)
            bias = market_bias((state_1h, state_4h, state_1d))
            against_environment = (
                (bias == "bullish" and signal.direction == "short")
                or (bias == "bearish" and signal.direction == "long")
            )
            outcome = "filtered_against_environment"
            campaign_id = ""
            if not against_environment and active is None:
                sequence += 1
                campaign_id = f"BTC-DCA-{sequence:04d}"
                rungs = build_rungs(signal.direction, float(signal.entry))
                active = Campaign(campaign_id, signal.direction, timestamp, rungs, list(range(1, RUNG_COUNT)))
                qty = (RUNG_MARGIN * LEVERAGE) / rungs[0]
                lot = Lot(1, rungs[0], qty, timestamp)
                active.lots.append(lot)
                fills.append(record_fill(active, lot, timestamp, bias))
                active.filled_rungs = 1
                campaigns.append(active)
                outcome = "campaign_placed"
            elif not against_environment:
                outcome = "symbol_slot_occupied"
            signal_rows.append({
                "timestamp": timestamp, "time_utc": utc(timestamp),
                "side": signal.direction, "entry": signal.entry,
                "state_1h": state_1h, "state_4h": state_4h, "state_1d": state_1d,
                "alignment_votes": votes, "market_bias": bias, "outcome": outcome,
                "campaign_id": campaign_id,
            })

        open_unrealized = (
            sum(lot_unrealized(lot, active.side, close) for lot in active.lots)
            if active is not None else 0.0
        )
        equity = wallet_cash + open_unrealized
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        equity_rows.append({
            "timestamp": timestamp, "time_utc": utc(timestamp), "wallet": "btc_dca",
            "cash": wallet_cash, "equity": equity,
            "open_lots": len(active.lots) if active else 0,
            "pending_rungs": len(active.pending) if active else 0,
        })

    final_mark = float(candles[-1][CLOSE])
    open_unrealized = (
        sum(lot_unrealized(lot, active.side, final_mark) for lot in active.lots)
        if active is not None else 0.0
    )
    closed = [campaign for campaign in campaigns if campaign.status != "open"]
    wins = sum(campaign.realized > 0 for campaign in closed)
    losses = sum(campaign.realized < 0 for campaign in closed)
    summary = {
        "starting_equity": WALLET_START,
        "ending_equity": wallet_cash + open_unrealized,
        "realized_net_pnl": wallet_cash - WALLET_START,
        "open_mark_net_pnl": open_unrealized,
        "net_pnl": wallet_cash + open_unrealized - WALLET_START,
        "campaigns": len(campaigns), "closed_campaigns": len(closed),
        "open_campaigns": len(campaigns) - len(closed),
        "wins": wins, "losses": losses,
        "win_rate_pct": wins / len(closed) * 100 if closed else 0.0,
        "filled_rungs": sum(campaign.filled_rungs for campaign in campaigns),
        "fees": sum(campaign.fees for campaign in campaigns),
        "max_drawdown": max_drawdown, "liquidations": liquidations,
        "signals": len(signal_rows),
        "eligible_signals": sum(
            row["outcome"] != "filtered_against_environment"
            for row in signal_rows
        ),
        "configuration": {
            "entry": "15m break-and-retest; neutral signals allowed, signals against a 2-of-3 directional environment rejected",
            "leverage": LEVERAGE, "rungs": RUNG_COUNT,
            "margin_per_rung": RUNG_MARGIN, "total_margin": TOTAL_MARGIN,
            "total_adverse_span_pct": SPAN * 100,
            "neutral_target_margin_roi_pct": NEUTRAL_TARGET_MARGIN_ROI * 100,
            "aligned_direction_target_margin_roi_pct": ALIGNED_TARGET_MARGIN_ROI * 100,
            "target_policy": "each rung exits independently; long 300% in bullish, short 300% in bearish, otherwise 100%",
            "hard_stop_after_all_rungs_pct_beyond_last": HARD_STOP_BEYOND * 100,
            "margin_mode": "separate $2,500 cross-margin Strategy wallet",
            "entry_fee": "0 bps maker", "exit_fee_bps": TAKER_FEE * 10_000,
            "exit_slippage_bps": EXIT_SLIPPAGE * 10_000,
            "funding": "not modeled; historical series unavailable",
        },
    }
    write_csv(OUTPUT_DIR / "btc_dca_fills.csv", fills)
    write_csv(OUTPUT_DIR / "btc_dca_signals.csv", signal_rows)
    write_csv(OUTPUT_DIR / "btc_dca_trades.csv", trades)
    write_csv(OUTPUT_DIR / "btc_dca_equity_curve.csv", equity_rows)
    return {"summary": summary, "equity_rows": equity_rows}


def combined_equity(core_path: Path, btc_rows: list[dict]) -> tuple[list[dict], float]:
    core_by_ts: dict[int, dict[str, float]] = {}
    with core_path.open() as handle:
        for row in csv.DictReader(handle):
            if row["wallet"] not in {"long", "short"}:
                continue
            core_by_ts.setdefault(int(row["timestamp"]), {})[row["wallet"]] = float(row["equity"])
    btc_by_ts = {int(row["timestamp"]): float(row["equity"]) for row in btc_rows}
    rows = []
    peak = 3 * WALLET_START
    max_drawdown = 0.0
    for timestamp in sorted(set(core_by_ts) & set(btc_by_ts)):
        core = core_by_ts[timestamp]
        if "long" not in core or "short" not in core:
            continue
        equity = core["long"] + core["short"] + btc_by_ts[timestamp]
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        rows.append({"timestamp": timestamp, "time_utc": utc(timestamp), "equity": equity})
    return rows, max_drawdown


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target_start_ms = FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
    raw = load_source()
    core = run(
        {symbol: raw[symbol] for symbol in ("ETH-USDT", "SOL-USDT")},
        CORE_OUTPUT_DIR, graded_all_signals=True, coordinated_lifecycle=True,
        target_start_ms=target_start_ms, strict_aligned_rules=False,
        entry_signal="liquidity_sweep",
        entry_signal_by_symbol={"ETH-USDT": "liquidity_sweep", "SOL-USDT": "break_retest"},
        long_quality_gate=False, include_strategy=False, campaign_margin_pct=0.05,
        apply_every_sweep=True, three_timeframe_vote=True, vote_quality_filter=False,
        staged_entry_steps=1, enter_all_rungs_at_alert=True,
        exit_short_on_alignment_loss=True, automatic_hedge_enabled=False,
    )
    btc = replay_btc_dca(raw[BTC], target_start_ms)
    curve, max_drawdown = combined_equity(CORE_OUTPUT_DIR / "equity_curve.csv", btc["equity_rows"])
    write_csv(OUTPUT_DIR / "combined_active_equity_curve.csv", curve)
    core_active_end = core["wallets"]["long"]["ending_equity"] + core["wallets"]["short"]["ending_equity"]
    ending = core_active_end + btc["summary"]["ending_equity"]
    report = {
        "scope": {
            "requested_start_utc": utc(target_start_ms),
            "observed_start_utc": curve[0]["time_utc"] if curve else None,
            "observed_end_utc": curve[-1]["time_utc"] if curve else None,
            "completed_15m_bars": len(curve),
            "concurrent_streams": {
                "ETH-USDT": "15m liquidity sweep",
                "SOL-USDT": "15m break-and-retest",
                "BTC-USDT": "15m break-and-retest plus owner-directed 8-rung DCA",
            },
            "environment": "2 of completed 1h/4h/1d defines bullish or bearish; otherwise neutral",
        },
        "eth_sol_wallets": {name: core["wallets"][name] for name in ("long", "short")},
        "btc_dca": btc["summary"],
        "active_combined": {
            "starting_equity": 3 * WALLET_START,
            "ending_equity": ending,
            "net_pnl": ending - 3 * WALLET_START,
            "return_pct": (ending / (3 * WALLET_START) - 1) * 100,
            "max_drawdown": max_drawdown,
            "liquidations": (
                core["wallets"]["long"]["liquidations"]
                + core["wallets"]["short"]["liquidations"]
                + btc["summary"]["liquidations"]
            ),
        },
        "limitations": [
            "Funding is not modeled because the cached dataset has no historical funding series.",
            "BTC maker fills use exact rung prices; exits include 5 bps taker fee and 2 bps slippage.",
        ],
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
