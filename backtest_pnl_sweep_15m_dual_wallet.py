"""Research-only dual-wallet sweep test; no production imports this file."""
from __future__ import annotations

import json

from backtest_pnl_sweep_15m_50_30_20 import (
    APEX_LEVERAGE,
    BARS_5M,
    RUNG_MARGIN,
    SYMBOLS,
    WARMUP_5M_BARS,
    fetch_apex,
    simulate,
)

WALLET_EQUITY = 2_500.0
HOLD_HOURS = (24, 48, 72, 96, None)


def combined(long_wallet: dict, short_wallet: dict) -> dict:
    result = {
        "starting_equity": long_wallet["starting_equity"] + short_wallet["starting_equity"],
        "ending_equity": long_wallet["ending_equity"] + short_wallet["ending_equity"],
        "net_pnl": long_wallet["net_pnl"] + short_wallet["net_pnl"],
        "realized_net_pnl": long_wallet["realized_net_pnl"] + short_wallet["realized_net_pnl"],
        "open_net_pnl_after_entry_fees": (
            long_wallet["open_net_pnl_after_entry_fees"]
            + short_wallet["open_net_pnl_after_entry_fees"]
        ),
        "fees": long_wallet["fees"] + short_wallet["fees"],
        "liquidated_wallets": [
            name
            for name, result in (("long", long_wallet), ("short", short_wallet))
            if result["liquidated"]
        ],
    }
    result["return_pct"] = result["net_pnl"] / result["starting_equity"] * 100
    assert abs(
        result["starting_equity"]
        + result["realized_net_pnl"]
        + result["open_net_pnl_after_entry_fees"]
        - result["ending_equity"]
    ) < 1e-6
    return result


def main() -> None:
    raw = {
        symbol: fetch_apex(symbol, BARS_5M + WARMUP_5M_BARS)
        for symbol in SYMBOLS
    }
    results = {}
    for max_hold_hours in HOLD_HOURS:
        long_wallet = simulate(
            raw,
            APEX_LEVERAGE,
            allowed_side="long",
            starting_equity=WALLET_EQUITY,
            rung_margin=RUNG_MARGIN,
            max_hold_hours=max_hold_hours,
        )
        short_wallet = simulate(
            raw,
            APEX_LEVERAGE,
            allowed_side="short",
            starting_equity=WALLET_EQUITY,
            rung_margin=RUNG_MARGIN,
            max_hold_hours=max_hold_hours,
        )
        results["unlimited" if max_hold_hours is None else f"{max_hold_hours}h"] = {
            "long_wallet": long_wallet,
            "short_wallet": short_wallet,
            "combined": combined(long_wallet, short_wallet),
        }
    print(json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    main()
