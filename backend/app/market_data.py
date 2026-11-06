from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

from .models import Candle


class MarketDataError(ValueError):
    """Raised when supplied market data cannot support a deterministic run."""


def normalize_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def validate_candles(
    candles: Iterable[Candle],
    *,
    source: str = "fixture",
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> list[Candle]:
    rows = list(candles)
    if not rows:
        raise MarketDataError("at least one completed candle is required")
    if not source.strip():
        raise MarketDataError("market-data source attribution is required")

    normalized: list[Candle] = []
    seen: set[datetime] = set()
    previous: datetime | None = None
    for candle in rows:
        timestamp = normalize_timestamp(candle.timestamp)
        if not candle.complete:
            raise MarketDataError(f"incomplete candle rejected at {timestamp.isoformat()}")
        if timestamp in seen:
            raise MarketDataError(f"duplicate candle timestamp: {timestamp.isoformat()}")
        if previous is not None and timestamp <= previous:
            raise MarketDataError("candles must be strictly chronological")
        seen.add(timestamp)
        previous = timestamp
        normalized.append(candle.model_copy(update={"timestamp": timestamp, "source": source.strip()}))

    if max_age_seconds is not None:
        reference = normalize_timestamp(now or datetime.now(timezone.utc))
        age = (reference - normalized[-1].timestamp).total_seconds()
        if age < -60:
            raise MarketDataError("latest candle is in the future")
        if age > max_age_seconds:
            raise MarketDataError(f"market data is stale by {age:.0f} seconds")
    return normalized
