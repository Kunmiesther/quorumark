from datetime import datetime, timedelta, timezone

import pytest

from app.historical_data import HistoricalDataError, fetch_coinbase_candles


class _Response:
    status_code = 200
    headers = {}
    is_success = True

    def __init__(self, rows):
        self._rows = rows

    def json(self):
        return self._rows


def test_coinbase_adapter_maps_canonical_symbol_and_rejects_open_bucket(monkeypatch):
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    rows = []
    for index in range(13):
        timestamp = int((now - timedelta(hours=13 - index)).timestamp())
        rows.append([timestamp, "100", "103", "101", "102", "10"])
    rows.append([int(now.timestamp()), "100", "103", "101", "102", "10"])

    def fake_get(url, *, params, timeout):
        assert url.endswith("/products/BTC-USD/candles")
        assert params == {"granularity": 3600}
        return _Response(rows)

    monkeypatch.setattr("app.historical_data.httpx.get", fake_get)
    candles, provenance = fetch_coinbase_candles("BTCUSDT", "1h", 12)

    assert len(candles) == 12
    assert candles[-1].timestamp < now
    assert all(candle.source == "coinbase_exchange:BTC-USD:1h" for candle in candles)
    assert provenance["provider"] == "coinbase_exchange_public"
    assert provenance["provider_symbol"] == "BTC-USD"


def test_coinbase_adapter_maps_provider_errors(monkeypatch):
    class RateLimited(_Response):
        status_code = 429
        is_success = False
        headers = {"Retry-After": "0"}

    monkeypatch.setenv("MARKET_DATA_MAX_RETRIES", "0")
    monkeypatch.setattr("app.historical_data.httpx.get", lambda *args, **kwargs: RateLimited([]))
    with pytest.raises(HistoricalDataError, match="rate limit"):
        fetch_coinbase_candles("ETHUSDT", "4h", 10)


def test_coinbase_adapter_retries_transient_provider_failure(monkeypatch):
    rows = []
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for index in range(10):
        timestamp = int((now - timedelta(hours=10 - index)).timestamp())
        rows.append([timestamp, "100", "103", "101", "102", "10"])

    class TemporaryFailure(_Response):
        status_code = 503
        is_success = False

    calls = {"count": 0}

    def fake_get(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return TemporaryFailure([])
        return _Response(rows)

    monkeypatch.setenv("MARKET_DATA_MAX_RETRIES", "1")
    monkeypatch.setattr("app.historical_data.httpx.get", fake_get)
    candles, _ = fetch_coinbase_candles("BTCUSDT", "1h", 10)
    assert len(candles) == 10
    assert calls["count"] == 2
