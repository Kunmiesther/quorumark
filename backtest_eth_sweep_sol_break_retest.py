"""Concurrent 30-day ETH sweep and SOL Break-and-Retest replay."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from backtest_four_wallet_raw import (
    ALIGNED_30D_5M_OUTPUT_DIR,
    DEFAULT_SWEEP_STOP_BUFFER_ATR,
    FIXED_END_SECONDS,
    run,
)


OUTPUT_DIR = Path(
    "backtest_artifacts/eth_sweep_sol_break_retest_concurrent_30d"
)
SYMBOLS = {"ETH-USDT", "SOL-USDT"}


def load_source() -> dict[str, list[list]]:
    raw = {symbol: [] for symbol in SYMBOLS}
    source = ALIGNED_30D_5M_OUTPUT_DIR / "candles_5m.csv"
    with source.open() as handle:
        for row in csv.DictReader(handle):
            symbol = row["symbol"]
            if symbol not in raw:
                continue
            raw[symbol].append([
                int(row["timestamp"]),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                float(row["volume"]),
            ])
    if any(not rows for rows in raw.values()):
        raise RuntimeError(f"Missing ETH or SOL candles in {source}")
    return raw


def main() -> None:
    target_start_ms = (
        FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
    )
    summary = run(
        load_source(),
        OUTPUT_DIR,
        graded_all_signals=True,
        coordinated_lifecycle=True,
        target_start_ms=target_start_ms,
        strict_aligned_rules=False,
        entry_signal="liquidity_sweep",
        entry_signal_by_symbol={
            "ETH-USDT": "liquidity_sweep",
            "SOL-USDT": "break_retest",
        },
        sweep_stop_buffer_atr=DEFAULT_SWEEP_STOP_BUFFER_ATR,
        long_quality_gate=False,
        include_strategy=False,
        campaign_margin_pct=0.05,
        apply_every_sweep=True,
        three_timeframe_vote=True,
        vote_quality_filter=False,
        staged_entry_steps=1,
        enter_all_rungs_at_alert=True,
        exit_short_on_alignment_loss=True,
        automatic_hedge_enabled=False,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
