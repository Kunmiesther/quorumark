"""Isolated ETH replay of the staged Long and mirrored Short wallets at 5% size."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

from backtest_four_wallet_raw import (
    ALIGNED_30D_5M_OUTPUT_DIR,
    DEFAULT_SWEEP_STOP_BUFFER_ATR,
    FIXED_END_SECONDS,
    run,
)


OUTPUT_ROOT = Path(
    "backtest_artifacts/eth_only_staged_liquidity_sweep_five_percent"
)


def load_eth() -> dict[str, list[list]]:
    source = ALIGNED_30D_5M_OUTPUT_DIR / "candles_5m.csv"
    rows: list[list] = []
    with source.open() as handle:
        for row in csv.DictReader(handle):
            if row["symbol"] != "ETH-USDT":
                continue
            rows.append([
                int(row["timestamp"]),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                float(row["volume"]),
            ])
    if not rows:
        raise RuntimeError(f"No ETH-USDT candles found in {source}")
    return {"ETH-USDT": rows}


def campaign_metrics(output_dir: Path, wallet: str) -> dict:
    with (output_dir / "positions.csv").open() as handle:
        positions = [row for row in csv.DictReader(handle) if row["wallet"] == wallet]
    campaigns: dict[str, list[dict]] = {}
    for row in positions:
        campaigns.setdefault(row["campaign_id"], []).append(row)
    completed = {
        campaign_id: sum(float(row["net_pnl"] or 0) for row in rows)
        for campaign_id, rows in campaigns.items()
        if all(row["position_state"] == "closed" for row in rows)
    }
    active = {
        campaign_id for campaign_id, rows in campaigns.items()
        if any(row["position_state"] == "open" for row in rows)
    }
    with (output_dir / "orders.csv").open() as handle:
        pending_campaigns = {
            row["campaign_id"] for row in csv.DictReader(handle)
            if row["wallet"] == wallet and row["state"] == "pending"
        }
    wins = [value for value in completed.values() if value > 0]
    losses = [value for value in completed.values() if value < 0]
    return {
        "closed_campaigns": len(completed),
        "active_campaigns": len(active),
        "pending_campaigns": len(pending_campaigns),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": (
            100 * len(wins) / len(completed) if completed else None
        ),
        "winning_dollars": sum(wins),
        "losing_dollars": sum(losses),
    }


def signal_metrics(output_dir: Path, wallet: str) -> dict:
    with (output_dir / "signals.csv").open() as handle:
        signals = [
            row for row in csv.DictReader(handle)
            if row.get("source") == "liquidity_sweep"
            and row.get("wallet") == wallet
        ]
    return {
        "detected_directional_sweeps": len(signals),
        "signal_outcomes": dict(
            Counter(row.get("outcome") for row in signals)
        ),
    }


def replay(wallet: str, raw: dict[str, list[list]], target_start_ms: int) -> dict:
    output_dir = OUTPUT_ROOT / wallet
    summary = run(
        raw,
        output_dir,
        graded_all_signals=True,
        coordinated_lifecycle=True,
        target_start_ms=target_start_ms,
        strict_aligned_rules=False,
        entry_signal="liquidity_sweep",
        sweep_stop_buffer_atr=DEFAULT_SWEEP_STOP_BUFFER_ATR,
        long_quality_gate=False,
        long_stage_three_after_three_spaces=wallet == "long",
        short_stage_three_after_three_spaces=wallet == "short",
        include_strategy=False,
        core_wallet_filter=wallet,
        campaign_margin_pct=0.05,
        apply_every_sweep=True,
        three_timeframe_vote=True,
        vote_quality_filter=False,
        staged_entry_steps=1,
        enter_all_rungs_at_alert=True,
        exit_short_on_alignment_loss=True,
    )
    wallet_summary = summary["wallets"][wallet]
    return {
        **campaign_metrics(output_dir, wallet),
        **signal_metrics(output_dir, wallet),
        "net_pnl": wallet_summary["net_pnl"],
        "ending_equity": wallet_summary["ending_equity"],
        "max_drawdown": wallet_summary["max_drawdown"],
        "fees": wallet_summary["fees"],
        "fills": wallet_summary["fills"],
        "pending_orders": wallet_summary["pending_orders"],
        "realized_net_pnl": wallet_summary["realized_net_pnl"],
        "open_mark_net_pnl": wallet_summary["open_mark_net_pnl"],
        "open_slices": wallet_summary["open_slices"],
        "liquidations": wallet_summary["liquidations"],
        "cross_margin_deleverages": summary["combined"][
            "cross_margin_deleverages"
        ],
    }


def main() -> None:
    raw = load_eth()
    target_start_ms = (
        FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
    )
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    comparison = {
        "scope": {
            "symbol": "ETH-USDT",
            "period_days": 30,
            "entry_timeframe": "15m",
            "entry_signal": "liquidity_sweep",
            "higher_timeframe_gate": "sweep direction must match at least two of 1h, 4h, and completed 1d",
            "daily_state": "completed daily candle with 5/10 EMA direction; no look-ahead",
            "quality_gate": "disabled",
            "entry_invalidation_filter": "disabled",
            "wallet_start": 2500.0,
            "campaign_margin_pct": 5.0,
            "campaign_margin": 125.0,
            "margin_per_rung": 25.0,
            "entry_geometry": (
                "enter all five $25 rungs immediately at the qualifying alert price"
            ),
            "hedge_enabled": False,
            "strategy_enabled": False,
            "short_exit": "close when bearish alignment falls below two of 1h, 4h, and completed 1d",
        },
        "wallets": {
            "long": replay("long", raw, target_start_ms),
            "short": replay("short", raw, target_start_ms),
        },
    }
    (OUTPUT_ROOT / "comparison.json").write_text(
        json.dumps(comparison, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(json.dumps(comparison, sort_keys=True))


if __name__ == "__main__":
    main()
