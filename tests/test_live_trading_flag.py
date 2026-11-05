"""LIVE_TRADING_ENABLED flag behavior in bot_worker.

Verifies:
- default (flag unset / "false") → mode stays "paper", intents go out is_live=false
- flag "true" → mode promoted to "live" after ingest activation, intents go out is_live=true
"""
import hashlib
import hmac
import importlib
import json
import os
from unittest.mock import MagicMock, patch


def _reload_worker(env):
    for k in ("LIVE_TRADING_ENABLED",):
        os.environ.pop(k, None)
    os.environ.update(env)
    import bot_worker
    return importlib.reload(bot_worker)


def _make_worker(bw):
    w = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    w.mode = "demo"
    w.credentials_ok = False
    w.status_message = ""
    w.ingest = None
    w._url_var = "SUPABASE_URL"
    w.supabase_url = "https://example.supabase.co"
    return w


def _activate(bw, w):
    fake_ingest = MagicMock()
    fake_ingest.heartbeat.return_value = None
    fake_ingest.read_active_config.return_value = []
    with patch.object(bw, "WorkerIngestClient", return_value=fake_ingest):
        w._activate_live_client()


def test_flag_false_keeps_paper_and_islive_false():
    bw = _reload_worker({"LIVE_TRADING_ENABLED": "false"})
    assert bw.LIVE_TRADING_ENABLED is False

    w = _make_worker(bw)
    _activate(bw, w)
    assert w.mode == "paper"

    captured = {}
    def fake_post(url, data, headers, timeout):
        captured["body"] = json.loads(data)
        r = MagicMock(); r.status_code = 200; r.json.return_value = {"ok": True}
        return r
    with patch.object(bw, "requests") as req, \
         patch.dict(os.environ, {
             "BROKER_SIGNING_SECRET": "s" * 32,
             "TURTLE_BROKER_BASE_URL": "https://broker.example",
         }):
        req.post.side_effect = fake_post
        req.exceptions.RequestException = Exception
        w.submit_order_intent({"symbol": "BTC-USDT"})
    assert captured["body"]["is_live"] is False


def test_flag_true_promotes_live_and_islive_true():
    bw = _reload_worker({"LIVE_TRADING_ENABLED": "true"})
    assert bw.LIVE_TRADING_ENABLED is True

    w = _make_worker(bw)
    _activate(bw, w)
    assert w.mode == "live"

    captured = {}
    def fake_post(url, data, headers, timeout):
        captured["body"] = json.loads(data)
        r = MagicMock(); r.status_code = 200; r.json.return_value = {"ok": True}
        return r
    with patch.object(bw, "requests") as req, \
         patch.dict(os.environ, {
             "BROKER_SIGNING_SECRET": "s" * 32,
             "TURTLE_BROKER_BASE_URL": "https://broker.example",
         }):
        req.post.side_effect = fake_post
        req.exceptions.RequestException = Exception
        w.submit_order_intent({"symbol": "BTC-USDT"})
    assert captured["body"]["is_live"] is True
