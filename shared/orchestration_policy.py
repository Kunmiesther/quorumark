"""Pure portfolio-orchestration policy shared by worker and research replay.

This module does not fetch data, call an LLM, or execute an order. It owns the
clock/capacity contract and stable same-cycle ordering so callers cannot admit
candidates in whichever symbol order they happened to discover.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from shared.parity_constants import get as parity_get


SCAN_UNIVERSE_SIZE = int(parity_get("orchestration", "scan_universe_size"))
MAX_ACTIVE_OPPORTUNITIES = int(
    parity_get("orchestration", "max_active_opportunities")
)
HEALTH_INTERVAL_MIN = int(parity_get("orchestration", "health_interval_min"))
DECISION_INTERVAL_MIN = int(parity_get("orchestration", "decision_interval_min"))

GRADE_RANK = {"D": 1, "C": 2, "B": 3, "A": 4}


@dataclass(frozen=True)
class PortfolioCandidate:
    """Minimum deterministic evidence needed for portfolio ordering."""

    symbol: str
    wallet: str
    side: str
    source: str
    grade: str
    momentum_ratio: Optional[float]

    @property
    def score(self) -> float:
        return GRADE_RANK.get(self.grade, 0) + max(0.0, self.momentum_ratio or 0.0)


def bucket_start_ms(now_ms: int, interval_min: int) -> int:
    step_ms = interval_min * 60_000
    return (int(now_ms) // step_ms) * step_ms


def decision_bucket_ms(now_ms: int) -> int:
    return bucket_start_ms(now_ms, DECISION_INTERVAL_MIN)


def health_bucket_ms(now_ms: int) -> int:
    return bucket_start_ms(now_ms, HEALTH_INTERVAL_MIN)


def rank_cycle_candidates(
    candidates: Iterable[PortfolioCandidate],
) -> list[PortfolioCandidate]:
    """Rank a complete closed-candle batch before any candidate is admitted."""

    return sorted(
        candidates,
        key=lambda candidate: (
            -candidate.score,
            candidate.symbol,
            candidate.wallet,
            candidate.side,
            candidate.source,
        ),
    )


def rank_cycle_symbols(
    candidates: Iterable[PortfolioCandidate],
    universe: Iterable[str],
) -> tuple[list[str], dict[str, int], dict[str, float]]:
    """Return symbols ordered by their strongest same-cycle candidate."""

    ranked = rank_cycle_candidates(candidates)
    best: dict[str, PortfolioCandidate] = {}
    for candidate in ranked:
        best.setdefault(candidate.symbol, candidate)
    ordered = list(best)
    ordered.extend(sorted(set(universe) - set(ordered)))
    ranks = {symbol: index + 1 for index, symbol in enumerate(best)}
    scores = {symbol: candidate.score for symbol, candidate in best.items()}
    return ordered, ranks, scores


def is_confirmed_protective_reversal(
    core_side: Optional[str],
    state_1h: str,
    state_4h: str,
) -> bool:
    """A hedge protects a live 4h thesis only after the 1h turns against it."""

    return (
        core_side == "long"
        and state_4h == "bullish_bos"
        and state_1h == "bearish_bos"
    ) or (
        core_side == "short"
        and state_4h == "bearish_bos"
        and state_1h == "bullish_bos"
    )
