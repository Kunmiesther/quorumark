"""
H2 MID-WEIGHTED PYRAMID SWEEP-DCA — deterministic sizing/exit math (Python mirror).

PURE. No I/O. Constants sourced from shared/mainnet_parity_constants.json
("sweep" block) via shared.parity_constants. Bit-identical companion:
src/lib/paper/sweepH2.ts.

Order of operations mirrors the TS module EXACTLY:
    q_i          = (margin_i * leverage) / price_i
    totalQty     = sum(q_i)
    avg_entry    = (totalMargin * leverage) / totalQty
    R            = |avg_entry - stop|
    tp_price     = avg_entry + tp_dir * rr * R

Do not reorder; parity fixtures depend on this.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Literal, Sequence

from shared.parity_constants import group as _group

_S = _group("sweep")

FILL_DEPTH_FRACS: List[float] = list(_S["fill_depth_fracs"])
FILL_WEIGHTS: List[float] = list(_S["fill_weights"])
FLUSH_ZONE_ATR: float = float(_S["flush_zone_atr"])
STOP_BEYOND_EDGE_ATR: float = float(_S["stop_beyond_edge_atr"])
TP_TIERS = list(_S["tp_tiers"])
TIMEOUT_BARS_1H: int = int(_S["timeout_bars_1h"])
HTF_ALIGNMENT_REQUIRED: bool = bool(_S["htf_alignment_required"])
MAX_CONCURRENT_LADDERS: int = int(_S["max_concurrent_ladders"])

Side = Literal["long", "short"]


def _edge_dir(side: Side) -> int:
    return -1 if side == "long" else 1


@dataclass
class H2Rung:
    index: int
    price: float
    margin_usd: float
    weight: float
    qty: float
    depth_frac: float


@dataclass
class H2Ladder:
    side: Side
    level: float
    atr_1h: float
    leverage: float
    total_margin_usd: float
    zone_edge_price: float
    stop_price: float
    rungs: List[H2Rung]


@dataclass
class H2Tier:
    index: int
    label: str
    frac: float
    rr: float
    price: float
    qty: float


@dataclass
class H2Fill:
    price: float
    qty: float
    margin_usd: float


def compute_h2_ladder(
    *,
    side: Side,
    level: float,
    atr_1h: float,
    leverage: float,
    total_margin_usd: float,
) -> H2Ladder:
    if not (atr_1h > 0):
        raise ValueError("compute_h2_ladder: atr_1h must be > 0")
    if not (leverage > 0):
        raise ValueError("compute_h2_ladder: leverage must be > 0")
    if not (total_margin_usd > 0):
        raise ValueError("compute_h2_ladder: total_margin_usd must be > 0")
    if len(FILL_DEPTH_FRACS) != len(FILL_WEIGHTS):
        raise ValueError("compute_h2_ladder: fracs/weights length mismatch")

    d = _edge_dir(side)
    zone_edge = level + d * FLUSH_ZONE_ATR * atr_1h
    stop_price = zone_edge + d * STOP_BEYOND_EDGE_ATR * atr_1h
    total_w = float(sum(FILL_WEIGHTS))
    rungs: List[H2Rung] = []
    for i, (f, w) in enumerate(zip(FILL_DEPTH_FRACS, FILL_WEIGHTS)):
        margin_i = total_margin_usd * (w / total_w)
        price_i = level + d * f * FLUSH_ZONE_ATR * atr_1h
        qty_i = (margin_i * leverage) / price_i
        rungs.append(H2Rung(index=i, price=price_i, margin_usd=margin_i,
                            weight=w, qty=qty_i, depth_frac=f))
    return H2Ladder(side=side, level=level, atr_1h=atr_1h, leverage=leverage,
                    total_margin_usd=total_margin_usd,
                    zone_edge_price=zone_edge, stop_price=stop_price, rungs=rungs)


def recompute_avg_entry(fills: Sequence[H2Fill], leverage: float) -> dict:
    if not fills:
        return {"total_qty": 0.0, "total_notional": 0.0,
                "total_margin_usd": 0.0, "avg_entry": 0.0}
    total_qty = 0.0
    total_margin = 0.0
    for f in fills:
        total_qty += f.qty
        total_margin += f.margin_usd
    total_notional = total_margin * leverage
    avg_entry = (total_notional / total_qty) if total_qty > 0 else 0.0
    return {"total_qty": total_qty, "total_notional": total_notional,
            "total_margin_usd": total_margin, "avg_entry": avg_entry}


def compute_h2_tiers(*, side: Side, avg_entry: float, stop_price: float,
                     total_qty: float) -> dict:
    R = abs(avg_entry - stop_price)
    tp_dir = 1 if side == "long" else -1
    tiers: List[H2Tier] = []
    for i, t in enumerate(TP_TIERS):
        tiers.append(H2Tier(
            index=i, label=t["label"], frac=float(t["frac"]), rr=float(t["rr"]),
            price=avg_entry + tp_dir * float(t["rr"]) * R,
            qty=total_qty * float(t["frac"]),
        ))
    return {"R": R, "tiers": tiers}


def rung_is_filled(side: Side, price: float, bar_high: float, bar_low: float) -> bool:
    return bar_low <= price if side == "long" else bar_high >= price


def tier_is_hit(side: Side, price: float, bar_high: float, bar_low: float) -> bool:
    return bar_high >= price if side == "long" else bar_low <= price


def stop_is_hit(side: Side, stop_price: float, bar_high: float, bar_low: float) -> bool:
    return bar_low <= stop_price if side == "long" else bar_high >= stop_price
