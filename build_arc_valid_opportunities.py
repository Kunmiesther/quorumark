"""Build the no-lookahead ARC ledger from opportunities Zen did not open.

The raw strategy logs record a detector event more than once when several
structure zones resolve to the same symbol/candle/direction/entry.  Those are
useful audit records, but they are one market opportunity and must receive one
committee vote.  A timestamp group containing a placed campaign belongs to
Zen, even when duplicate rows in that group say ``slot_occupied``.
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path


ARTIFACTS = Path("backtest_artifacts")
CORE = ARTIFACTS / "eth_sweep_sol_break_retest_concurrent_30d"
BTC = ARTIFACTS / "btc_dca_5m_no_hedge_30d"
OUTPUT = ARTIFACTS / "arc_valid_opportunities_30d"
CANDLES = ARTIFACTS / "four_wallet_30d_5m_aligned" / "candles_5m.csv"


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = sorted({key for row in rows for key in row})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def clean_number(value: str | None) -> float | int | None:
    if value in (None, ""):
        return None
    number = float(value)
    return int(number) if number.is_integer() else number


def load_candles() -> dict[str, list[dict]]:
    candles = {}
    with CANDLES.open() as handle:
        for row in csv.DictReader(handle):
            candles.setdefault(row["symbol"], []).append({
                "timestamp": int(row["timestamp"]),
                "open": float(row["open"]), "high": float(row["high"]),
                "low": float(row["low"]), "close": float(row["close"]),
                "volume": float(row["volume"]),
            })
    for rows in candles.values():
        rows.sort(key=lambda row: row["timestamp"])
    return candles


def aggregate(candles: list[dict], minutes: int) -> list[dict]:
    if minutes == 5:
        return candles
    bucket_ms = minutes * 60_000
    buckets = {}
    for row in candles:
        key = row["timestamp"] // bucket_ms * bucket_ms
        bucket = buckets.get(key)
        if bucket is None:
            buckets[key] = {**row, "timestamp": key}
        else:
            bucket["high"] = max(bucket["high"], row["high"])
            bucket["low"] = min(bucket["low"], row["low"])
            bucket["close"] = row["close"]
            bucket["volume"] += row["volume"]
    return [buckets[key] for key in sorted(buckets)]


def build_snapshot(row: dict, candles: list[dict]) -> dict:
    visible = [bar for bar in candles if bar["timestamp"] <= row["timestamp"]][-48:]
    if len(visible) < 20:
        raise RuntimeError(f"Insufficient candle history for {row['opportunity_id']}")
    closes = [bar["close"] for bar in visible]
    highs = [bar["high"] for bar in visible]
    lows = [bar["low"] for bar in visible]
    volumes = [bar["volume"] for bar in visible]
    true_ranges = []
    for index, bar in enumerate(visible):
        previous = visible[index - 1]["close"] if index else bar["open"]
        true_ranges.append(max(
            bar["high"] - bar["low"],
            abs(bar["high"] - previous), abs(bar["low"] - previous),
        ))
    atr = sum(true_ranges[-14:]) / min(14, len(true_ranges))
    entry = float(row["entry"])
    slope = (closes[-1] / closes[-13] - 1) * 100 if closes[-13] else 0.0
    # Local price geometry is evidence, not an execution instruction.  The
    # replay stays advisory and the model may still return no_trade.
    zone_half_width = max(atr * 0.15, entry * 0.0001)
    return {
        "candidate_id": row["opportunity_id"],
        "strategy": row["strategy"],
        "symbol": row["symbol"],
        "timeframe": row["timeframe"],
        "candle_close_ms": int(row["timestamp"]),
        "deterministic": {
            "proposed_direction": row["side"],
            "entry": entry,
            "entry_zone": {
                "low": entry - zone_half_width,
                "high": entry + zone_half_width,
            },
            "invalidation": None,
            "tp_levels": [],
            "regime": row.get("regime") or None,
            "trend_state": "/".join([
                row.get("state_1h") or "none",
                row.get("state_4h") or "none",
                row.get("state_1d") or "none",
            ]),
            "trend_slope_pct": slope,
            "atr_pct": atr / closes[-1] * 100 if closes[-1] else None,
            "recent_closes": closes,
            "recent_highs": highs,
            "recent_lows": lows,
            "volume_profile": volumes,
        },
        "higher_timeframes": {
            "setup_15m_close_ms": int(row["timestamp"]),
            "regime_1h_close_ms": int(row["timestamp"]),
            "regime_4h_close_ms": int(row["timestamp"]),
            "bos_1h": row.get("state_1h") or None,
            "bos_4h": row.get("state_4h") or None,
            "environment_daily_available": row.get("state_1d") not in (None, "", "none"),
            "environment_frames": {
                "state_1d": row.get("state_1d") or "none",
                "alignment_votes": clean_number(row.get("alignment_votes")),
                "level_source": row.get("level_source"),
                "mode": row.get("mode"),
            },
            "environment_unavailable_reason": None,
        },
    }


def main() -> None:
    detector_records = []
    with (CORE / "signals.csv").open() as handle:
        for row in csv.DictReader(handle):
            if row["source"] == "environment_change":
                continue
            if row["outcome"] == "filtered_two_of_three_alignment":
                continue
            symbol = row["symbol"]
            detector_records.append({
                "symbol": symbol,
                "timestamp": int(row["timestamp"]),
                "time_utc": row["time_utc"],
                "side": row["side"],
                "strategy": (
                    "liquidity_sweep" if symbol == "ETH-USDT"
                    else "break_retest"
                ),
                "timeframe": "15m",
                "entry": clean_number(row.get("entry")),
                "state_1h": row.get("state_1h") or "none",
                "state_4h": row.get("state_4h") or "none",
                "state_1d": row.get("state_1d") or "none",
                "alignment_votes": clean_number(row.get("alignment_votes")),
                "regime": row.get("regime") or None,
                "momentum_ratio": clean_number(row.get("momentum_ratio")),
                "level_source": row.get("level_source") or None,
                "mode": row.get("mode") or None,
                "zen_outcome": row["outcome"],
                "arc_status": "pending_real_committee",
            })

    with (BTC / "signals.csv").open() as handle:
        for row in csv.DictReader(handle):
            if row["against_environment"].lower() == "true":
                continue
            detector_records.append({
                "symbol": "BTC-USDT",
                "timestamp": int(row["timestamp"]),
                "time_utc": row["time_utc"],
                "side": row["side"],
                "strategy": "dca_break_retest",
                "timeframe": "5m",
                "entry": clean_number(row.get("entry")),
                "state_1h": row.get("state_1h") or "none",
                "state_4h": row.get("state_4h") or "none",
                "state_1d": row.get("state_1d") or "none",
                "alignment_votes": None,
                "regime": row.get("market_bias") or None,
                "momentum_ratio": None,
                "level_source": "confirmed_structure_zone",
                "mode": "break_retest",
                "zen_outcome": row["outcome"],
                "arc_status": "pending_real_committee",
            })

    detector_records.sort(
        key=lambda row: (row["timestamp"], row["symbol"], row["side"], row["entry"]),
    )
    if len(detector_records) != 510:
        raise RuntimeError(
            f"Expected 510 valid detector records, found {len(detector_records)}",
        )

    # Collapse repeated detector rows into one actionable market opportunity.
    grouped = {}
    for row in detector_records:
        key = (
            row["symbol"], row["timestamp"], row["side"], row["entry"],
            row["strategy"], row["timeframe"],
        )
        grouped.setdefault(key, []).append(row)

    accepted_outcomes = {"campaign_placed", "dca_placed"}
    accepted = []
    arc_candidates = []
    for rows in grouped.values():
        row = dict(rows[0])
        outcomes = sorted({item["zen_outcome"] for item in rows})
        row["detector_record_count"] = len(rows)
        row["zen_outcomes"] = "|".join(outcomes)
        row.pop("zen_outcome", None)
        if any(outcome in accepted_outcomes for outcome in outcomes):
            row["arc_status"] = "excluded_zen_accepted"
            accepted.append(row)
        else:
            row["arc_status"] = "pending_real_committee"
            arc_candidates.append(row)

    accepted.sort(key=lambda row: (row["timestamp"], row["symbol"], row["side"]))
    arc_candidates.sort(key=lambda row: (row["timestamp"], row["symbol"], row["side"]))
    for index, row in enumerate(arc_candidates, 1):
        row["opportunity_id"] = f"ARC-{index:04d}"

    if len(accepted) != 65 or len(arc_candidates) != 293:
        raise RuntimeError(
            "Opportunity accounting changed: expected 65 Zen accepted and "
            f"293 ARC candidates, found {len(accepted)} and {len(arc_candidates)}",
        )

    counts = {}
    for row in arc_candidates:
        counts[row["symbol"]] = counts.get(row["symbol"], 0) + 1
    summary = {
        "detector_records": len(detector_records),
        "unique_market_opportunities": len(grouped),
        "zen_accepted_opportunities": len(accepted),
        "arc_candidate_opportunities": len(arc_candidates),
        "duplicate_detector_records_removed": len(detector_records) - len(grouped),
        "arc_candidates_by_symbol": counts,
        "status": "arc_candidates_prepared_for_real_committee",
        "lookahead": "none; only evidence present at the opportunity timestamp",
        "committee": ["lead", "risk", "structure"],
        "synthesis": "Onyx deterministic aggregation",
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT / "detector_records.csv", detector_records)
    write_csv(OUTPUT / "zen_accepted.csv", accepted)
    write_csv(OUTPUT / "arc_candidates.csv", arc_candidates)
    # Compatibility path now has the precise ARC-only meaning.
    write_csv(OUTPUT / "opportunities.csv", arc_candidates)
    raw_candles = load_candles()
    framed = {
        (symbol, timeframe): aggregate(raw_candles[symbol], int(timeframe[:-1]))
        for symbol, timeframe in {
            (row["symbol"], row["timeframe"]) for row in arc_candidates
        }
    }
    snapshots = [
        build_snapshot(row, framed[(row["symbol"], row["timeframe"])])
        for row in arc_candidates
    ]
    with (OUTPUT / "committee_snapshots.jsonl").open("w", encoding="utf-8") as handle:
        for snapshot in snapshots:
            handle.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
    (OUTPUT / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
