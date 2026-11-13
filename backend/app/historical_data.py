from __future__ import annotations

import os
import re
import time
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


def _request_public_candles(url: str, params: dict[str, str | int]) -> httpx.Response:
    timeout = float(os.getenv("MARKET_DATA_REQUEST_TIMEOUT_SECONDS", "15"))
    retries = min(max(int(os.getenv("MARKET_DATA_MAX_RETRIES", "2")), 0), 3)
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            response = httpx.get(url, params=params, timeout=timeout)
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == retries:
                return response
            delay = min(float(response.headers.get("Retry-After", "0.5")), 2.0)
            time.sleep(max(delay, 0.0))
        except httpx.HTTPError as error:
            last_error = error
            if attempt == retries:
                break
            time.sleep(min(0.5 * (attempt + 1), 2.0))
    raise HistoricalDataError("Historical market-data provider could not be reached") from last_error


def _validate_provider_rows(candles: list[Candle], *, provider: str, symbol: str, interval: str) -> tuple[list[Candle], dict[str, Any]]:
    if len(candles) < 10:
        raise HistoricalDataError(f"{provider} returned fewer than 10 completed candles")
    if any(left.timestamp >= right.timestamp for left, right in zip(candles, candles[1:])):
        raise HistoricalDataError(f"{provider} returned candles that are not strictly chronological")
    if any(candle.high < max(candle.open, candle.close) or candle.low > min(candle.open, candle.close) for candle in candles):
        raise HistoricalDataError(f"{provider} returned invalid OHLC values")
    return candles, {"provider": provider, "symbol": symbol, "interval": interval, "count": len(candles), "source": candles[0].source}


def fetch_coinbase_candles(symbol: str, interval: str = "1h", limit: int = 200) -> tuple[list[Candle], dict[str, Any]]:
    """Fetch completed public candles from Coinbase Exchange.

    The executable strategy keeps its canonical USDT symbol. Coinbase's public
    market-data products use USD quotes, so BTCUSDT is read from BTC-USD and
    the mapping is retained in provenance rather than changing the strategy.
    """
    normalized, interval, limit = _validate_common(symbol, interval, limit)
    if not normalized.endswith("USDT"):
        raise HistoricalDataError("Coinbase public adapter supports USDT-quoted strategy symbols only")
    product = f"{normalized[:-4]}-USD"
    granularity = {"1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "4h": 14_400, "1d": 86_400}[interval]
    configured_url = os.getenv("MARKET_DATA_API_URL", "").strip()
    url_template = configured_url if "{product}" in configured_url else "https://api.exchange.coinbase.com/products/{product}/candles"
    url = url_template.format(product=product)
    response = _request_public_candles(url, {"granularity": granularity})
    if not response.is_success:
        if response.status_code == 429:
            raise HistoricalDataError("Coinbase public market-data rate limit reached")
        if response.status_code in {401, 403}:
            raise HistoricalDataError("Coinbase public market-data access was denied")
        if response.status_code == 404:
            raise HistoricalDataError(f"Coinbase does not list public market product {product}")
        raise HistoricalDataError(f"Coinbase public market-data provider returned HTTP {response.status_code}")
    try:
        rows = response.json()
        if not isinstance(rows, list):
            raise TypeError("candle response is not a list")
        interval_seconds = granularity
        now = datetime.now(timezone.utc)
        current_bucket = int(now.timestamp()) // interval_seconds * interval_seconds
        candles = []
        for row in sorted(rows, key=lambda item: int(item[0])):
            timestamp = datetime.fromtimestamp(int(row[0]), tz=timezone.utc)
            if int(row[0]) + interval_seconds > current_bucket:
                continue
            candles.append(Candle(timestamp=timestamp, low=float(row[1]), high=float(row[2]), open=float(row[3]), close=float(row[4]), volume=float(row[5]), source=f"coinbase_exchange:{product}:{interval}", complete=True))
        candles = candles[-min(limit, 300):]
    except (TypeError, ValueError, IndexError, KeyError) as error:
        raise HistoricalDataError("Coinbase public market-data provider returned malformed candles") from error
    candles, provenance = _validate_provider_rows(candles, provider="coinbase_exchange_public", symbol=normalized, interval=interval)
    provenance["provider_symbol"] = product
    provenance["quote_mapping"] = "USDT strategy symbol mapped to Coinbase USD market"
    return candles, provenance


def fetch_binance_klines(symbol: str, interval: str = "1h", limit: int = 200, start_time: int | None = None, end_time: int | None = None) -> tuple[list[Candle], dict[str, Any]]:
    normalized, interval, limit = _validate_common(symbol, interval, limit)
    base_url = os.getenv("MARKET_DATA_API_URL", "https://api.binance.com/api/v3/klines").strip()
    params: dict[str, str | int] = {"symbol": normalized, "interval": interval, "limit": limit}
    if start_time is not None:
        params["startTime"] = start_time
    if end_time is not None:
        params["endTime"] = end_time
    try:
        response = _request_public_candles(base_url, params)
    except HistoricalDataError:
        raise
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
        response = _request_public_candles(base_url, {"pair": pair, "interval": interval_minutes})
    except HistoricalDataError:
        raise
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
    provider = os.getenv("MARKET_DATA_PROVIDER", "coinbase_public").strip().lower()
    if provider == "coinbase_public":
        return fetch_coinbase_candles(symbol, interval, limit)
    if provider == "binance_public":
        return fetch_binance_klines(symbol, interval, limit)
    if provider == "kraken_public":
        return fetch_kraken_ohlc(symbol, interval, limit)
    raise HistoricalDataError(f"Historical provider '{provider}' is not enabled; use binance_public or kraken_public")
