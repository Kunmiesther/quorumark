"""BTC-only 5m break/retest DCA replay with no Hedge book."""

from __future__ import annotations

import json

from backtest_btc_dca_5m_hedged import (
    Book,
    CORE_ALIGNED_ROI,
    CORE_NEUTRAL_ROI,
    FIXED_END_SECONDS,
    LEVERAGE,
    OUTPUT_DIR as OLD_OUTPUT_DIR,
    RUNG_COUNT,
    RUNG_MARGIN,
    SPAN,
    TOTAL_MARGIN,
    WALLET_START,
    book_equity,
    environment_cache,
    is_against,
    load_btc,
    market_bias,
    open_campaign,
    process_book,
    signal_map,
    summarize,
    utc,
    write_csv,
)


OUTPUT_DIR = OLD_OUTPUT_DIR.parent / "btc_dca_5m_no_hedge_30d"


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = load_btc()
    start_ms = FIXED_END_SECONDS * 1000 - (30 * 288 - 1) * 5 * 60 * 1000
    signals = signal_map(raw, start_ms)
    states = environment_cache(raw)
    dca = Book("dca")
    signal_rows = []
    equity_rows = []

    for candle in raw:
        timestamp = int(candle[0])
        if timestamp < start_ms:
            continue
        high, low, close = float(candle[2]), float(candle[3]), float(candle[4])
        bias = market_bias(states[timestamp])
        process_book(dca, timestamp, high, low, close, bias)

        for signal in signals.get(timestamp, []):
            against = is_against(signal["side"], bias)
            outcome = "rejected_against_environment" if against else "slot_occupied"
            campaign_id = ""
            if not against and dca.active is None:
                campaign = open_campaign(
                    dca, signal["side"], signal["entry"], timestamp, bias,
                )
                campaign_id = campaign.campaign_id
                outcome = "dca_placed"
            signal_rows.append({
                "timestamp": timestamp, "time_utc": utc(timestamp),
                "side": signal["side"], "entry": signal["entry"],
                "market_bias": bias, "against_environment": against,
                "outcome": outcome, "campaign_id": campaign_id,
                "state_1h": states[timestamp][0],
                "state_4h": states[timestamp][1],
                "state_1d": states[timestamp][2],
            })

        equity = book_equity(dca, close)
        dca.peak_equity = max(dca.peak_equity, equity)
        dca.max_drawdown = max(dca.max_drawdown, dca.peak_equity - equity)
        equity_rows.append({
            "timestamp": timestamp, "time_utc": utc(timestamp),
            "equity": equity,
        })

    result = summarize(dca, float(raw[-1][4]))
    summary = {
        "scope": {
            "symbol": "BTC-USDT", "entry_timeframe": "5m",
            "entry_signal": "break-and-retest",
            "observed_start_utc": equity_rows[0]["time_utc"],
            "observed_end_utc": equity_rows[-1]["time_utc"],
            "completed_5m_bars": len(equity_rows),
            "environment": "2 of completed 1h/4h/1d defines bullish or bearish; otherwise neutral",
            "hedge": "disabled",
        },
        "configuration": {
            "wallet_start": WALLET_START, "leverage": LEVERAGE,
            "rungs_per_campaign": RUNG_COUNT,
            "margin_per_rung": RUNG_MARGIN, "margin_per_campaign": TOTAL_MARGIN,
            "ladder_span_pct": SPAN * 100,
            "targets": (
                f"{CORE_NEUTRAL_ROI * 100:.0f}% margin ROI neutral; "
                f"long {CORE_ALIGNED_ROI * 100:.0f}% bullish; "
                f"short {CORE_ALIGNED_ROI * 100:.0f}% bearish"
            ),
            "against_environment": "rejected; no Hedge created",
        },
        "signals": {
            "total": len(signal_rows),
            "against_environment_rejected": sum(
                row["outcome"] == "rejected_against_environment"
                for row in signal_rows
            ),
            "campaigns_placed": sum(
                row["outcome"] == "dca_placed" for row in signal_rows
            ),
            "arrived_while_active": sum(
                row["outcome"] == "slot_occupied" for row in signal_rows
            ),
        },
        "dca": result,
    }
    write_csv(OUTPUT_DIR / "signals.csv", signal_rows)
    write_csv(OUTPUT_DIR / "fills.csv", dca.fills)
    write_csv(OUTPUT_DIR / "trades.csv", dca.trades)
    write_csv(OUTPUT_DIR / "equity_curve.csv", equity_rows)
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
