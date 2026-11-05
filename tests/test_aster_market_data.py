from __future__ import annotations

from aster_market_data import AsterPublicFeed
from market_data import FeedShapeError


class Response:
    status_code = 200

    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


class Session:
    def __init__(self, broken_close=False):
        self.broken_close = broken_close
        self.requests = []

    def get(self, url, *, params, timeout):
        self.requests.append((url, params))
        if url.endswith("exchangeInfo"):
            return Response({"symbols": [{
                "symbol": "BTCUSDT", "status": "TRADING", "filters": [
                    {"filterType": "LOT_SIZE", "minQty": "0.001", "maxQty": "100", "stepSize": "0.001"},
                    {"filterType": "PRICE_FILTER", "tickSize": "0.1"},
                    {"filterType": "MIN_NOTIONAL", "notional": "5"},
                ],
            }]})
        step = 300_000
        base = 1_790_000_000_000 - 1_790_000_000_000 % step
        rows = []
        for i in range(4):
            opened = base + i * step
            rows.append([
                opened, "80000", "80100", "79900", "80050", "12",
                opened + step - (2 if self.broken_close else 1),
            ])
        return Response(rows)


def test_public_aster_feed_uses_closed_venue_candles():
    session = Session()
    feed = AsterPublicFeed(session=session).fetch(
        "BTC-USDT", interval_min=5, need=2, now_ms=1_790_001_200_000,
    )
    assert len(feed.candles) == 2
    assert feed.candles[0][1:5] == [80000, 80100, 79900, 80050]
    assert feed.tick == 0.1
    assert session.requests[-1][1] == {"symbol": "BTCUSDT", "interval": "5m", "limit": 4}


def test_public_aster_feed_refuses_wrong_close_time():
    try:
        AsterPublicFeed(session=Session(broken_close=True)).fetch(
            "BTC-USDT", interval_min=5, need=2, now_ms=1_790_001_200_000,
        )
    except FeedShapeError as exc:
        assert "close-time mismatch" in str(exc)
    else:
        raise AssertionError("wrong Aster candle close time was accepted")
