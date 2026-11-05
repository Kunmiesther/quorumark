"""Aster observations must never enter the ApeX order transport."""
from unittest.mock import Mock
import pytest

import bot_worker


def test_aster_feed_is_venue_specific(monkeypatch):
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._signal_feed_client = None
    bot._aster_signal_feed_client = None
    aster_feed = object()
    monkeypatch.setattr(bot_worker.aster_market_data, "AsterPublicFeed", lambda: aster_feed)
    assert bot._signal_feed_for("aster") is aster_feed
    assert bot._signal_feed_for("aster") is aster_feed
    assert bot._signal_feed_client is None


def test_unconfigured_aster_never_falls_through_to_apex(monkeypatch):
    monkeypatch.setattr(bot_worker, "LIVE_TRADING_ENABLED", True)
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot.ingest = Mock()
    bot._execute_decision(
        cfg={"exchange_type": "aster"}, user_id="user", connection_id="connection",
        symbol="BTC-USDT", normalized="BTCUSDT", decision={"decision_id": "decision"},
        strategy="accumulator", chosen=Mock(direction="long"), gate={}, feed=None,
        feed_client=None, now=0,
    )
    bot.ingest.update_decision_execution.assert_called_once_with(
        decision_id="decision", execution_state=bot_worker.EXECUTION_BLOCKED,
        reason_code="CONFIG_NOT_LIVE_MODE",
    )
    bot.ingest.read_account_equity.assert_not_called()


def configured_bot(monkeypatch, result=None):
    monkeypatch.setattr(bot_worker, "LIVE_TRADING_ENABLED", True)
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot.ingest = Mock()
    bot._decision_inflight = set()
    bot._accum_available_equity_usd = Mock(return_value=100)
    bot.submit_order_intent = Mock(return_value=result or {"status": "submitted"})
    cfg = dict(user_id="user", connection_id="connection", exchange_type="aster",
               enabled=True, mode="live", status="verified", environment="production",
               permissions_verified=True, permission_trade=True,
               params={"leverage": 125, "dynamic_wallet_sizing": True})
    return bot, cfg


def run_aster(bot, cfg, symbol="BTC-USDT"):
    bot._execute_decision(cfg=cfg, user_id="user", connection_id="connection",
        symbol=symbol, normalized=symbol.replace("-", ""), decision={"decision_id": "decision"},
        strategy="accumulator", chosen=Mock(direction="long", idempotency_key="decision-1234"),
        gate={}, feed=None, feed_client=None, now=0)


@pytest.mark.parametrize("symbol", ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"])
def test_configured_aster_uses_its_own_broker_contract(monkeypatch, symbol):
    bot, cfg = configured_bot(monkeypatch)
    run_aster(bot, cfg, symbol)
    sent = bot.submit_order_intent.call_args.args[0]
    assert sent["venue"] == "aster" and sent["connection_id"] == "connection"
    assert sent["symbol"] == symbol and sent["leverage"] == 125
    assert sent["campaign_rung_count"] == 5
    assert not {"size", "stop_pct", "tp_tiers", "price"}.intersection(sent)
    assert not bot._decision_inflight


@pytest.mark.parametrize("leverage", [None, True, 125.5, 126, "NaN", 0])
def test_aster_never_invents_or_raises_leverage(monkeypatch, leverage):
    bot, cfg = configured_bot(monkeypatch)
    cfg["params"]["leverage"] = leverage
    run_aster(bot, cfg)
    bot.submit_order_intent.assert_not_called()


def test_ambiguous_aster_retains_connection_scoped_lock(monkeypatch):
    bot, cfg = configured_bot(monkeypatch, {"status": "ambiguous", "reject_reason": "TIMEOUT"})
    run_aster(bot, cfg)
    run_aster(bot, cfg)
    assert bot.submit_order_intent.call_count == 1
    assert ("user", "connection", "BTC-USDT") in bot._decision_inflight


def test_other_exchange_inflight_does_not_block_aster(monkeypatch):
    bot, cfg = configured_bot(monkeypatch)
    bot._decision_inflight.add(("user", "apex-connection", "BTC-USDT"))
    run_aster(bot, cfg)
    bot.submit_order_intent.assert_called_once()


def test_partial_result_is_not_a_rejection_that_can_be_retried():
    state, evidence = bot_worker.RailwayTurtleBot._classify_apex_result({
        "status": "partial", "reject_reason": "LATER_RUNG_FAILED", "reconciliation_required": True,
        "filled_size": "0.02", "reduce_only": False, "private_key": "must-not-persist"})
    assert state == bot_worker.EXECUTION_AMBIGUOUS
    assert evidence["reconciliation_required"] is True
    assert evidence["filled_size"] == "0.02"
    assert evidence["reduce_only"] is False
    assert "private_key" not in evidence


def test_transport_timeout_is_ambiguous(monkeypatch):
    bot, _ = configured_bot(monkeypatch)
    bot._broker_secret = Mock(return_value="test")
    bot._broker_base_url = Mock(return_value="https://broker.test")
    monkeypatch.setattr(bot_worker.requests, "post", Mock(side_effect=bot_worker.requests.exceptions.Timeout()))
    result = bot_worker.RailwayTurtleBot.submit_order_intent(bot, {"venue": "aster"})
    assert result["status"] == "ambiguous"


@pytest.mark.parametrize("error,expected", [
    ("INVALID_AUTOMATION_SIGNATURE", "INVALID_AUTOMATION_SIGNATURE"),
    ("AUTOMATION_TIMESTAMP_SKEW", "AUTOMATION_TIMESTAMP_SKEW"),
    ("sensitive diagnostic text", "HTTP_401"),
])
def test_broker_auth_diagnostics_are_bounded_and_wire_bytes_signed(monkeypatch, error, expected):
    import hashlib
    import hmac
    bot, _ = configured_bot(monkeypatch)
    bot._broker_secret = Mock(return_value="test")
    bot._broker_base_url = Mock(return_value="https://broker.test")
    response = Mock(status_code=401)
    response.json.return_value = {"error": error}
    post = Mock(return_value=response)
    monkeypatch.setattr(bot_worker.requests, "post", post)
    # configured_bot replaces submit; invoke the real transport explicitly.
    result = bot_worker.RailwayTurtleBot.submit_order_intent(bot, {"size": 1079.0, "stop_pct": 1e-7})
    assert result["reject_reason"] == expected
    sent = post.call_args.kwargs
    headers = sent["headers"]
    assert headers["x-worker-signature-version"] == "raw-v1"
    signed = b"\n".join([headers["x-worker-timestamp"].encode(), headers["x-worker-nonce"].encode(), b"/v1/automation/orders", sent["data"]])
    assert headers["x-worker-signature"] == hmac.new(b"test", signed, hashlib.sha256).hexdigest()


def test_contract_cache_keeps_exchange_limits_separate():
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._venue_contract_cache = {}
    apex, aster = Mock(), Mock()
    apex.contract_config.return_value = {"tickSize": "0.1"}
    aster.contract_config.return_value = {"tickSize": "0.01"}
    for _ in range(2):
        assert bot._venue_contract_config("BTC-USDT", apex) == {"tickSize": "0.1"}
        assert bot._venue_contract_config(
            "BTC-USDT", aster, exchange_type="aster",
        ) == {"tickSize": "0.01"}
    apex.contract_config.assert_called_once()
    aster.contract_config.assert_called_once()
    bot._reset_venue_contract_cache()
    bot._venue_contract_config("BTC-USDT", aster, exchange_type="aster")
    assert aster.contract_config.call_count == 2


def test_contract_lookup_failure_does_not_poison_other_exchange():
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._venue_contract_cache = {}
    apex, aster = Mock(), Mock()
    apex.contract_config.side_effect = RuntimeError("unavailable")
    aster.contract_config.return_value = {"tickSize": "0.01"}
    assert bot._venue_contract_config("BTC-USDT", apex) is None
    assert bot._venue_contract_config(
        "BTC-USDT", aster, exchange_type="aster",
    ) == {"tickSize": "0.01"}


def test_contract_lookup_chooses_requested_venue_when_feed_is_omitted():
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._venue_contract_cache = {}
    aster = Mock()
    aster.contract_config.return_value = {"tickSize": "0.01"}
    bot._signal_feed_for = Mock(return_value=aster)
    assert bot._venue_contract_config(
        "BTC-USDT", exchange_type="aster",
    ) == {"tickSize": "0.01"}
    bot._signal_feed_for.assert_called_once_with("aster")
