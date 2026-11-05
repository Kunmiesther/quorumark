"""Verified connections can be observed without inventing trade authority."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import bot_worker
from worker_ingest_client import WorkerIngestAuthError


STEP = bot_worker.SIGNAL_INTERVAL_MIN * 60_000
OPEN = 1_790_000_000_000 - 1_790_000_000_000 % STEP
NOW = OPEN + STEP + 60_000


def make_bot():
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot.ingest = Mock()
    bot._signal_seen = {}
    bot._signal_feed_client = None
    bot._aster_signal_feed_client = None
    bot._decide_and_execute = Mock(side_effect=AssertionError("watch placed a decision"))
    return bot


def config(venue):
    return {
        "user_id": "user", "connection_id": f"{venue}-connection",
        "exchange_type": venue, "symbol": "BTC-USDT",
        "enabled": True, "scan_only": True, "mode": "watch",
    }


def test_market_watch_records_each_venue_without_decision():
    bot = make_bot()
    feed = Mock()
    feed.fetch.return_value = SimpleNamespace(
        candles=[[OPEN, 1, 2, 0.5, 1.5, 10]], age_sec=60,
    )
    for venue in ("apex_omni", "aster"):
        cfg = config(venue)
        assert bot.observe_market_watch(cfg, "user", cfg["connection_id"], NOW, feed) == "market_watch"
        assert bot.observe_market_watch(cfg, "user", cfg["connection_id"], NOW, feed) is None
    assert feed.fetch.call_count == 2
    assert bot.ingest.emit_event.call_count == 2
    for call in bot.ingest.emit_event.call_args_list:
        assert call.kwargs["code"] == "MARKET_WATCH"
        detail = call.kwargs["detail"]
        assert detail["scan_only"] is True
        assert detail["strategy_configured"] is False
        assert detail["decision_recorded"] is False
        assert detail["execution_performed"] is False
        assert detail["close"] == 1.5
        assert detail["volume"] == 10
    bot._decide_and_execute.assert_not_called()


def test_market_watch_requires_scan_only_and_supported_venue():
    bot = make_bot()
    feed = Mock()
    assert bot.observe_market_watch({**config("aster"), "scan_only": False}, "user", "c", NOW, feed) is None
    assert bot.observe_market_watch(config("other"), "user", "c", NOW, feed) is None
    feed.fetch.assert_not_called()
    bot.ingest.emit_event.assert_not_called()


def test_market_watch_does_not_mark_unpersisted_candle_seen():
    bot = make_bot()
    bot.ingest.emit_event.side_effect = WorkerIngestAuthError("unauthorized")
    feed = Mock()
    feed.fetch.return_value = SimpleNamespace(
        candles=[[OPEN, 1, 2, 0.5, 1.5, 10]], age_sec=60,
    )
    cfg = config("aster")
    assert bot.observe_market_watch(cfg, "user", cfg["connection_id"], NOW, feed) == "market_watch"
    assert bot._signal_seen == {}
    assert bot.observe_market_watch(cfg, "user", cfg["connection_id"], NOW, feed) == "market_watch"
    assert bot.ingest.emit_event.call_count == 2


def test_worker_ingest_supplies_watch_targets_without_credential_fields():
    source = (Path(__file__).parents[1] / "supabase/functions/worker-ingest/index.ts").read_text()
    block = source.split("async function handleConfigRead(", 1)[1].split("function sanitizeParams(", 1)[0]
    assert '.from("exchange_connections")' in block
    assert '.select("id, user_id, exchange, environment, status, permission_read")' in block
    assert 'scan_only: true' in block
    assert 'scan_only: false' in block
    assert 'mode: "watch"' in block
    assert "api_key" not in block
    assert "api_secret" not in block


def test_live_planner_rejects_read_only_venue_before_writing_strategy_rows():
    source = (Path(__file__).parents[1] / "supabase/functions/autopilot-plan/index.ts").read_text()
    assert '.select("id,status,permissions_verified,permission_read,permission_trade")' in source
    assert "liveSetup && (connections ?? []).some((connection) => !connection.permission_trade)" in source
    assert source.index("liveSetup && (connections ?? []).some") < source.index('const rows = venueAssignments.map')
