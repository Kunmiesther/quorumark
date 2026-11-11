from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from .models import Candle


class HistoricalDataError(ValueError):
    pass


def fetch_binance_klines(symbol: str, interval: str = "1h", limit: int = 200, start_time: int | None = None, end_time: int | None = None) -> tuple[list[Candle], dict[str, Any]]:
    normalized = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{5,20}", normalized):
        raise HistoricalDataError("Symbol must be an uppercase Binance market symbol such as BTCUSDT")
    if interval not in {"1m", "5m", "15m", "1h", "4h", "1d"}:
        raise HistoricalDataError("Unsupported interval")
    if not 10 <= limit <= 1_000:
        raise HistoricalDataError("Limit must be between 10 and 1,000")
    base_url = os.getenv("MARKET_DATA_API_URL", "https://api.binance.com/api/v3/klines").strip()
    params: dict[str, str | int] = {"symbol": normalized, "interval": interval, "limit": limit}
    if start_time is not None:
        params["startTime"] = start_time
    if end_time is not None:
        params["endTime"] = end_time
    try:
        response = httpx.get(base_url, params=params, timeout=float(os.getenv("MARKET_DATA_REQUEST_TIMEOUT_SECONDS", "15")))
    except httpx.HTTPError as error:
        raise HistoricalDataError("Historical market-data provider could not be reached") from error
    if not response.is_success:
        raise HistoricalDataError(f"Historical market-data provider returned HTTP {response.status_code}")
    try:
        rows = response.json()
        candles = [Candle(timestamp=datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc), open=float(row[1]), high=float(row[2]), low=float(row[3]), close=float(row[4]), volume=float(row[5]), source=f"binance:{normalized}:{interval}", complete=True) for row in rows]
    except (TypeError, ValueError, IndexError, KeyError) as error:
        raise HistoricalDataError("Historical market-data provider returned malformed candles") from error
    if len(candles) < 10:
        raise HistoricalDataError("Historical market-data provider returned fewer than 10 candles")
    if any(left.timestamp >= right.timestamp for left, right in zip(candles, candles[1:])):
        raise HistoricalDataError("Historical candles are not strictly chronological")
    return candles, {"provider": "binance_public", "symbol": normalized, "interval": interval, "count": len(candles), "source": candles[0].source}
