"""Accumulator/Vanguard live-intent bridge (bot_worker.observe_signal §5a).

The normal production strategy leg was observation-only: `submit_order_intent`
was reachable only from the Hunter/Sweep legs and the proof-of-life /
strategy-test commands. These tests pin the repaired path AND every fail-closed
gate around it. No network, no credentials, no orders.
"""
import socket
from unittest.mock import patch

import pytest

import bot_worker as bw
import accumulator_signal as sig


TS, OPEN, HIGH, LOW, CLOSE = sig.TS, sig.OPEN, sig.HIGH, sig.LOW, sig.CLOSE

INTERVAL_MS = bw.SIGNAL_INTERVAL_MIN * 60_000


def _build_bot(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://sthdmulczzebfcmihhca.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    with patch.object(bw.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "fail")), \
         patch.object(bw.time, "sleep", lambda _s: None):
        return bw.RailwayTurtleBot()


class _Zone:
    def __init__(self, level, lower, upper):
        self.level, self.lower, self.upper = level, lower, upper
        self.tolerance = upper - level
        self.assumption = "test"


class _Break:
    def __init__(self, direction, break_ts, zone):
        self.direction = direction
        self.break_ts = break_ts
        self.break_index = 0
        self.zone = zone


class _Retest:
    def __init__(self, direction, retest_index, retest_ts, break_ts, zone):
        self.state = "confirmed"
        self.retest_index = retest_index
        self.retest_ts = retest_ts
        self.break_event = _Break(direction, break_ts, zone)


class _Feed:
    def __init__(self, candles, tick=0.1):
        self.candles, self.tick = candles, tick
        self.age_sec = 1.0


CONTRACT = {"minOrderSize": 0.001, "stepSize": 0.001, "tickSize": 0.1,
            "maxOrderSize": 1000.0, "maxPositionSize": 1000.0,
            "maxPositionValue": 1e9}

# Equity above the $100 external buffer so the pilot ledger produces a real,
# venue-placeable size. Nothing here is a default inside product code — the
# bridge refuses when these inputs are absent (see the missing-input tests).
EQUITY_USD = 600.0


class _FeedClient:
    def __init__(self, feed, contract=CONTRACT):
        self._feed = feed
        self._contract = contract

    def fetch(self, *a, **kw):
        return self._feed

    def contract_config(self, symbol):
        if self._contract is None:
            raise RuntimeError("symbols endpoint down")
        return self._contract


def _candles(n=40, last_ts=None, close=100.0):
    last_ts = last_ts if last_ts is not None else int(1_700_000_000_000)
    out = []
    for i in range(n):
        ts = last_ts - (n - 1 - i) * INTERVAL_MS
        out.append([ts, close, close + 1, close - 1, close, 10.0])
    return out


def _wire(bot, monkeypatch, *, direction="long", authorized=True, retest=True,
          candles=None, zone=None):
    candles = candles if candles is not None else _candles()
    newest = candles[-1]
    zone = zone or _Zone(99.5, 99.0, 100.0)
    feed = _Feed(candles)

    gate = {
        "leg": "accumulator",
        "guard_authorized": authorized,
        "guard_block_code": None if authorized else "entry_guard_rejected",
        "directions": {
            d: {"authorized": (authorized and d == direction), "block_code": None}
            for d in bw.SIGNAL_DIRECTIONS
        },
    }
    monkeypatch.setattr(bw._live, "entry_gate", lambda *a, **kw: gate)
    monkeypatch.setattr(
        bw.accumulator_signal,
        "evaluate",
        lambda _candles, evaluated_direction, _tick: {
            "candles": len(candles),
            "entries": [],
            "test_direction": evaluated_direction,
        },
    )
    r = _Retest(direction, len(candles) - 1, int(newest[TS]),
                int(candles[0][TS]), zone)
    monkeypatch.setattr(
        bw.entry_eligibility,
        "newly_confirmed_entry",
        lambda result, _candles, _r=r: (
            _r if retest and result.get("test_direction") == direction else None
        ),
    )

    submitted = []
    bot.submit_order_intent = lambda intent: (submitted.append(intent) or {"ok": True})
    bot.log_event = lambda *a, **kw: None
    bot._accum_available_equity_usd = lambda *_a, **_kw: EQUITY_USD
    return feed, submitted, int(newest[TS])


CFG = {
    "enabled": True,
    "exchange_type": "apex_omni",
    "symbol": "BTC-USDT",
    "market_type": "futures",
    "mode": "live",
    "status": "verified",
    "permissions_verified": True,
    "permission_trade": True,
}


@pytest.fixture(autouse=True)
def _scope(monkeypatch):
    monkeypatch.setattr(bw, "SIGNAL_EXCHANGE_TYPE", "apex_omni", raising=False)


def _observe(bot, feed, now_ms, contract=CONTRACT):
    return bot.observe_signal(
        CFG, "u1", "c1", now_ms=now_ms, feed=_FeedClient(feed, contract))


def test_eligible_signal_submits_exactly_once(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts + 1000)
    assert len(submitted) == 1
    intent = submitted[0]
    assert intent["side"] == "BUY"
    assert intent["order_type"] == "MARKET"
    assert intent["purpose"] == "CREATE_ORDER"
    assert intent["idempotency_key"].startswith("accum:c1:")
    assert 0 < intent["stop_pct"] <= bw.ACCUM_MAX_STOP_PCT


def test_duplicate_candle_cannot_resubmit(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts + 1000)
    _observe(bot, feed, ts + 2000)
    assert len(submitted) == 1


def test_short_intent_construction(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(
        bot, monkeypatch, direction="short", zone=_Zone(100.5, 100.0, 101.0))
    _observe(bot, feed, ts + 1000)
    assert len(submitted) == 1 and submitted[0]["side"] == "SELL"


def test_rejected_gate_does_not_submit(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch, authorized=False)
    _observe(bot, feed, ts + 1000)
    assert submitted == []


def test_gate_failure_fails_closed(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    def boom(*a, **kw):
        raise RuntimeError("gate down")
    monkeypatch.setattr(bw._live, "entry_gate", boom)
    _observe(bot, feed, ts + 1000)
    assert submitted == []


def test_live_trading_disabled_does_not_submit(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", False)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts + 1000)
    assert submitted == []


def test_stale_candle_does_not_submit(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts + bw.SIGNAL_LIVE_MAX_CANDLE_AGE_MS + 60_000)
    assert submitted == []


def test_historical_confirmation_does_not_submit(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch, retest=False)
    _observe(bot, feed, ts + 1000)
    assert submitted == []


def test_broker_failure_is_recorded_not_retried_same_candle(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    calls = []

    def failing(intent):
        calls.append(intent)
        return {"ok": False, "reject_reason": "NETWORK_ConnectionError"}

    bot.submit_order_intent = failing
    _observe(bot, feed, ts + 1000)
    _observe(bot, feed, ts + 2000)
    # A network failure may be retried on the same candle, but every retry is
    # byte-identical at the durable broker/signer idempotency boundary.
    assert len(calls) == 2
    assert calls[0]["idempotency_key"] == calls[1]["idempotency_key"]
    assert submitted == []


def test_stop_pct_out_of_bounds_refuses(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    # Zone lower far below close -> stop distance > ACCUM_MAX_STOP_PCT.
    feed, submitted, ts = _wire(bot, monkeypatch, zone=_Zone(50.0, 40.0, 60.0))
    _observe(bot, feed, ts + 1000)
    assert submitted == []


def test_stop_pct_zero_width_refuses():
    candles = _candles()
    r = _Retest("long", len(candles) - 1, int(candles[-1][TS]),
                int(candles[0][TS]), _Zone(100.0, 100.0, 100.0))
    assert bw.accumulator_stop_pct(r, candles) is None


def test_intent_venue_is_apex_and_carries_no_credentials(monkeypatch):
    bot = _build_bot(monkeypatch)
    monkeypatch.setattr(bw, "LIVE_TRADING_ENABLED", True)
    feed, submitted, ts = _wire(bot, monkeypatch)
    _observe(bot, feed, ts + 1000)
    intent = submitted[0]
    assert intent["venue"] == "apex_omni"
    blob = repr(intent).lower()
    for banned in ("api_key", "secret", "passphrase", "private", "stark"):
        assert banned not in blob
