"""Public Aster futures candles and contract filters for the strategy worker.

This client contains no account address, agent key, or order method. It keeps
Aster market observations separate from the existing ApeX public feed.
"""
from __future__ import annotations

import time
from typing import Any, Optional

import requests

from market_data import (
    Feed, FeedIntegrityError, FeedShapeError, FeedTransportError,
    drop_incomplete, validate_series,
)


BASE_URL = "https://fapi.asterdex.com"
MAX_CANDLES = 500
SUPPORTED_INTERVALS = {5: "5m", 15: "15m", 60: "1h", 240: "4h", 1440: "1d"}


class AsterPublicFeed:
    def __init__(self, session: Optional[requests.Session] = None) -> None:
        self.session = session or requests.Session()
        self._contract_cache: dict[str, dict] = {}

    def _get(self, path: str, params: Optional[dict] = None) -> Any:
        try:
            response = self.session.get(BASE_URL + path, params=params or {}, timeout=(5, 10))
        except requests.RequestException as exc:
            raise FeedTransportError(f"Aster {path}: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise FeedTransportError(f"Aster {path}: HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise FeedShapeError(f"Aster {path}: invalid JSON") from exc

    @staticmethod
    def _symbol(symbol: str) -> str:
        normalized = symbol.replace("-", "").upper()
        if normalized not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}:
            raise FeedShapeError("Aster symbol outside TurtleBot scan universe")
        return normalized

    def contract_config(self, symbol: str) -> dict:
        key = self._symbol(symbol)
        if key in self._contract_cache:
            return self._contract_cache[key]
        body = self._get("/fapi/v3/exchangeInfo")
        rows = body.get("symbols") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise FeedShapeError("Aster exchangeInfo symbols missing")
        for row in rows:
            if not isinstance(row, dict) or row.get("symbol") != key:
                continue
            if row.get("status") != "TRADING":
                raise FeedShapeError(f"Aster {key} is not trading")
            filters = {
                f.get("filterType"): f for f in row.get("filters", []) if isinstance(f, dict)
            }
            lot = filters.get("LOT_SIZE")
            price = filters.get("PRICE_FILTER")
            min_notional = filters.get("MIN_NOTIONAL")
            if not all(isinstance(x, dict) for x in (lot, price, min_notional)):
                raise FeedShapeError(f"Aster {key} filters incomplete")
            try:
                result = {
                    "symbol": key,
                    "minOrderSize": float(lot["minQty"]),
                    "stepSize": float(lot["stepSize"]),
                    "maxOrderSize": float(lot["maxQty"]),
                    "tickSize": float(price["tickSize"]),
                    "minNotional": float(min_notional["notional"]),
                }
            except (KeyError, TypeError, ValueError) as exc:
                raise FeedShapeError(f"Aster {key} filter value invalid") from exc
            if any(value <= 0 for name, value in result.items() if name != "symbol"):
                raise FeedShapeError(f"Aster {key} filter non-positive")
            self._contract_cache[key] = result
            return result
        raise FeedShapeError(f"Aster {key} contract not found")

    def tick_size(self, symbol: str, refresh: bool = False) -> float:
        key = self._symbol(symbol)
        if refresh:
            self._contract_cache.pop(key, None)
        return float(self.contract_config(symbol)["tickSize"])

    def fetch(
        self, symbol: str, interval_min: int = 5, need: int = 198,
        now_ms: Optional[int] = None,
    ) -> Feed:
        key = self._symbol(symbol)
        interval = SUPPORTED_INTERVALS.get(interval_min)
        if interval is None or need < 1 or need + 2 > MAX_CANDLES:
            raise ValueError("Aster interval or candle count unsupported")
        fetched_at = int(time.time() * 1000) if now_ms is None else int(now_ms)
        tick = self.tick_size(symbol)
        body = self._get(
            "/fapi/v3/klines",
            {"symbol": key, "interval": interval, "limit": need + 2},
        )
        if not isinstance(body, list):
            raise FeedShapeError("Aster klines is not an array")
        parsed: list[list[float]] = []
        for index, row in enumerate(body):
            if not isinstance(row, list) or len(row) < 7:
                raise FeedShapeError(f"Aster kline {index} malformed")
            try:
                candle = [float(row[i]) for i in (0, 1, 2, 3, 4, 5)]
                close_time = int(row[6])
            except (TypeError, ValueError) as exc:
                raise FeedShapeError(f"Aster kline {index} not numeric") from exc
            expected_close = int(candle[0]) + interval_min * 60_000 - 1
            if close_time != expected_close:
                raise FeedShapeError(f"Aster kline {index} close-time mismatch")
            parsed.append(candle)
        parsed.sort(key=lambda item: item[0])
        completed = drop_incomplete(parsed, interval_min, fetched_at)
        if len(completed) < need:
            raise FeedIntegrityError(f"Aster {key}: {len(completed)} completed candles, need {need}")
        completed = completed[-need:]
        validate_series(completed, interval_min, key)
        return Feed(
            symbol=symbol, interval_min=interval_min, candles=completed,
            tick=tick, last_close_ts_ms=int(completed[-1][0]) + interval_min * 60_000,
            fetched_at_ms=fetched_at, source=BASE_URL,
        )
