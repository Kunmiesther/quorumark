from unittest.mock import Mock
import pytest
import bot_worker
from synfutures_worker_execution import build_entry_intent, SynFuturesIntentError
from shared.synfutures_math import WAD, tick_at_price, price_at_tick, decimal_wad


def config():
    return dict(user_id="user", connection_id="connection", exchange_type="synfutures",
                enabled=True, mode="live", status="verified", environment="mainnet",
                permissions_verified=True, permission_trade=True, params={"margin_usdc":"100", "leverage":33})


def intent(cfg=None, **kw):
    return build_entry_intent(cfg=cfg or config(), live_enabled=True, user_id="user", connection_id="connection",
                             symbol=kw.get("symbol", "BTC-USDC"), direction="long", idempotency_key="campaign-123",
                             strategy=kw.get("strategy", "accumulator"))


def test_request_keeps_exact_margin_and_no_execution_authority():
    sent = intent()
    assert sent["margin_usdc"] == "100" and sent["venue"] == "synfutures"
    assert not {"size", "safe_address", "operator_address", "limit_tick", "verified_account", "protective_exit_ready"} & sent.keys()


@pytest.mark.parametrize("symbol", ["BTC-USDT", "SOL-USDC", "XRP-USDC"])
def test_not_a_cex_symbol_alias(symbol):
    with pytest.raises(SynFuturesIntentError): intent(symbol=symbol)


@pytest.mark.parametrize("margin", [100, 100.0, None, "1e2", "NaN", "-100", "0", "0.0000000000000000001"])
def test_exact_margin_required(margin):
    cfg = config(); cfg["params"]["margin_usdc"] = margin
    with pytest.raises(SynFuturesIntentError): intent(cfg)


def test_read_only_connection_stays_blocked():
    cfg = config(); cfg["permission_trade"] = False
    with pytest.raises(SynFuturesIntentError): intent(cfg)


def test_sweep_cannot_be_translated_to_immediate_entry():
    with pytest.raises(SynFuturesIntentError, match="PARITY_PENDING"): intent(strategy="sweep")


def test_synfutures_feed_never_instantiates_apex(monkeypatch):
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    native = object()
    monkeypatch.setattr(bot_worker.synfutures_market_data, "SynFuturesPublicFeed", lambda: native)
    bot._signal_feed = Mock(side_effect=AssertionError("ApeX fallback"))
    assert bot._signal_feed_for("synfutures") is native
    bot._signal_feed.assert_not_called()


def test_worker_routes_native_intent_and_retains_ambiguous_lock(monkeypatch):
    monkeypatch.setattr(bot_worker, "LIVE_TRADING_ENABLED", True)
    bot = bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot.ingest = Mock(); bot._decision_inflight = set()
    bot.submit_order_intent = Mock(return_value={"status":"ambiguous"})
    args = dict(cfg=config(), user_id="user", connection_id="connection", symbol="BTC-USDC", normalized="BTCUSDC",
                decision={"decision_id":"decision"}, strategy="accumulator", chosen=Mock(direction="long", idempotency_key="campaign-123"),
                gate={}, feed=None, feed_client=None, now=0)
    bot._execute_decision(**args); bot._execute_decision(**args)
    bot.submit_order_intent.assert_called_once()
    assert bot.submit_order_intent.call_args.args[0]["venue"] == "synfutures"
    assert ("user", "connection", "BTC-USDC") in bot._decision_inflight


def test_exact_math_and_geometric_tick_bounds():
    assert price_at_tick(0) == WAD
    assert decimal_wad("100.000001") == 100 * WAD + 10**12
    for tick in (-322517, -10000, 0, 10000, 113000, 443635):
        price = price_at_tick(tick)
        assert tick_at_price(price) == tick
        assert price < price_at_tick(tick + 1)

def test_native_protection_scope_hmac_and_exact_terminal_campaign_unlock(monkeypatch):
    import json,hmac,hashlib
    bot=bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._broker_secret=lambda:'test-secret';bot._broker_base_url=lambda:'https://broker'
    flight=('user','connection','BTC-USDC');other=('user','connection','ETH-USDC')
    bot._decision_inflight={flight,other};bot._synfutures_pending_campaigns={flight:'campaign-123',other:'campaign-456'}
    post=Mock(return_value=Mock(ok=True,json=lambda:{'status':'monitored','resolved_campaign_keys':['campaign-123']}))
    monkeypatch.setattr(bot_worker.requests,'post',post)
    bot._synfutures_protection_pass([config(),config()]);post.assert_called_once()
    sent=post.call_args;raw=sent.kwargs['data'];headers=sent.kwargs['headers'];path='/v1/automation/synfutures/protect'
    assert json.loads(raw)=={'user_id':'user','connection_id':'connection'}
    expected=hmac.new(b'test-secret',b'\n'.join([headers['x-worker-timestamp'].encode(),headers['x-worker-nonce'].encode(),path.encode(),raw]),hashlib.sha256).hexdigest()
    assert headers['x-worker-signature']==expected and flight not in bot._decision_inflight and other in bot._decision_inflight
    bot._synfutures_protection_pass([]);assert post.call_count==2

def test_failed_native_monitor_does_not_unlock_ambiguous_campaign(monkeypatch):
    bot=bot_worker.RailwayTurtleBot.__new__(bot_worker.RailwayTurtleBot)
    bot._broker_secret=lambda:'test';bot._broker_base_url=lambda:'https://broker';flight=('user','connection','BTC-USDC')
    bot._decision_inflight={flight};bot._synfutures_pending_campaigns={flight:'campaign-123'}
    post=Mock(return_value=Mock(ok=False,json=lambda:{'status':'monitored','resolved_campaign_keys':['campaign-123']}))
    monkeypatch.setattr(bot_worker.requests,'post',post);bot._synfutures_protection_pass([config()])
    assert flight in bot._decision_inflight and post.call_count==1
