"""Observational signal integration — bot_worker.observe_signal().

NOTHING here touches the network. The ApeX feed is driven through a fake
`requests.Session`, so the REAL market_data code path runs (including
drop_incomplete and validate_series) against synthetic bytes shaped like the
verified 2026-07-16 live capture.

The central claim under test is negative: this path EXECUTES NOTHING. Several
tests exist only to prove absence — no order, no broker call, no signing, no
POST, no evaluation when it is not allowed to evaluate.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import accumulator_signal
import bot_worker as bw
import market_data
import worker_ingest_client as wic

USER = "11111111-1111-4111-8111-111111111111"
CONN = "22222222-2222-4222-8222-222222222222"
STEP_MS = bw.SIGNAL_INTERVAL_MIN * 60_000
BASE_TS = 1_784_169_900_000  # from the verified live capture, 15m-aligned


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, body, status=200):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeSession:
    """Records every request so tests can prove what was and was not called."""

    def __init__(self, klines_body=None, symbols_body=None, raise_exc=None):
        self.calls = []
        self.raise_exc = raise_exc
        self.symbols_body = symbols_body if symbols_body is not None else {
            "data": {"contractConfig": {"perpetualContract": [
                {"symbol": "BTC-USDT", "crossSymbolName": "BTCUSDT", "tickSize": "0.1"},
            ]}}
        }
        self.klines_body = klines_body

    def get(self, url, params=None, timeout=None):
        self.calls.append({"method": "GET", "url": url, "params": params})
        if self.raise_exc is not None:
            raise self.raise_exc
        if market_data.SYMBOLS_PATH in url:
            return FakeResponse(self.symbols_body)
        if market_data.KLINES_PATH in url:
            return FakeResponse(self.klines_body)
        raise AssertionError(f"unexpected URL: {url}")

    def post(self, *a, **k):  # pragma: no cover - must never happen
        raise AssertionError("the observational feed must never POST")


class FakeIngest:
    """Stands in for WorkerIngestClient. Records emitted events."""

    def __init__(self, emit_exc=None):
        self.events = []
        self.emit_exc = emit_exc
        self.heartbeats = []

    def emit_event(self, *, code, level="info", message="", user_id=None, detail=None):
        if code not in wic.ALLOWED_EVENT_CODES:
            raise ValueError(f"event code not allowed: {code}")
        if self.emit_exc is not None:
            raise self.emit_exc
        self.events.append({
            "code": code, "level": level, "message": message,
            "user_id": user_id, "detail": detail or {},
        })
        return {"ok": True}

    def heartbeat(self, *, status, mode, version=None, health=None):
        self.heartbeats.append({"status": status, "mode": mode})
        return {"ok": True}

    def read_active_config(self):
        return []

    def read_execution_guard(self, *, user_id, connection_id):  # pragma: no cover
        raise AssertionError("observe_signal must never read the guard itself")


def make_rows(n, last_open_ts=BASE_TS, symbol="BTCUSDT", interval="15", price=1900.0):
    """n contiguous 15m rows ascending, ending at last_open_ts, live key order."""
    rows = []
    start = last_open_ts - (n - 1) * STEP_MS
    for k in range(n):
        o = price + (k % 17) * 0.6 - (k % 5) * 0.4
        c = o + ((k % 7) - 3) * 0.5
        h = max(o, c) + 0.3
        lo = min(o, c) - 0.3
        rows.append({
            "s": symbol, "i": interval, "t": start + k * STEP_MS,
            "c": f"{c:.2f}", "h": f"{h:.2f}", "l": f"{lo:.2f}",
            "o": f"{o:.2f}", "v": "12.5", "tr": "23750.5",
        })
    return rows


def envelope(rows, symbol="BTCUSDT"):
    return {"data": {symbol: rows}, "timeCost": 2123}


def make_bot():
    """A worker with the constructor bypassed — we are unit-testing the
    observational method, not the boot sequence (covered in test_bot_worker)."""
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = FakeIngest()
    bot.mode = "paper"
    bot.credentials_ok = True
    bot.status_message = "test"
    bot.supabase = None
    bot._signal_feed_client = None
    bot._signal_seen = {}
    bot._failed_ingest_calls = 0
    bot._first_cycle_after_boot = False
    bot._post_recovery_pending = False
    bot._last_connectivity_check = 0.0
    return bot


def feed_with(rows):
    """Real ApexPublicFeed over a fake session — exercises the real parser."""
    session = FakeSession(klines_body=envelope(rows))
    return market_data.ApexPublicFeed(session=session), session


def cfg(**over):
    base = {
        "user_id": USER, "connection_id": CONN,
        "exchange_type": "apex_omni", "symbol": "BTC-USDT",
        "market_type": "futures", "cross_margin": True,
        "mode": "paper", "enabled": True, "params": {},
        "environment": "test", "status": "verified",
    }
    base.update(over)
    return base


def test_mandate_only_enables_selected_routed_turtles():
    mandate = cfg(params={"enabled_turtles": ["accumulator", "sniper"]})
    assert bw.routed_turtle_enabled(mandate, "accumulator")
    assert bw.routed_turtle_enabled(mandate, "sweep")
    assert not bw.routed_turtle_enabled(mandate, "vanguard")
    assert not bw.routed_turtle_enabled(mandate, "hunter")
    assert not bw.routed_turtle_enabled(mandate, "unknown")


def test_legacy_rows_without_mandate_keep_existing_routing():
    assert bw.routed_turtle_enabled(cfg(params={}), "hunter")


# `now` one minute into the candle AFTER the newest row -> newest row is the
# last COMPLETED candle, and the row at BASE_TS is still forming.
NOW_FORMING = BASE_TS + 60_000


# ---------------------------------------------------------------------------
# 4. Disabled configuration: no feed, no evaluator, no event
# ---------------------------------------------------------------------------
def test_disabled_config_does_nothing():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    with patch.object(accumulator_signal, "evaluate") as ev:
        out = bot.observe_signal(cfg(enabled=False), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out is None
    assert session.calls == []          # no feed request
    ev.assert_not_called()              # no evaluation
    assert bot.ingest.events == []      # no event


@pytest.mark.parametrize("value", [None, 0, "", "true", "True", 1, [], {}])
def test_enabled_must_be_exactly_true(value):
    """`enabled is not True` — truthy look-alikes must not enable observation."""
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    out = bot.observe_signal(cfg(enabled=value), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out is None
    assert session.calls == []
    assert bot.ingest.events == []


def test_non_apex_exchange_ignored():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    out = bot.observe_signal(cfg(exchange_type="btcc"), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out is None
    assert session.calls == []
    assert bot.ingest.events == []


# ---------------------------------------------------------------------------
# 5. Halted configuration: guard placement preserved
# ---------------------------------------------------------------------------
class _StopLoop(Exception):
    pass


def _run_one_cycle(bot):
    with patch.object(bw.time, "sleep", side_effect=_StopLoop):
        try:
            bot.run()
        except _StopLoop:
            pass


def test_halted_config_never_reaches_observe_signal():
    bot = make_bot()
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=True)
    bot.observe_signal = MagicMock()
    _run_one_cycle(bot)
    bot.halted.assert_called_once_with(USER, CONN)
    bot.observe_signal.assert_not_called()   # guard contract preserved exactly


def test_unhalted_config_reaches_observe_signal():
    bot = make_bot()
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=False)
    bot.observe_signal = MagicMock(return_value="evaluated")
    _run_one_cycle(bot)
    bot.observe_signal.assert_called_once()


def test_halted_config_performs_no_feed_or_event():
    bot = make_bot()
    session_probe = FakeSession(klines_body=envelope(make_rows(200)))
    bot._signal_feed_client = market_data.ApexPublicFeed(session=session_probe)
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=True)
    with patch.object(accumulator_signal, "evaluate") as ev:
        _run_one_cycle(bot)
    assert session_probe.calls == []
    ev.assert_not_called()
    assert bot.ingest.events == []


# ---------------------------------------------------------------------------
# 6. Unsupported market type: skip WITHOUT fetching
# ---------------------------------------------------------------------------
def test_spot_market_skips_without_fetching():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    with patch.object(accumulator_signal, "evaluate") as ev:
        out = bot.observe_signal(cfg(market_type="spot"), USER, CONN,
                                 now_ms=NOW_FORMING, feed=feed)
    assert out == "skipped"
    assert session.calls == []           # NOT fetched
    ev.assert_not_called()               # NOT evaluated
    assert len(bot.ingest.events) == 1
    d = bot.ingest.events[0]["detail"]
    assert bot.ingest.events[0]["code"] == "SIGNAL_EVALUATION"
    assert d["status"] == "skipped"
    assert d["reason_code"] == "UNSUPPORTED_MARKET_TYPE"
    assert d["execution_performed"] is False
    assert d["market_type_seen"] == "spot"


def test_futures_is_the_canonical_perpetual_value():
    """`market_type` is the Postgres enum `account_mode` = {spot, futures}.
    'futures' is the repository's perpetual spelling; nothing else is invented."""
    assert set(bw.ACCEPTED_PERPETUAL_MARKET_TYPES) == {"futures"}


def test_spot_skip_deduplicates_within_a_candle():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    c = cfg(market_type="spot")
    assert bot.observe_signal(c, USER, CONN, now_ms=NOW_FORMING, feed=feed) == "skipped"
    assert bot.observe_signal(c, USER, CONN, now_ms=NOW_FORMING + 15_000, feed=feed) is None
    assert len(bot.ingest.events) == 1   # not once per 15s loop


def test_missing_symbol_skips():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    out = bot.observe_signal(cfg(symbol=None), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out == "skipped"
    assert session.calls == []
    assert bot.ingest.events[0]["detail"]["reason_code"] == "MISSING_SYMBOL"
    assert bot.ingest.events[0]["detail"]["execution_performed"] is False


# ---------------------------------------------------------------------------
# 7 + 8. Successful path: both directions, completed candles only
# ---------------------------------------------------------------------------
def test_success_evaluates_long_and_short():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    real = accumulator_signal.evaluate
    seen = []

    def spy(candles, direction, tick):
        seen.append(direction)
        return real(candles, direction, tick)

    with patch.object(accumulator_signal, "evaluate", side_effect=spy):
        out = bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)

    assert out == "evaluated"
    assert seen == ["long", "short"]
    d = bot.ingest.events[0]["detail"]
    assert set(d["directions"].keys()) == {"long", "short"}


def test_only_one_event_for_both_directions():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert len(bot.ingest.events) == 1


def test_forming_candle_never_reaches_either_evaluator_call():
    """The newest row is still forming at NOW_FORMING. It must not appear in
    the candles handed to EITHER direction — this is the lookahead guard."""
    bot = make_bot()
    rows = make_rows(200)
    feed, _ = feed_with(rows)
    captured = []

    def spy(candles, direction, tick):
        captured.append([int(c[0]) for c in candles])
        return accumulator_signal.evaluate.__wrapped__(candles, direction, tick) \
            if hasattr(accumulator_signal.evaluate, "__wrapped__") else \
            {"candles": len(candles), "swings_raw": 0, "swings_grouped": 0,
             "breaks": [], "retests": [], "entries": []}

    with patch.object(accumulator_signal, "evaluate", side_effect=spy):
        bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)

    forming_open = int(rows[-1]["t"])          # BASE_TS — still forming
    last_completed = forming_open - STEP_MS
    assert len(captured) == 2
    for ts_list in captured:
        assert forming_open not in ts_list     # the whole point
        assert ts_list[-1] == last_completed
    d = bot.ingest.events[0]["detail"]
    assert d["newest_completed_candle_ts_ms"] == last_completed


def test_reported_candle_count_matches_need():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    d = bot.ingest.events[0]["detail"]
    assert d["candle_count"] == bw.SIGNAL_NEED_CANDLES == 198
    assert d["directions"]["long"]["candles"] == 198


# ---------------------------------------------------------------------------
# 9. Malformed / discontinuous data prevents evaluation
# ---------------------------------------------------------------------------
def _assert_error_event_without_evaluation(bot, feed, expect_reason):
    with patch.object(accumulator_signal, "evaluate") as ev:
        out = bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out == "error"
    ev.assert_not_called()
    d = bot.ingest.events[0]["detail"]
    assert d["status"] == "error"
    assert d["reason_code"] == expect_reason
    assert d["execution_performed"] is False
    return d


def test_gap_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200)
    del rows[100]                      # one missing bar — never forward-filled
    feed, _ = feed_with(rows)
    _assert_error_event_without_evaluation(bot, feed, "FEED_INTEGRITY_ERROR")


def test_duplicate_timestamp_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200)
    rows[50] = dict(rows[49])
    feed, _ = feed_with(rows)
    _assert_error_event_without_evaluation(bot, feed, "FEED_INTEGRITY_ERROR")


def test_misaligned_timestamp_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200)
    for r in rows:
        r["t"] += 1000
    feed, _ = feed_with(rows)
    _assert_error_event_without_evaluation(bot, feed, "FEED_INTEGRITY_ERROR")


def test_invalid_ohlc_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200)
    rows[80]["h"] = "0.01"             # high below low/close
    feed, _ = feed_with(rows)
    _assert_error_event_without_evaluation(bot, feed, "FEED_INTEGRITY_ERROR")


def test_symbol_mismatch_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200, symbol="ETHUSDT")
    session = FakeSession(klines_body={"data": {"BTCUSDT": rows}, "timeCost": 1})
    feed = market_data.ApexPublicFeed(session=session)
    _assert_error_event_without_evaluation(bot, feed, "FEED_SHAPE_ERROR")


def test_interval_mismatch_prevents_evaluation():
    bot = make_bot()
    rows = make_rows(200, interval="5")
    feed, _ = feed_with(rows)
    _assert_error_event_without_evaluation(bot, feed, "FEED_SHAPE_ERROR")


def test_empty_data_prevents_evaluation():
    bot = make_bot()
    session = FakeSession(klines_body={"data": {}, "timeCost": 2123})
    feed = market_data.ApexPublicFeed(session=session)
    _assert_error_event_without_evaluation(bot, feed, "FEED_SHAPE_ERROR")


def test_malformed_envelope_prevents_evaluation():
    bot = make_bot()
    session = FakeSession(klines_body={"result": []})
    feed = market_data.ApexPublicFeed(session=session)
    _assert_error_event_without_evaluation(bot, feed, "FEED_SHAPE_ERROR")


def test_network_failure_prevents_evaluation():
    import requests
    bot = make_bot()
    session = FakeSession(raise_exc=requests.exceptions.ConnectionError())
    feed = market_data.ApexPublicFeed(session=session)
    _assert_error_event_without_evaluation(bot, feed, "FEED_TRANSPORT_ERROR")


def test_missing_tick_size_prevents_evaluation():
    bot = make_bot()
    session = FakeSession(
        klines_body=envelope(make_rows(200)),
        symbols_body={"data": {"contractConfig": {"perpetualContract": []}}},
    )
    feed = market_data.ApexPublicFeed(session=session)
    d = _assert_error_event_without_evaluation(bot, feed, "FEED_SHAPE_ERROR")
    assert "not found in contractConfig" in d["error_text"]


def test_short_series_prevents_evaluation():
    bot = make_bot()
    feed, _ = feed_with(make_rows(60))     # fewer than need=198
    _assert_error_event_without_evaluation(bot, feed, "FEED_INTEGRITY_ERROR")


def test_error_event_is_not_mislabelled():
    """A feed failure is a SIGNAL_EVALUATION error — never a connectivity
    event, a config read, or an order result."""
    import requests
    bot = make_bot()
    session = FakeSession(raise_exc=requests.exceptions.ConnectionError())
    feed = market_data.ApexPublicFeed(session=session)
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    codes = [e["code"] for e in bot.ingest.events]
    assert codes == ["SIGNAL_EVALUATION"]
    for bad in ("CONNECTIVITY_DEGRADED", "CONFIG_READ", "ORDER_INTENT_RESULT",
                "ORDER_INTENT_NETWORK_ERROR"):
        assert bad not in codes


def test_evaluator_exception_reported_not_raised():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    with patch.object(accumulator_signal, "evaluate", side_effect=RuntimeError("boom")):
        out = bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert out == "error"
    d = bot.ingest.events[0]["detail"]
    assert d["reason_code"] == "EVALUATOR_RuntimeError"
    assert d["execution_performed"] is False


# ---------------------------------------------------------------------------
# 10. execution_performed is always false
# ---------------------------------------------------------------------------
def test_success_event_reports_execution_performed_false():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    ev = bot.ingest.events[0]
    assert ev["code"] == "SIGNAL_EVALUATION"
    assert ev["detail"]["execution_performed"] is False
    assert ev["detail"]["status"] == "evaluated"


def test_every_status_reports_execution_performed_false():
    """evaluated | skipped | error — all three, no exceptions."""
    import requests
    seen = {}

    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    seen["evaluated"] = bot.ingest.events[-1]["detail"]

    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(market_type="spot"), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    seen["skipped"] = bot.ingest.events[-1]["detail"]

    bot = make_bot()
    feed = market_data.ApexPublicFeed(session=FakeSession(raise_exc=requests.exceptions.Timeout()))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    seen["error"] = bot.ingest.events[-1]["detail"]

    assert set(seen) == {"evaluated", "skipped", "error"}
    for status, d in seen.items():
        assert d["status"] == status
        assert d["execution_performed"] is False


def test_required_payload_fields_present():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    d = bot.ingest.events[0]["detail"]
    for field in ("status", "observation_id", "symbol", "interval_min",
                  "interval_source", "newest_completed_candle_ts_ms",
                  "evaluated_at", "age_sec", "tick_size", "candle_count",
                  "execution_performed", "directions", "assumptions"):
        assert field in d, field
    assert d["interval_min"] == 15
    assert d["interval_source"] == "orchestration_policy"
    assert d["tick_size"] == 0.1
    for name in ("long", "short"):
        s = d["directions"][name]
        for field in ("candles", "swings_raw", "swings_grouped", "breaks",
                      "retests", "entries", "retest_states", "entry_summaries"):
            assert field in s, f"{name}.{field}"
    assert d["assumptions"]["B12_confirmation_candle_atr"] is True
    assert d["assumptions"]["ATR_IMPLEMENTATIONS_AGREE"] is True


def test_age_sec_recorded_and_never_thresholded():
    """B-6 defines no staleness bound. age_sec is evidence, not a gate."""
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    very_late = BASE_TS + 60_000 + 3_600_000   # an hour stale
    out = bot.observe_signal(cfg(), USER, CONN, now_ms=very_late, feed=feed)
    assert out == "evaluated"                   # NOT halted, NOT skipped
    d = bot.ingest.events[0]["detail"]
    assert d["age_sec"] == 2760.0   # now - newest 15m candle CLOSE
    assert d["age_sec"] > 2700
    assert d["status"] == "evaluated"


# ---------------------------------------------------------------------------
# 11. Projection stays under the 4KB detail limit
# ---------------------------------------------------------------------------
def test_real_projection_well_under_limit():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    d = bot.ingest.events[0]["detail"]
    assert bw._detail_len(d) < bw.SIGNAL_DETAIL_HARD_LIMIT_BYTES


def test_worst_case_bounded_projection_under_limit():
    """Max entry summaries in both directions, worst-case magnitudes."""
    entry = {
        "state": "confirmed", "direction": "long",
        "break_index": 197, "break_ts_ms": 1784169900000,
        "retest_index": 197, "retest_ts_ms": 1784169900000,
        "zone_level": 123456.12345678, "zone_tolerance": 9876.87654321,
        "zone_assumption": "S26_break_candle_atr",
    }
    direction = {
        "candles": 198, "swings_raw": 999, "swings_grouped": 999,
        "breaks": 999, "retests": 999, "entries": 999,
        "retest_states": {s: 999 for s in bw.SIGNAL_RETEST_STATES},
        "entry_summaries": [dict(entry) for _ in range(bw.SIGNAL_MAX_ENTRY_SUMMARIES)],
        "entry_summaries_truncated": True,
    }
    detail = {
        "status": "evaluated", "observation_id": "f" * 32,
        "symbol": "BTC-USDT", "normalized_symbol": "BTCUSDT",
        "interval_min": 15, "interval_source": "orchestration_policy",
        "newest_completed_candle_ts_ms": 1784169900000,
        "evaluated_at": "2026-07-16T02:45:00Z", "execution_performed": False,
        "age_sec": 99999.9, "tick_size": 0.000001, "candle_count": 198,
        "directions": {"long": direction, "short": dict(direction)},
        "assumptions": {"B12_confirmation_candle_atr": True,
                        "ATR_IMPLEMENTATIONS_AGREE": True},
    }
    assert bw._detail_len(detail) < bw.SIGNAL_DETAIL_HARD_LIMIT_BYTES
    assert bw._detail_len(bw.bound_signal_detail(detail)) < bw.SIGNAL_DETAIL_HARD_LIMIT_BYTES


def test_oversized_projection_sheds_entry_summaries_first():
    entry = {"state": "confirmed", "direction": "long", "break_index": 1,
             "break_ts_ms": 1784169900000, "retest_index": 2,
             "retest_ts_ms": 1784169900000, "zone_level": 1.0,
             "zone_tolerance": 1.0, "zone_assumption": "S26_break_candle_atr"}
    huge = {"candles": 198, "swings_raw": 1, "swings_grouped": 1, "breaks": 1,
            "retests": 1, "entries": 400,
            "retest_states": {s: 1 for s in bw.SIGNAL_RETEST_STATES},
            "entry_summaries": [dict(entry) for _ in range(400)],
            "entry_summaries_truncated": True}
    detail = {
        "status": "evaluated", "observation_id": "a" * 32, "symbol": "BTC-USDT",
        "normalized_symbol": "BTCUSDT", "interval_min": 15,
        "interval_source": "orchestration_policy", "newest_completed_candle_ts_ms": 1,
        "evaluated_at": "2026-07-16T02:45:00Z", "execution_performed": False,
        "directions": {"long": huge, "short": dict(huge)},
    }
    assert bw._detail_len(detail) > bw.SIGNAL_DETAIL_HARD_LIMIT_BYTES
    out = bw.bound_signal_detail(detail)
    assert bw._detail_len(out) <= bw.SIGNAL_DETAIL_HARD_LIMIT_BYTES
    assert out["directions"]["long"]["entry_summaries"] == []
    assert out["directions"]["long"]["entry_summaries_omitted"] is True
    # Identity survives whatever else is shed.
    assert out["execution_performed"] is False
    assert out["observation_id"] == "a" * 32


def test_entry_summaries_are_bounded_by_constant():
    class FakeZone:
        level = 1.5; tolerance = 0.2; assumption = "S26_break_candle_atr"

    class FakeBreak:
        direction = "long"; break_index = 3; break_ts = 1784169900000.0; zone = FakeZone()

    class FakeRetest:
        state = "confirmed"; break_event = FakeBreak()
        retest_index = 4; retest_ts = 1784170200000.0

    result = {"candles": 198, "swings_raw": 9, "swings_grouped": 8,
              "breaks": [1] * 40, "retests": [FakeRetest()] * 40,
              "entries": [FakeRetest()] * 40}
    s = bw.summarize_direction(result)
    assert s["entries"] == 40
    assert len(s["entry_summaries"]) == bw.SIGNAL_MAX_ENTRY_SUMMARIES == 3
    assert s["entry_summaries_truncated"] is True


def test_dataclasses_are_never_serialized():
    """The evaluator returns frozen dataclasses. If one reached the payload,
    json.dumps would raise — which is exactly what must not happen."""
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    d = bot.ingest.events[0]["detail"]
    json.dumps(d)  # must not raise
    blob = json.dumps(d)
    for leak in ("BreakEvent", "RetestResult", "Swing(", "Zone("):
        assert leak not in blob


def test_payload_survives_the_secret_pattern_scanner():
    """The edge function rejects /0x[a-fA-F0-9]{40,}/ outright. The
    observation_id must not trip it."""
    import re
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    blob = json.dumps(bot.ingest.events[0]["detail"])
    assert not re.search(r"0x[a-fA-F0-9]{40,}", blob)
    assert not re.search(r"sb_(publishable|secret)_", blob)
    assert not re.search(r"eyJ[A-Za-z0-9_\-]{20,}\.", blob)
    assert not bot.ingest.events[0]["detail"]["observation_id"].startswith("0x")


# ---------------------------------------------------------------------------
# 12. Nothing executes
# ---------------------------------------------------------------------------
def test_feed_issues_only_public_gets():
    bot = make_bot()
    rows = make_rows(200)
    session = FakeSession(klines_body=envelope(rows))
    feed = market_data.ApexPublicFeed(session=session)
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert session.calls, "expected the public feed to be used"
    for call in session.calls:
        assert call["method"] == "GET"
        assert call["url"].endswith((market_data.SYMBOLS_PATH, market_data.KLINES_PATH))


def test_observational_path_calls_no_order_or_broker_function():
    """REWRITTEN — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: asserted `submit_order_intent` did not exist at all. The owner
    reinstated it, so its existence is no longer the control.

    THE CONTROL NOW: the OBSERVATIONAL path must never call it. Observation
    executes nothing regardless of what the worker is capable of elsewhere.
    """
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.submit_order_intent = MagicMock(side_effect=AssertionError("observation must not submit"))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    bot.submit_order_intent.assert_not_called()
    for name in ("create_order", "place_order", "sign", "submit", "withdraw"):
        assert not hasattr(market_data.ApexPublicFeed, name)
    assert [e["code"] for e in bot.ingest.events] == ["SIGNAL_EVALUATION"]


def test_guard_blocks_order_intent_path_entirely():
    """REWRITTEN — Stage 0.5 reversal, owner-authorized 2026-07-17.

    WAS: grepped the worker source for `requests.post(url`. That is now legal
    (the restored broker path uses it) and the grep was vocabulary, not
    behavior.

    THE CONTROL NOW: a halted configuration reaches neither observation nor
    order-intent creation. The guard's `continue` precedes both.
    """
    bot = make_bot()
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=True)
    bot.observe_signal = MagicMock()
    bot.submit_order_intent = MagicMock()
    _run_one_cycle(bot)
    bot.halted.assert_called_once_with(USER, CONN)
    bot.observe_signal.assert_not_called()
    bot.submit_order_intent.assert_not_called()


def test_submission_uses_process_live_flag_not_caller_input():
    """`is_live` is process-controlled — never caller-controlled."""
    import inspect
    src = inspect.getsource(bw.RailwayTurtleBot.submit_order_intent)
    assert 'body["is_live"] = LIVE_TRADING_ENABLED' in src


def test_service_role_credentials_remain_rejected():
    """The reversal did NOT relax the Stage 0.5 credential invariant."""
    assert "SUPABASE_SERVICE_ROLE_KEY" in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS
    assert "SUPABASE_SECRET_KEY" in bw.RailwayTurtleBot._FORBIDDEN_KEY_VARS


def test_feed_module_holds_no_credential_surface():
    for name in ("APEX_API_KEY", "api_key_credentials", "passphrase", "zk_seeds"):
        assert not hasattr(market_data, name)


# ---------------------------------------------------------------------------
# 13 / 14 / 15. Deduplication
# ---------------------------------------------------------------------------
def test_same_candle_emits_once():
    bot = make_bot()
    rows = make_rows(200)
    feed, _ = feed_with(rows)
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed) == "evaluated"
    for offset in (15_000, 30_000, 45_000, 60_000, 120_000):
        assert bot.observe_signal(cfg(), USER, CONN,
                                  now_ms=NOW_FORMING + offset, feed=feed) is None
    assert len(bot.ingest.events) == 1


def test_next_completed_candle_emits_once():
    bot = make_bot()
    rows = make_rows(200)
    feed, _ = feed_with(rows)
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed) == "evaluated"

    # The candle at BASE_TS has now closed; the feed's newest completed moves on.
    later = BASE_TS + STEP_MS + 60_000
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=later, feed=feed) == "evaluated"
    assert len(bot.ingest.events) == 2

    a, b = (e["detail"] for e in bot.ingest.events)
    assert b["newest_completed_candle_ts_ms"] - a["newest_completed_candle_ts_ms"] == STEP_MS
    assert a["observation_id"] != b["observation_id"]

    # ...and the new one also dedups.
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=later + 15_000, feed=feed) is None
    assert len(bot.ingest.events) == 2


def test_changed_result_for_same_candle_logs_but_does_not_reemit(caplog):
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed) == "evaluated"
    assert len(bot.ingest.events) == 1

    mutated = {"candles": 198, "swings_raw": 42, "swings_grouped": 41,
               "breaks": [], "retests": [], "entries": []}
    with caplog.at_level("WARNING"):
        with patch.object(accumulator_signal, "evaluate", return_value=mutated):
            out = bot.observe_signal(cfg(), USER, CONN,
                                     now_ms=NOW_FORMING + 15_000, feed=feed)
    assert out is None
    assert len(bot.ingest.events) == 1          # suppressed, not re-emitted
    msgs = "\n".join(r.getMessage() for r in caplog.records)
    assert "result changed for an already-observed" in msgs
    assert "not a new observation" in msgs


def test_result_hash_excludes_timing():
    """The hash must cover evaluator output only. If evaluated_at or age_sec
    leaked in, every cycle would look like a changed result."""
    d1 = {"long": {"entries": 1}, "short": {"entries": 0}}
    d2 = {"long": {"entries": 1}, "short": {"entries": 0}}
    assert bw.signal_result_hash(d1) == bw.signal_result_hash(d2)
    d3 = {"long": {"entries": 2}, "short": {"entries": 0}}
    assert bw.signal_result_hash(d1) != bw.signal_result_hash(d3)


def test_result_hash_is_key_order_independent():
    assert bw.signal_result_hash({"a": 1, "b": 2}) == bw.signal_result_hash({"b": 2, "a": 1})


def test_dedup_key_excludes_the_result():
    """Explicit ruling: the result must never be part of the key."""
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    key = next(iter(bot._signal_seen))
    assert len(key) == 5
    assert key == (USER, CONN, "BTCUSDT", 15, BASE_TS - STEP_MS)
    assert isinstance(bot._signal_seen[key], str)  # hash stored BESIDE the key


def test_dedup_is_scoped_per_user_and_connection():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    other = "33333333-3333-4333-8333-333333333333"
    assert bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed) == "evaluated"
    assert bot.observe_signal(cfg(user_id=other), other, CONN,
                              now_ms=NOW_FORMING, feed=feed) == "evaluated"
    assert len(bot.ingest.events) == 2


def test_cache_evicts_beyond_the_documented_candle_bound():
    bot = make_bot()
    prefix = (USER, CONN, "BTCUSDT", 5)
    newest = BASE_TS
    for i in range(200):
        bot._signal_seen[prefix + (newest - i * STEP_MS,)] = "h"
    assert len(bot._signal_seen) == 200
    bot._prune_signal_cache(prefix, newest)
    assert len(bot._signal_seen) == bw.SIGNAL_DEDUP_MAX_CANDLES
    oldest_kept = min(k[4] for k in bot._signal_seen)
    assert oldest_kept >= newest - bw.SIGNAL_DEDUP_MAX_CANDLES * STEP_MS


def test_cache_does_not_grow_unbounded_across_candles():
    bot = make_bot()
    for i in range(60):
        now = BASE_TS + i * STEP_MS + 60_000
        rows = make_rows(200, last_open_ts=BASE_TS + i * STEP_MS)
        feed, _ = feed_with(rows)
        bot.observe_signal(cfg(), USER, CONN, now_ms=now, feed=feed)
    assert len(bot.ingest.events) == 60
    assert len(bot._signal_seen) <= bw.SIGNAL_DEDUP_MAX_CANDLES


def test_transient_event_failure_is_retried_next_cycle():
    bot = make_bot()
    bot.ingest = FakeIngest(emit_exc=wic.WorkerIngestTransientError("HTTP_503"))
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert bot._signal_seen == {}          # NOT marked observed
    bot.ingest = FakeIngest()
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING + 15_000, feed=feed)
    assert len(bot.ingest.events) == 1     # retried and landed


def test_permanent_event_rejection_is_not_retried():
    bot = make_bot()
    bot.ingest = FakeIngest(emit_exc=wic.WorkerIngestAuthError("HTTP_400_DETAIL_TOO_LARGE"))
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert len(bot._signal_seen) == 1      # marked; retrying every 15s helps nobody


# ---------------------------------------------------------------------------
# 16. Heartbeat survives every failure
# ---------------------------------------------------------------------------
def test_heartbeat_survives_feed_failure():
    import requests
    bot = make_bot()
    bot._signal_feed_client = market_data.ApexPublicFeed(
        session=FakeSession(raise_exc=requests.exceptions.ConnectionError()))
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=False)
    _run_one_cycle(bot)
    assert bot.ingest.heartbeats, "heartbeat must still fire after a feed failure"


def test_heartbeat_survives_evaluator_failure():
    bot = make_bot()
    bot._signal_feed_client = market_data.ApexPublicFeed(
        session=FakeSession(klines_body=envelope(make_rows(200))))
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=False)
    with patch.object(accumulator_signal, "evaluate", side_effect=RuntimeError("boom")):
        _run_one_cycle(bot)
    assert bot.ingest.heartbeats


def test_heartbeat_survives_event_insert_failure():
    bot = make_bot()
    bot.ingest = FakeIngest(emit_exc=wic.WorkerIngestTransientError("HTTP_503"))
    bot._signal_feed_client = market_data.ApexPublicFeed(
        session=FakeSession(klines_body=envelope(make_rows(200))))
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=False)
    _run_one_cycle(bot)
    assert bot.ingest.heartbeats


def test_unexpected_observation_exception_does_not_kill_the_loop(caplog):
    bot = make_bot()
    bot.fetch_active_configs = lambda: [cfg()]
    bot.halted = MagicMock(return_value=False)
    bot.observe_signal = MagicMock(side_effect=MemoryError("catastrophe"))
    with caplog.at_level("WARNING"):
        _run_one_cycle(bot)          # must not propagate
    assert bot.ingest.heartbeats
    assert "raised unexpectedly" in "\n".join(r.getMessage() for r in caplog.records)


def test_guard_and_config_reads_unaffected_by_signal_work():
    bot = make_bot()
    bot.fetch_active_configs = MagicMock(return_value=[cfg()])
    bot.halted = MagicMock(return_value=False)
    bot.observe_signal = MagicMock(side_effect=RuntimeError("boom"))
    _run_one_cycle(bot)
    bot.fetch_active_configs.assert_called_once()
    bot.halted.assert_called_once_with(USER, CONN)


# ---------------------------------------------------------------------------
# 17. Deterministic observation_id
# ---------------------------------------------------------------------------
def test_observation_id_is_stable():
    a = bw.build_observation_id(USER, CONN, "BTCUSDT", 5, BASE_TS)
    b = bw.build_observation_id(USER, CONN, "BTCUSDT", 5, BASE_TS)
    assert a == b
    assert len(a) == 32 and all(ch in "0123456789abcdef" for ch in a)


def test_observation_id_varies_with_every_input():
    base = bw.build_observation_id(USER, CONN, "BTCUSDT", 5, BASE_TS)
    assert bw.build_observation_id("other", CONN, "BTCUSDT", 5, BASE_TS) != base
    assert bw.build_observation_id(USER, "other", "BTCUSDT", 5, BASE_TS) != base
    assert bw.build_observation_id(USER, CONN, "ETHUSDT", 5, BASE_TS) != base
    assert bw.build_observation_id(USER, CONN, "BTCUSDT", 15, BASE_TS) != base
    assert bw.build_observation_id(USER, CONN, "BTCUSDT", 5, BASE_TS + STEP_MS) != base


def test_observation_id_survives_a_restart():
    """Same inputs, a brand-new worker object: identical id. This is what lets
    a downstream reader collapse a duplicate the worker cannot prevent."""
    rows = make_rows(200)
    ids = []
    for _ in range(2):
        bot = make_bot()                       # simulates a fresh container
        feed, _s = feed_with(rows)
        bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
        ids.append(bot.ingest.events[0]["detail"]["observation_id"])
    assert ids[0] == ids[1]


def test_symbol_normalization_matches_the_wire_form():
    assert bw.normalize_signal_symbol("BTC-USDT") == "BTCUSDT"
    assert bw.normalize_signal_symbol("BTCUSDT") == "BTCUSDT"


def test_candle_bucket_floors_to_the_interval():
    assert bw.signal_candle_bucket_ms(BASE_TS) == BASE_TS
    assert bw.signal_candle_bucket_ms(BASE_TS + 1) == BASE_TS
    assert bw.signal_candle_bucket_ms(BASE_TS + STEP_MS - 1) == BASE_TS
    assert bw.signal_candle_bucket_ms(BASE_TS + STEP_MS) == BASE_TS + STEP_MS


# ---------------------------------------------------------------------------
# 18. Restart limitation is documented
# ---------------------------------------------------------------------------
def test_restart_limitation_is_documented():
    doc = bw.RailwayTurtleBot.observe_signal.__doc__ or ""
    assert "RESTART LIMITATION" in doc
    assert "in-memory" in doc
    assert "does not promise" in doc.lower() or "not promise" in doc.lower()
    assert "observation_id" in doc


def test_dedup_state_is_in_memory_only():
    """No table was authorised (G32) and none is used. A fresh worker starts
    with an empty cache — that is the documented limitation, made visible."""
    bot = make_bot()
    assert bot._signal_seen == {}
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    assert len(bot._signal_seen) == 1
    restarted = make_bot()
    assert restarted._signal_seen == {}   # cross-restart dedup NOT promised


# ---------------------------------------------------------------------------
# 19. G33 is never synthesized
# ---------------------------------------------------------------------------
def test_g33_term_absent_from_worker_source():
    """`original_first_entry_target` is undefined and blocks v1.1 ratification.
    Nothing in the observational path may define, infer, or substitute it."""
    with open("bot_worker.py", encoding="utf-8") as f:
        src = f.read()
    # It may be NAMED in the docstring as an open blocker; it must never be
    # assigned a value.
    for forbidden in (
        "original_first_entry_target =",
        "original_first_entry_target=",
        '"original_first_entry_target":',
        "'original_first_entry_target':",
    ):
        assert forbidden not in src


def test_g33_never_appears_in_the_payload():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    blob = json.dumps(bot.ingest.events[0]["detail"])
    assert "original_first_entry_target" not in blob


def test_payload_carries_no_take_profit_or_termination_reasoning():
    """The observational path reports ENTRY structure only. Cycle termination
    is undefined while G33 is open, so nothing here may imply it."""
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    blob = json.dumps(bot.ingest.events[0]["detail"]).lower()
    for term in ("take_profit", "tp_", "rung", "sell_rest_full_close",
                 "exit_target", "close_target", "cycle_complete"):
        assert term not in blob


def test_evaluator_assumptions_are_surfaced_not_hidden():
    bot = make_bot()
    feed, _ = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    a = bot.ingest.events[0]["detail"]["assumptions"]
    assert a["B12_confirmation_candle_atr"] is True
    assert a["ATR_IMPLEMENTATIONS_AGREE"] is accumulator_signal.ATR_IMPLEMENTATIONS_AGREE
    # B-12 is pilot-scoped, NOT globally ratified. Owner ruling 2026-07-17.
    assert a["B12_scope"] == "ACCUMULATOR_MAINNET_PILOT_V0"
    assert a["B12_globally_ratified"] is False


# ---------------------------------------------------------------------------
# Interval provenance
# ---------------------------------------------------------------------------
def test_interval_is_declared_as_spec_derived_not_configured():
    assert bw.SIGNAL_INTERVAL_MIN == 15
    assert bw.GUARDIAN_INTERVAL_MIN == 5
    assert bw.SIGNAL_INTERVAL_SOURCE == "orchestration_policy"


def test_interval_is_not_read_from_config():
    """No interval column exists and none is added. A config claiming an
    interval must not change the observation."""
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    bot.observe_signal(cfg(interval_min=15), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    d = bot.ingest.events[0]["detail"]
    assert d["interval_min"] == 15
    assert d["interval_source"] == "orchestration_policy"
    klines = [c for c in session.calls if market_data.KLINES_PATH in c["url"]]
    assert klines[0]["params"]["interval"] == "15"


def test_feed_requests_the_verified_limit():
    bot = make_bot()
    feed, session = feed_with(make_rows(200))
    bot.observe_signal(cfg(), USER, CONN, now_ms=NOW_FORMING, feed=feed)
    klines = [c for c in session.calls if market_data.KLINES_PATH in c["url"]]
    assert klines[0]["params"]["limit"] == 200      # need 198 + 2
    assert klines[0]["params"]["symbol"] == "BTCUSDT"
