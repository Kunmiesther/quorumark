"""Exchange-side stop verification — the one guard that matters when the
worker dies mid-trade.

Pure. Every worker cycle, for every open position:
    * A resting reduce-only stop order must exist on the same (symbol, side).
    * Its price must be at LEAST as tight as the intended level:
        - long stop: exchange_stop >= intended_stop * (1 - tolerance_pct)
          (i.e. exchange_stop is not looser than intended below entry)
        - short stop: exchange_stop <= intended_stop * (1 + tolerance_pct)
    * Missing or too-loose → emit a RepairDirective and a loud
      `STOP_MISSING_REPAIRED` bot event.

Paper mode (stop_verification.paper_simulate=true): the worker still runs
the check and emits `STOP_VERIFY_OK` / `STOP_VERIFY_WOULD_REPAIR` telemetry
so the code path is exercised before live activation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

from shared.parity_constants import get as _pc_get

TOLERANCE_PCT: float = float(_pc_get("stop_verification", "tolerance_pct"))
MIN_CHECK_INTERVAL_SEC: int = int(_pc_get("stop_verification", "min_check_interval_sec"))
PAPER_SIMULATE: bool = bool(_pc_get("stop_verification", "paper_simulate"))


@dataclass(frozen=True)
class Position:
    id: str
    symbol: str
    side: str            # "long" | "short"
    intended_stop: float


@dataclass(frozen=True)
class ExchangeStopOrder:
    symbol: str
    side: str            # side of the STOP (opposite of position side, but we
                         # match by symbol+position-side via `position_side`
                         # so callers pass whichever field the venue uses)
    position_side: str   # "long" | "short" — which position this stop protects
    stop_price: float
    reduce_only: bool


@dataclass(frozen=True)
class RepairDirective:
    position_id: str
    symbol: str
    side: str
    intended_stop: float
    reason: str          # "missing" | "too_loose" | "not_reduce_only"


def _is_tight_enough(side: str, intended: float, actual: float, tol: float) -> bool:
    if side == "long":
        # stop sits BELOW entry; tighter = higher. Allow up to `tol` slack lower.
        return actual >= intended * (1.0 - tol)
    if side == "short":
        # stop sits ABOVE entry; tighter = lower. Allow up to `tol` slack higher.
        return actual <= intended * (1.0 + tol)
    return False


def verify_position_stops(
    positions: Iterable[Position],
    exchange_orders: Iterable[ExchangeStopOrder],
    tolerance_pct: float = TOLERANCE_PCT,
) -> List[RepairDirective]:
    """Return one RepairDirective per position needing repair. Empty list = healthy."""
    stops_by_key: dict[tuple, list[ExchangeStopOrder]] = {}
    for o in exchange_orders:
        stops_by_key.setdefault((o.symbol, o.position_side), []).append(o)

    out: List[RepairDirective] = []
    for p in positions:
        matches = stops_by_key.get((p.symbol, p.side), [])
        if not matches:
            out.append(RepairDirective(p.id, p.symbol, p.side, p.intended_stop, "missing"))
            continue
        # Consider the TIGHTEST resting stop we have on this position.
        best: Optional[ExchangeStopOrder] = None
        for o in matches:
            if not o.reduce_only:
                continue
            if best is None:
                best = o
            elif p.side == "long" and o.stop_price > best.stop_price:
                best = o
            elif p.side == "short" and o.stop_price < best.stop_price:
                best = o
        if best is None:
            out.append(RepairDirective(p.id, p.symbol, p.side, p.intended_stop, "not_reduce_only"))
            continue
        if not _is_tight_enough(p.side, p.intended_stop, best.stop_price, tolerance_pct):
            out.append(RepairDirective(p.id, p.symbol, p.side, p.intended_stop, "too_loose"))
    return out
