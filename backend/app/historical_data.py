from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from .models import Candle


class HistoricalDataError(ValueError):
    pass


def _validate_common(symbol: str, interval: str, limit: int) -> tuple[str, str, int]:
    normalized = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{5,20}", normalized):
        raise HistoricalDataError("Symbol must be an uppercase market symbol such as BTCUSDT")
    if interval not in {"1m", "5m", "15m", "1h", "4h", "1d"}:
        raise HistoricalDataError("Unsupported interval")
    if not 10 <= limit <= 1_000:
        raise HistoricalDataError("Limit must be between 10 and 1,000")
    return normalized, interval, limit


def fetch_binance_klines(symbol: str, interval: str = "1h", limit: int = 200, start_time: int | None = None, end_time: int | None = None) -> tuple[list[Candle], dict[str, Any]]:
    normalized, interval, limit = _validate_common(symbol, interval, limit)
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


def fetch_kraken_ohlc(symbol: str, interval: str = "1h", limit: int = 200) -> tuple[list[Candle], dict[str, Any]]:
    normalized, interval, limit = _validate_common(symbol, interval, limit)
    if not normalized.endswith("USDT"):
        raise HistoricalDataError("The Kraken public adapter currently supports USDT-quoted symbols only")
    pair = normalized.removesuffix("USDT") + "USDT"
    interval_minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1_440}[interval]
    base_url = os.getenv("MARKET_DATA_API_URL", "https://api.kraken.com/0/public/OHLC").strip()
    try:
        response = httpx.get(base_url, params={"pair": pair, "interval": interval_minutes}, timeout=float(os.getenv("MARKET_DATA_REQUEST_TIMEOUT_SECONDS", "15")))
    except httpx.HTTPError as error:
        raise HistoricalDataError("Historical market-data provider could not be reached") from error
    if not response.is_success:
        raise HistoricalDataError(f"Historical market-data provider returned HTTP {response.status_code}")
    try:
        payload = response.json()
        if payload.get("error"):
            raise HistoricalDataError("Kraken rejected the requested market pair or interval")
        rows = next(iter(payload["result"].values()))[-limit:]
        candles = [Candle(timestamp=datetime.fromtimestamp(float(row[0]), tz=timezone.utc), open=float(row[1]), high=float(row[2]), low=float(row[3]), close=float(row[4]), volume=float(row[6]), source=f"kraken:{pair}:{interval}", complete=True) for row in rows]
    except HistoricalDataError:
        raise
    except (TypeError, ValueError, IndexError, KeyError, StopIteration) as error:
        raise HistoricalDataError("Historical market-data provider returned malformed candles") from error
    if len(candles) < 10:
        raise HistoricalDataError("Historical market-data provider returned fewer than 10 candles")
    if any(left.timestamp >= right.timestamp for left, right in zip(candles, candles[1:])):
        raise HistoricalDataError("Historical candles are not strictly chronological")
    return candles, {"provider": "kraken_public", "symbol": pair, "interval": interval, "count": len(candles), "source": candles[0].source}


def fetch_historical(symbol: str, interval: str, limit: int) -> tuple[list[Candle], dict[str, Any]]:
    provider = os.getenv("MARKET_DATA_PROVIDER", "binance_public").strip().lower()
    if provider == "binance_public":
        return fetch_binance_klines(symbol, interval, limit)
    if provider == "kraken_public":
        return fetch_kraken_ohlc(symbol, interval, limit)
    raise HistoricalDataError(f"Historical provider '{provider}' is not enabled; use binance_public or kraken_public")
