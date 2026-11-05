"""Evaluate ARC council plans against candles that occurred after each review.

Each council plan is replayed independently so this report measures plan quality,
not portfolio scheduling. Orders become eligible on the candle after the immutable
review snapshot. When a stop and target are both touched in one candle, the stop
wins (conservative intrabar ordering). Existing TurtleBot cost assumptions are
used: 5 bps fee and 2 bps adverse slippage per fill.
"""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median


ROOT = Path("backtest_artifacts")
ARC = ROOT / "arc_valid_opportunities_30d"
CANDLES_PATH = ROOT / "four_wallet_30d_5m_aligned" / "candles_5m.csv"
OUTPUT = ARC / "plan_evaluation"
CAPITAL = 2_500.0
FEE_RATE = 0.0005
SLIPPAGE_RATE = 0.0002


def iso(timestamp: int | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat()


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
        multiplier = 1 + SLIPPAGE_RATE if side == "long" else 1 - SLIPPAGE_RATE
    else:
        multiplier = 1 - SLIPPAGE_RATE if side == "long" else 1 + SLIPPAGE_RATE
    return raw_price * multiplier


def replay(candidate: dict, result: dict, candles: list[dict]) -> dict:
    plan = result["onyx"]["selected_plan"]
    side = result["onyx"]["direction"]
    base_entry = float(candidate["entry"])
    alert_ts = int(candidate["timestamp"])
    future = [bar for bar in candles if bar["timestamp"] > alert_ts]
    margin = CAPITAL * float(plan["capital_allocation_pct"]) / 100
    orders = [
        {
            "price": base_entry * (1 + float(row["offset_pct"]) / 100),
            "weight": float(row["weight_pct"]) / 100,
            "filled": False,
        }
        for row in plan["entries"]
    ]
    open_lots: list[dict] = []
    realized = 0.0
    fees = 0.0
    first_fill_ts = None
    exit_ts = None
    exit_reason = "never_filled"
    pending_cancelled = False
    tp_hit = [False] * len(plan["take_profits"])
    tp_baseline_qty = None
    trailing_active = False
    trail_reference = None
    trail_stop = None

    def total_qty() -> float:
        return sum(lot["qty"] for lot in open_lots)

    def close_qty(quantity: float, raw_price: float) -> float:
        nonlocal realized, fees
        remaining = min(quantity, total_qty())
        exit_px = execution_price(raw_price, side, False)
        closed = 0.0
        while remaining > 1e-12 and open_lots:
            lot = open_lots[0]
            take = min(remaining, lot["qty"])
            gross = (exit_px - lot["entry"]) * take if side == "long" else (lot["entry"] - exit_px) * take
            exit_fee = exit_px * take * FEE_RATE
            realized += gross - exit_fee
            fees += exit_fee
            lot["qty"] -= take
            remaining -= take
            closed += take
            if lot["qty"] <= 1e-12:
                open_lots.pop(0)
        return closed

    for bar_index, bar in enumerate(future):
        low, high = bar["low"], bar["high"]

        if not pending_cancelled:
            for order in orders:
                if order["filled"]:
                    continue
                touched = low <= order["price"] <= high
                if bar_index == 0 and abs(order["price"] - base_entry) <= base_entry * 1e-10:
                    touched = True
                    raw_fill = bar["open"]
                else:
                    raw_fill = order["price"]
                if not touched:
                    continue
                fill_px = execution_price(raw_fill, side, True)
                notional = margin * order["weight"] * float(plan["leverage"])
                qty = notional / fill_px
                entry_fee = notional * FEE_RATE
                fees += entry_fee
                realized -= entry_fee
                open_lots.append({"entry": fill_px, "qty": qty})
                order["filled"] = True
                first_fill_ts = first_fill_ts or bar["timestamp"]

        if not open_lots:
            continue

        hard_stop = float(plan["hard_stop_price"])
        active_stop = hard_stop
        stop_reason = "hard_stop"
        if trailing_active and trail_stop is not None:
            if side == "long" and trail_stop > active_stop:
                active_stop, stop_reason = trail_stop, "trailing_stop"
            elif side == "short" and trail_stop < active_stop:
                active_stop, stop_reason = trail_stop, "trailing_stop"
        stop_touched = low <= active_stop if side == "long" else high >= active_stop
        if stop_touched:
            close_qty(total_qty(), active_stop)
            exit_ts, exit_reason, pending_cancelled = bar["timestamp"], stop_reason, True
            break

        ordered_targets = sorted(
            enumerate(plan["take_profits"]),
            key=lambda item: float(item[1]["price"]),
            reverse=side == "short",
        )
        for index, target in ordered_targets:
            if tp_hit[index]:
                continue
            target_price = float(target["price"])
            touched = high >= target_price if side == "long" else low <= target_price
            if not touched:
                continue
            if tp_baseline_qty is None:
                tp_baseline_qty = total_qty()
                pending_cancelled = True
            close_qty(tp_baseline_qty * float(target["close_pct"]) / 100, target_price)
            tp_hit[index] = True
            if not open_lots:
                exit_ts, exit_reason = bar["timestamp"], "all_take_profits"
                break
        if not open_lots:
            break

        trailing = plan["trailing_stop"]
        activate = float(trailing["activate_price"])
        favorable = high if side == "long" else low
        reached = favorable >= activate if side == "long" else favorable <= activate
        if reached:
            distance = float(trailing["distance_pct"]) / 100
            step = float(trailing["step_pct"]) / 100
            if not trailing_active:
                trailing_active = True
                trail_reference = activate
            if side == "long":
                while favorable >= trail_reference * (1 + step):
                    trail_reference *= 1 + step
                trail_stop = trail_reference * (1 - distance)
            else:
                while favorable <= trail_reference * (1 - step):
                    trail_reference *= 1 - step
                trail_stop = trail_reference * (1 + distance)

    unrealized = 0.0
    mark = future[-1]["close"] if future else base_entry
    if open_lots:
        mark_px = execution_price(mark, side, False)
        for lot in open_lots:
            gross = (mark_px - lot["entry"]) * lot["qty"] if side == "long" else (lot["entry"] - mark_px) * lot["qty"]
            unrealized += gross - mark_px * lot["qty"] * FEE_RATE
        exit_reason = "open_at_data_end"

    filled = sum(order["filled"] for order in orders)
    return {
        "candidate_id": result["candidate_id"],
        "symbol": candidate["symbol"],
        "strategy": candidate["strategy"],
        "alert_time_utc": candidate["time_utc"],
        "direction": side,
        "verdict": result["onyx"]["verdict"],
        "council_confidence": result["onyx"]["confidence"],
        "capital_allocation_pct": plan["capital_allocation_pct"],
        "margin_usd": margin,
        "leverage": plan["leverage"],
        "entry_orders": len(orders),
        "entry_fills": filled,
        "first_fill_time_utc": iso(first_fill_ts),
        "take_profits_hit": sum(tp_hit),
        "exit_time_utc": iso(exit_ts),
        "exit_reason": exit_reason,
        "realized_pnl_usd": realized,
        "unrealized_pnl_usd": unrealized,
        "net_pnl_usd": realized + unrealized,
        "fees_usd": fees,
        "return_on_margin_pct": (realized + unrealized) / margin * 100 if margin else 0,
        "open_quantity": total_qty(),
    }


def main() -> None:
    candidates = {row["opportunity_id"]: row for row in load_csv(ARC / "arc_candidates.csv")}
    results = [json.loads(line) for line in (ARC / "committee_results.jsonl").read_text(encoding="utf-8").splitlines() if line]
    candles: dict[str, list[dict]] = defaultdict(list)
    for row in load_csv(CANDLES_PATH):
        candles[row["symbol"]].append({
            "timestamp": int(row["timestamp"]), "open": float(row["open"]),
            "high": float(row["high"]), "low": float(row["low"]),
            "close": float(row["close"]), "volume": float(row["volume"]),
        })
    for rows in candles.values():
        rows.sort(key=lambda row: row["timestamp"])

    trades = [
        replay(candidates[row["candidate_id"]], row, candles[candidates[row["candidate_id"]]["symbol"]])
        for row in results if row["onyx"].get("selected_plan")
    ]
    closed = [row for row in trades if row["exit_reason"] not in {"never_filled", "open_at_data_end"}]
    filled = [row for row in trades if row["entry_fills"]]
    summary = {
        "candidate_reviews": len(results),
        "council_verdicts": dict(Counter(row["onyx"]["verdict"] for row in results)),
        "selected_plans": len(trades),
        "filled_plans": len(filled),
        "never_filled": sum(row["exit_reason"] == "never_filled" for row in trades),
        "open_at_data_end": sum(row["exit_reason"] == "open_at_data_end" for row in trades),
        "closed_plans": len(closed),
        "winning_closed_plans": sum(row["net_pnl_usd"] > 0 for row in closed),
        "losing_closed_plans": sum(row["net_pnl_usd"] < 0 for row in closed),
        "closed_win_rate_pct": (sum(row["net_pnl_usd"] > 0 for row in closed) / len(closed) * 100) if closed else None,
        "realized_pnl_usd": sum(row["realized_pnl_usd"] for row in trades),
        "unrealized_pnl_usd": sum(row["unrealized_pnl_usd"] for row in trades),
        "net_pnl_usd": sum(row["net_pnl_usd"] for row in trades),
        "fees_usd": sum(row["fees_usd"] for row in trades),
        "median_allocation_pct": median(row["capital_allocation_pct"] for row in trades),
        "max_allocation_pct": max(row["capital_allocation_pct"] for row in trades),
        "margin_cap_violations": sum(row["capital_allocation_pct"] > 5 for row in trades),
        "assumptions": {
            "starting_capital_per_plan_usd": CAPITAL,
            "plans_replayed_independently": True,
            "entry_eligibility": "first candle strictly after review snapshot",
            "same_candle_stop_and_target": "stop_first",
            "fee_rate_per_fill": FEE_RATE,
            "adverse_slippage_rate_per_fill": SLIPPAGE_RATE,
            "remaining_positions": "marked to final available close",
        },
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT / "trades.csv", trades)
    (OUTPUT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
