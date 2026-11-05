"""Replay every ARC opportunity that did not receive a council trade plan.

This is an independent opportunity-quality replay, not a portfolio equity
simulation. Each unused opportunity receives one five-rung adverse DCA ladder
covering 2%, with 2% of a $2,500 research wallet allocated as margin. The
target is solved after costs so a completed campaign earns 30% on the margin
actually filled. Only candles strictly after the review timestamp may fill.
"""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from backtest_pnl_sweep_15m_50_30_20 import APEX_LEVERAGE


ROOT = Path("backtest_artifacts")
ARC = ROOT / "arc_valid_opportunities_30d"
CANDLES_PATH = ROOT / "four_wallet_30d_5m_aligned" / "candles_5m.csv"
OUTPUT = ARC / "unused_dca_2pct_30roi"
CAPITAL = 2_500.0
CAMPAIGN_MARGIN_PCT = 0.02
TARGET_MARGIN_ROI = 0.30
RUNG_OFFSETS_PCT = (0.0, 0.5, 1.0, 1.5, 2.0)
INVALIDATION_OFFSET_PCT = 4.0
MAX_HOLDING_BARS = 864
MAX_ACTIVE_CAMPAIGNS = 5
FEE_RATE = 0.0005
SLIPPAGE_RATE = 0.0002


def iso(timestamp: int | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(
        timestamp / 1000, tz=timezone.utc,
    ).isoformat()


def timestamp_from_iso(value: str | None) -> int | None:
    if not value:
        return None
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def load_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict]) -> None:
    fields = sorted({key for row in rows for key in row})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def execution_price(raw_price: float, side: str, opening: bool) -> float:
    if opening:
        multiplier = (
            1 + SLIPPAGE_RATE if side == "long" else 1 - SLIPPAGE_RATE
        )
    else:
        multiplier = (
            1 - SLIPPAGE_RATE if side == "long" else 1 + SLIPPAGE_RATE
        )
    return raw_price * multiplier


def raw_target(lots: list[dict], side: str) -> float:
    """Solve the raw price that nets 30% ROI after exit costs/slippage."""
    quantity = sum(lot["qty"] for lot in lots)
    entry_basis = sum(lot["entry"] * lot["qty"] for lot in lots)
    entry_fees = sum(lot["entry_fee"] for lot in lots)
    used_margin = sum(lot["margin"] for lot in lots)
    desired_net = used_margin * TARGET_MARGIN_ROI
    if side == "long":
        execution = (
            entry_basis + entry_fees + desired_net
        ) / (quantity * (1 - FEE_RATE))
        return execution / (1 - SLIPPAGE_RATE)
    execution = (
        entry_basis - entry_fees - desired_net
    ) / (quantity * (1 + FEE_RATE))
    return execution / (1 + SLIPPAGE_RATE)


def close_net(lots: list[dict], raw_price: float, side: str) -> tuple[float, float]:
    execution = execution_price(raw_price, side, False)
    quantity = sum(lot["qty"] for lot in lots)
    entry_basis = sum(lot["entry"] * lot["qty"] for lot in lots)
    entry_fees = sum(lot["entry_fee"] for lot in lots)
    gross = (
        execution * quantity - entry_basis
        if side == "long" else entry_basis - execution * quantity
    )
    exit_fee = execution * quantity * FEE_RATE
    return gross - entry_fees - exit_fee, entry_fees + exit_fee


def replay(
    candidate: dict,
    candles: list[dict],
    invalidation_offset_pct: float | None = None,
    max_holding_bars: int | None = None,
) -> dict:
    side = candidate["side"]
    leverage = APEX_LEVERAGE[candidate["symbol"]]
    base_entry = float(candidate["entry"])
    alert_ts = int(candidate["timestamp"])
    future = [bar for bar in candles if bar["timestamp"] > alert_ts]
    total_margin = CAPITAL * CAMPAIGN_MARGIN_PCT
    margin_per_rung = total_margin / len(RUNG_OFFSETS_PCT)
    sign = -1 if side == "long" else 1
    orders = [
        {
            "rung": index + 1,
            "price": base_entry * (1 + sign * offset / 100),
            "filled": False,
        }
        for index, offset in enumerate(RUNG_OFFSETS_PCT)
    ]
    lots = []
    first_fill_ts = None
    latest_fill_bar = None
    exit_ts = None
    exit_reason = "never_filled"
    realized = 0.0
    fees = 0.0
    stop_price = (
        base_entry * (1 + sign * invalidation_offset_pct / 100)
        if invalidation_offset_pct is not None else None
    )

    for bar_index, bar in enumerate(future):
        low, high = bar["low"], bar["high"]
        filled_this_bar = False
        for order in orders:
            if order["filled"]:
                continue
            if order["rung"] == 1 and first_fill_ts is None:
                raw_fill = bar["open"]
            elif low <= order["price"] <= high:
                raw_fill = order["price"]
            else:
                continue
            fill = execution_price(raw_fill, side, True)
            notional = margin_per_rung * leverage
            fee = notional * FEE_RATE
            lots.append({
                "entry": fill,
                "qty": notional / fill,
                "entry_fee": fee,
                "margin": margin_per_rung,
                "rung": order["rung"],
            })
            order["filled"] = True
            first_fill_ts = first_fill_ts or bar["timestamp"]
            latest_fill_bar = bar_index
            filled_this_bar = True

        if not lots:
            continue
        if stop_price is not None:
            stop_touched = (
                low <= stop_price if side == "long" else high >= stop_price
            )
            if stop_touched:
                realized, fees = close_net(lots, stop_price, side)
                exit_ts = bar["timestamp"]
                exit_reason = "dca_structure_invalidation"
                break
        if filled_this_bar or bar_index == latest_fill_bar:
            continue
        target = raw_target(lots, side)
        target_touched = high >= target if side == "long" else low <= target
        if target_touched:
            realized, fees = close_net(lots, target, side)
            exit_ts = bar["timestamp"]
            exit_reason = "target_30pct_net_margin_roi"
            break
        if (
            max_holding_bars is not None
            and first_fill_ts is not None
            and bar["timestamp"] - first_fill_ts
            >= max_holding_bars * 5 * 60 * 1000
        ):
            realized, fees = close_net(lots, bar["close"], side)
            exit_ts = bar["timestamp"]
            exit_reason = "dca_max_holding_exit"
            break

    unrealized = 0.0
    mark = future[-1]["close"] if future else base_entry
    if lots and exit_ts is None:
        unrealized, fees = close_net(lots, mark, side)
        exit_reason = "open_at_data_end"

    used_margin = len(lots) * margin_per_rung
    net = realized + unrealized
    return {
        "candidate_id": candidate["opportunity_id"],
        "symbol": candidate["symbol"],
        "strategy": candidate["strategy"],
        "direction": side,
        "alert_time_utc": candidate["time_utc"],
        "first_fill_time_utc": iso(first_fill_ts),
        "exit_time_utc": iso(exit_ts),
        "exit_reason": exit_reason,
        "invalidation_offset_pct": invalidation_offset_pct,
        "max_holding_bars": max_holding_bars,
        "leverage": leverage,
        "campaign_margin_cap_pct": CAMPAIGN_MARGIN_PCT * 100,
        "campaign_margin_cap_usd": total_margin,
        "used_margin_usd": used_margin,
        "rungs_filled": len(lots),
        "realized_pnl_usd": realized,
        "unrealized_pnl_usd": unrealized,
        "net_pnl_usd": net,
        "fees_usd": fees,
        "return_on_filled_margin_pct": (
            net / used_margin * 100 if used_margin else 0.0
        ),
    }


def main() -> None:
    candidates = {
        row["opportunity_id"]: row for row in load_csv(ARC / "arc_candidates.csv")
    }
    results = [
        json.loads(line)
        for line in (ARC / "committee_results.jsonl").read_text(
            encoding="utf-8",
        ).splitlines()
        if line
    ]
    unused_ids = [
        row["candidate_id"] for row in results
        if not row["onyx"].get("selected_plan")
    ]
    if len(unused_ids) != 276:
        raise RuntimeError(
            f"Expected 276 unused ARC opportunities, found {len(unused_ids)}"
        )

    candles: dict[str, list[dict]] = defaultdict(list)
    for row in load_csv(CANDLES_PATH):
        candles[row["symbol"]].append({
            "timestamp": int(row["timestamp"]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
        })
    for rows in candles.values():
        rows.sort(key=lambda row: row["timestamp"])

    trades = [
        replay(
            candidates[candidate_id],
            candles[candidates[candidate_id]["symbol"]],
            invalidation_offset_pct=INVALIDATION_OFFSET_PCT,
            max_holding_bars=MAX_HOLDING_BARS,
        )
        for candidate_id in unused_ids
    ]
    filled = [row for row in trades if row["rungs_filled"] > 0]
    target_closed = [
        row for row in filled
        if row["exit_reason"] == "target_30pct_net_margin_roi"
    ]
    open_rows = [
        row for row in filled if row["exit_reason"] == "open_at_data_end"
    ]
    data_end = min(rows[-1]["timestamp"] for rows in candles.values())
    active = []
    portfolio_selected = []
    for trade in sorted(
        trades,
        key=lambda row: (
            timestamp_from_iso(row["first_fill_time_utc"]) or 10**30,
            row["candidate_id"],
        ),
    ):
        start = timestamp_from_iso(trade["first_fill_time_utc"])
        if start is None:
            trade["portfolio_outcome"] = "never_filled"
            continue
        active = [
            row for row in active
            if (timestamp_from_iso(row["exit_time_utc"]) or data_end) > start
        ]
        if any(row["symbol"] == trade["symbol"] for row in active):
            trade["portfolio_outcome"] = "deferred_symbol_campaign_active"
            continue
        if len(active) >= MAX_ACTIVE_CAMPAIGNS:
            trade["portfolio_outcome"] = "deferred_five_campaign_capacity"
            continue
        trade["portfolio_outcome"] = "portfolio_campaign_placed"
        portfolio_selected.append(trade)
        active.append(trade)

    portfolio_wins = sum(
        row["net_pnl_usd"] > 0 for row in portfolio_selected
    )
    portfolio_losses = sum(
        row["net_pnl_usd"] < 0 for row in portfolio_selected
    )
    summary = {
        "unused_opportunities_routed": len(trades),
        "filled_campaigns": len(filled),
        "target_closed_campaigns": len(target_closed),
        "open_at_data_end": len(open_rows),
        "target_completion_rate_pct": (
            len(target_closed) / len(filled) * 100 if filled else None
        ),
        "realized_pnl_usd": sum(row["realized_pnl_usd"] for row in trades),
        "unrealized_pnl_usd": sum(row["unrealized_pnl_usd"] for row in trades),
        "net_pnl_usd": sum(row["net_pnl_usd"] for row in trades),
        "fees_usd": sum(row["fees_usd"] for row in trades),
        "by_symbol": dict(Counter(row["symbol"] for row in trades)),
        "portfolio": {
            "campaigns_placed": len(portfolio_selected),
            "opportunities_deferred": sum(
                row["portfolio_outcome"].startswith("deferred_")
                for row in trades
            ),
            "winning_campaigns": portfolio_wins,
            "losing_campaigns": portfolio_losses,
            "positive_outcome_rate_pct": (
                portfolio_wins / len(portfolio_selected) * 100
                if portfolio_selected else None
            ),
            "open_at_data_end": sum(
                row["exit_reason"] == "open_at_data_end"
                for row in portfolio_selected
            ),
            "net_pnl_usd": sum(
                row["net_pnl_usd"] for row in portfolio_selected
            ),
            "fees_usd": sum(
                row["fees_usd"] for row in portfolio_selected
            ),
            "by_symbol": {
                symbol: {
                    "campaigns": len(rows),
                    "net_pnl_usd": sum(row["net_pnl_usd"] for row in rows),
                }
                for symbol in sorted({row["symbol"] for row in portfolio_selected})
                for rows in [[
                    row for row in portfolio_selected
                    if row["symbol"] == symbol
                ]]
            },
        },
        "configuration": {
            "starting_capital_reference_usd": CAPITAL,
            "margin_cap_per_campaign_pct": CAMPAIGN_MARGIN_PCT * 100,
            "margin_cap_per_campaign_usd": CAPITAL * CAMPAIGN_MARGIN_PCT,
            "rungs": len(RUNG_OFFSETS_PCT),
            "ladder_span_pct": max(RUNG_OFFSETS_PCT),
            "invalidation_offset_pct": INVALIDATION_OFFSET_PCT,
            "maximum_holding_hours": MAX_HOLDING_BARS / 12,
            "maximum_active_campaigns": MAX_ACTIVE_CAMPAIGNS,
            "one_active_campaign_per_symbol": True,
            "target_net_margin_roi_pct": TARGET_MARGIN_ROI * 100,
            "leverage": "ApeX symbol maximum from the frozen replay table",
            "fee_rate_per_fill": FEE_RATE,
            "adverse_slippage_rate_per_fill": SLIPPAGE_RATE,
            "same_bar_fill_and_target": "target deferred to a later 5m candle",
        },
        "scope_warning": (
            "Independent-campaign P&L measures opportunity quality and is not "
            "an additive portfolio return. The portfolio section enforces one "
            "active campaign per symbol and five campaigns maximum."
        ),
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT / "trades.csv", trades)
    (OUTPUT / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
