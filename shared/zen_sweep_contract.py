"""Python consumer for the canonical symbol-agnostic Zen sweep contract."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Iterable

from shared.parity_constants import group

_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "strategy-contracts",
    "zen_sweep_v1.json",
)
with open(_PATH, "r", encoding="utf-8") as _file:
    ZEN_SWEEP = json.load(_file)

ORCHESTRATION = group("orchestration")
SCAN_SYMBOLS = tuple(ORCHESTRATION["scan_symbols"])
SCAN_SYMBOL_SET = frozenset(SCAN_SYMBOLS)

if ZEN_SWEEP["signal"]["entry_timeframe_min"] != ORCHESTRATION["decision_interval_min"]:
    raise RuntimeError("zen_sweep_v1 entry timeframe differs from orchestration")
if len(SCAN_SYMBOLS) != ORCHESTRATION["scan_universe_size"]:
    raise RuntimeError("scan_universe_size differs from scan_symbols")
if ZEN_SWEEP["execution"]["margin_mode"] != "cross":
    raise RuntimeError("zen_sweep_v1 must use cross margin")


def is_scan_symbol(symbol: str) -> bool:
    return symbol in SCAN_SYMBOL_SET


def alignment_votes(direction: str, states: Iterable[str]) -> int:
    expected = "bullish_bos" if direction == "long" else "bearish_bos"
    return sum(1 for state in states if state == expected)


def passes_alignment(direction: str, states: Iterable[str]) -> bool:
    return alignment_votes(direction, states) >= int(
        ZEN_SWEEP["signal"]["alignment_votes_required"]
    )


def net_campaign_margin_roi_pct(
    banked_net_pnl: float,
    open_net_pnl: float,
    initial_margin: float,
) -> float:
    if initial_margin <= 0:
        return float("-inf")
    return ((banked_net_pnl + open_net_pnl) / initial_margin) * 100.0


@dataclass(frozen=True)
class ExitDecision:
    action: str
    net_roi_pct: float
    high_water_roi_pct: float
    trailing_floor_roi_pct: float | None


@dataclass(frozen=True)
class Rung:
    price: float
    qty: float
    margin: float
    tp: float


def build_ladder(
    *,
    direction: str,
    alert_price: float,
    leverage: float,
    available_equity: float,
) -> list[Rung]:
    if alert_price <= 0 or leverage <= 0 or available_equity <= 0:
        return []
    execution = ZEN_SWEEP["execution"]
    exit_cfg = ZEN_SWEEP["exit"]
    count = int(execution["rung_count"])
    total_margin = (
        available_equity
        * float(execution["total_margin_fraction_of_available_equity"])
    )
    margin = total_margin / count
    spacing = float(execution["rung_spacing_price_pct"])
    first_move = (
        float(exit_cfg["first_target_margin_roi_pct"]) / 100.0
    ) / leverage
    result: list[Rung] = []
    for index in range(count):
        adverse = spacing * index
        price = (
            alert_price * (1.0 - adverse)
            if direction == "long"
            else alert_price * (1.0 + adverse)
        )
        qty = (margin * leverage) / price
        tp = (
            price * (1.0 + first_move)
            if direction == "long"
            else price * (1.0 - first_move)
        )
        result.append(Rung(price=price, qty=qty, margin=margin, tp=tp))
    return result


def decide_exit(
    *,
    banked_net_pnl: float,
    open_net_pnl: float,
    initial_margin: float,
    first_target_taken: bool,
    previous_high_water_roi_pct: float | None = None,
) -> ExitDecision:
    net_roi = net_campaign_margin_roi_pct(
        banked_net_pnl, open_net_pnl, initial_margin
    )
    high_water = max(
        previous_high_water_roi_pct
        if previous_high_water_roi_pct is not None
        else float("-inf"),
        net_roi,
    )
    exit_cfg = ZEN_SWEEP["exit"]
    if not first_target_taken:
        action = (
            "close_half"
            if net_roi >= float(exit_cfg["first_target_margin_roi_pct"])
            else "hold"
        )
        return ExitDecision(action, net_roi, high_water, None)

    floor = max(
        float(exit_cfg["initial_trailing_floor_margin_roi_pct"]),
        high_water - float(exit_cfg["trailing_gap_margin_roi_pct"]),
    )
    if net_roi >= float(exit_cfg["final_target_margin_roi_pct"]):
        action = "close_all_target"
    elif net_roi <= floor:
        action = "close_all_trailing"
    else:
        action = "hold"
    return ExitDecision(action, net_roi, high_water, floor)
