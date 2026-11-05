"""Integration tests for the LIVE-READINESS wiring in bot_worker.py.

Every test stubs the WorkerIngestClient reads/writes so nothing hits the
network. The tests prove that each call site fires end-to-end through the
existing guardian_pass / observe_signal plumbing:

  * observe_signal attaches an entry_gate block; lockout blocks a candidate.
  * guardian_pass emits a close directive with reason='max_loss_cap' when
    the pure predicate trips.
  * guardian_pass emits promote_runner + cancel_fixed_tp + set_breakeven_stop
    directives for a profitable, aligned, not-yet-promoted position.
  * guardian_pass runs stop verification every cycle and attaches
    STOP_VERIFY_OK / STOP_VERIFY_WOULD_REPAIR telemetry to decision evidence.
  * guardian_pass writes shadow-ledger rows via insert_shadow_ledger, and a
    server-side rejection is swallowed (no cycle failure).
"""
from __future__ import annotations

import time
from typing import Any, Optional
from unittest.mock import MagicMock

import bot_worker as bw
import market_data
import scout_guardian
import worker_live_wiring as wlw
from worker_ingest_client import WorkerIngestAuthError


CANDLE_MS = 5 * 60_000


def _synthetic_candles(n: int = 220, start_close: float = 100.0, step: float = 0.02) -> list:
    """Deterministic ascending series long enough for regime + HTF BOS."""
    now = int(time.time() * 1000) // CANDLE_MS * CANDLE_MS
    base_ts = now - n * CANDLE_MS
    candles = []
    close = start_close
    for i in range(n):
        o = close
        close = close + step
        h = max(o, close) + 0.05
        low = min(o, close) - 0.05
        candles.append([base_ts + i * CANDLE_MS, o, h, low, close, 10.0])
    return candles


def _make_bot() -> bw.RailwayTurtleBot:
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = MagicMock()
    bot.mode = "paper"
    bot.credentials_ok = True
    bot._guardian_stale_cycles = {}
    bot._signal_feed_client = None
    bot._current_lockout_set = set()
    bot._signal_seen = {}
    bot.status_message = "ok"
    return bot


class _StubFeed:
    def __init__(self, candles, tick=0.01):
        self._candles = candles
        self._tick = tick

    def fetch(self, symbol, interval_min, need, now_ms=None):
        f = MagicMock()
        f.candles = self._candles
        f.tick = self._tick
        f.age_sec = 1.0
        return f


# ─────────────────────────────────────────────────────────────────────────────
# entry_gate wiring in observe_signal
# ─────────────────────────────────────────────────────────────────────────────
def test_observe_signal_attaches_entry_gate():
    bot = _make_bot()
    bot.ingest.emit_event.return_value = {"ok": True}
    candles = _synthetic_candles(220)
    feed = _StubFeed(candles)
    cfg = {"enabled": True, "exchange_type": "apex_omni",
           "market_type": "futures", "symbol": "BTC-USDT"}
    status = bot.observe_signal(cfg, "u1", "c1", now_ms=int(time.time() * 1000), feed=feed)
    assert status == "evaluated"
    call = bot.ingest.emit_event.call_args
    detail = call.kwargs["detail"]
    assert "entry_gate" in detail
    gate = detail["entry_gate"]
    assert set(gate.get("directions", {})) == {"long", "short"}


def test_observe_signal_reports_lockout_block():
    bot = _make_bot()
    bot.ingest.emit_event.return_value = {"ok": True}
    candles = _synthetic_candles(220)
    feed = _StubFeed(candles)
    # Pre-seed the cycle lockout as if a guardian close just fired for BTCUSDT long.
    bot._current_lockout_set = {("BTCUSDT", "long")}
    cfg = {"enabled": True, "exchange_type": "apex_omni",
           "market_type": "futures", "symbol": "BTC-USDT"}
    bot.observe_signal(cfg, "u1", "c1", now_ms=int(time.time() * 1000), feed=feed)
    detail = bot.ingest.emit_event.call_args.kwargs["detail"]
    long_dir = detail["entry_gate"]["directions"]["long"]
    assert long_dir["lockout"] is True
    assert long_dir["authorized"] is False
    assert long_dir["block_code"] in ("reentry_lockout", "no_regime", "wait_regime", "no_leg")


# ─────────────────────────────────────────────────────────────────────────────
# guardian_pass — max-loss + HTF promotion + stop verify + shadow ledger
# ─────────────────────────────────────────────────────────────────────────────
def _install_market(bot, symbol, candles, tick=0.01):
    feed = _StubFeed(candles, tick)
    bot._signal_feed_client = feed
    return feed


def _stub_ingest_positions(bot, positions):
    bot.ingest.read_open_positions.return_value = positions
    bot.ingest.upsert_guardian_directives.return_value = {"ok": True}
    bot.ingest.insert_guardian_decisions.return_value = {"ok": True}
    bot.ingest.insert_shadow_ledger.return_value = {"ok": True}


def _underwater_long_position(symbol="BTC-USDT"):
    # entry way above current mark → -PnL >> margin*0.5.
    return {
        "id": "pos-ml-1",
        "user_id": "u1",
        "wallet_key": "w1",
        "symbol": symbol,
        "direction": "long",
        "strategy": "accumulator",
        "entry_price": 1000.0,      # far above the ~100 synthetic mark
        "size_qty": 1.0,
        "margin": 10.0,             # worst = (~100 - 1000) * 1 = -900 >> 5
        "stop_level": 950.0,
        "entry_candle_ts_ms": 0,
    }


def test_max_loss_close_directive_emitted():
    bot = _make_bot()
    candles = _synthetic_candles(220, start_close=100.0)
    pos = _underwater_long_position()
    _install_market(bot, pos["symbol"], candles)
    _stub_ingest_positions(bot, [pos])

    out = bot.guardian_pass(now_ms=int(candles[-1][0]) + CANDLE_MS)
    assert out is not None

    sent = bot.ingest.upsert_guardian_directives.call_args_list
    assert sent, "expected at least one directive batch"
    all_dirs = [d for call in sent for d in call.args[0]]
    close_dirs = [d for d in all_dirs
                  if d["directive_type"] == scout_guardian.DIRECTIVE_CLOSE_POSITION
                  and d["reason_code"] == "max_loss_cap"]
    assert close_dirs, f"expected max_loss_cap close; got {[d['reason_code'] for d in all_dirs]}"


def _promotable_long_position(symbol="BTC-USDT"):
    # profitable long: entry well below the synthetic ~100 mark.
    return {
        "id": "pos-htf-1",
        "user_id": "u1",
        "wallet_key": "w1",
        "symbol": symbol,
        "direction": "long",
        "strategy": "accumulator",
        "entry_price": 50.0,
        "size_qty": 1.0,
        "margin": 500.0,
        "stop_level": 45.0,
        "entry_candle_ts_ms": 0,
        "promoted": False,
    }


def test_htf_promotion_directives_emitted(monkeypatch):
    bot = _make_bot()
    candles = _synthetic_candles(240, start_close=100.0, step=0.05)
    pos = _promotable_long_position()
    _install_market(bot, pos["symbol"], candles)
    _stub_ingest_positions(bot, [pos])

    # Force HTF detector to align with a long — keeps test independent of
    # the underlying pivot / ATR permutation for the synthetic series.
    monkeypatch.setattr(
        wlw.htf_bos, "detect_htf_bos",
        lambda htf, tick: wlw.htf_bos.HtfBosResult(
            state="bullish_bos", confirmed_at_ts=int(candles[-1][0]),
            broken_level=99.0, bars_since_confirm=1,
        ),
    )

    bot.guardian_pass(now_ms=int(candles[-1][0]) + CANDLE_MS)

    all_dirs = [d for call in bot.ingest.upsert_guardian_directives.call_args_list
                for d in call.args[0]]
    types = {d["directive_type"] for d in all_dirs}
    assert {"promote_runner", "cancel_fixed_tp", "set_breakeven_stop"} <= types


def test_stop_verify_telemetry_each_cycle():
    bot = _make_bot()
    candles = _synthetic_candles(220)
    # A neutral position (no max-loss trigger, no HTF alignment) so we
    # observe stop-verify wiring in isolation.
    pos = {
        "id": "pos-sv-1",
        "user_id": "u1",
        "wallet_key": "w1",
        "symbol": "BTC-USDT",
        "direction": "long",
        "strategy": "accumulator",
        "entry_price": float(candles[-1][4]),
        "size_qty": 1.0,
        "margin": 1000.0,
        "stop_level": float(candles[-1][4]) * 0.95,
        "entry_candle_ts_ms": 0,
    }
    _install_market(bot, pos["symbol"], candles)
    _stub_ingest_positions(bot, [pos])

    out = bot.guardian_pass(now_ms=int(candles[-1][0]) + CANDLE_MS)
    assert out["stop_verify"]["checked"] == 1
    # Paper mode → no exchange orders → position marked WOULD_REPAIR (missing).
    assert out["stop_verify"]["would_repair"] == 1
    assert out["stop_verify"]["paper_simulate"] is True

    # And the per-decision evidence carries the STOP_VERIFY_* status.
    sent = bot.ingest.insert_guardian_decisions.call_args_list
    assert sent
    dec = sent[0].args[0][0]
    parity = dec["detail"].get("parity") or {}
    assert parity.get("stop_verify", {}).get("status") in (
        "STOP_VERIFY_OK", "STOP_VERIFY_WOULD_REPAIR",
    )


def test_guardian_runs_once_per_five_minute_health_bucket():
    bot = _make_bot()
    candles = _synthetic_candles(220)
    _stub_ingest_positions(bot, [])

    first_now = int(candles[-1][0]) + CANDLE_MS
    first = bot.guardian_pass(now_ms=first_now)
    duplicate = bot.guardian_pass(now_ms=first_now + 15_000)
    next_bucket = bot.guardian_pass(now_ms=first_now + CANDLE_MS)

    assert first["health_bucket_ms"] == first_now
    assert duplicate["skipped"] == "health_bucket_already_checked"
    assert next_bucket["health_bucket_ms"] == first_now + CANDLE_MS
    assert bot.ingest.read_open_positions.call_count == 2


def test_shadow_ledger_write_swallows_server_rejection():
    bot = _make_bot()
    candles = _synthetic_candles(220)
    pos = {
        "id": "pos-sh-1", "user_id": "u1", "wallet_key": "w1",
        "symbol": "BTC-USDT", "direction": "long", "strategy": "accumulator",
        "entry_price": float(candles[-1][4]), "size_qty": 1.0, "margin": 500.0,
        "stop_level": float(candles[-1][4]) * 0.95, "entry_candle_ts_ms": 0,
    }
    _install_market(bot, pos["symbol"], candles)
    _stub_ingest_positions(bot, [pos])
    # Simulate the SHADOW_LEDGER_INSERT op not yet being enabled server-side.
    bot.ingest.insert_shadow_ledger.side_effect = WorkerIngestAuthError(
        "HTTP_400_OP_NOT_ALLOWED",
    )

    # Must NOT raise: the cycle continues even when the ledger op is rejected.
    out = bot.guardian_pass(now_ms=int(candles[-1][0]) + CANDLE_MS)
    assert out is not None
    assert bot.ingest.insert_shadow_ledger.called


def test_lockout_set_rebuilt_each_cycle_from_empty_recent_closes():
    bot = _make_bot()
    candles = _synthetic_candles(220)
    _install_market(bot, "BTC-USDT", candles)
    _stub_ingest_positions(bot, [])
    # Pre-existing junk in the lockout should be replaced with an empty set
    # since no recent guardian-close feed exists yet.
    bot._current_lockout_set = {("XYZ", "long")}
    bot.guardian_pass(now_ms=int(candles[-1][0]) + CANDLE_MS)
    # positions=[] short-circuits before lockout rebuild; force a run with 1 pos.
    pos = {
        "id": "pos-lk", "user_id": "u1", "wallet_key": "w1",
        "symbol": "BTC-USDT", "direction": "long", "strategy": "accumulator",
        "entry_price": float(candles[-1][4]), "size_qty": 1.0, "margin": 500.0,
        "stop_level": float(candles[-1][4]) * 0.95, "entry_candle_ts_ms": 0,
    }
    _stub_ingest_positions(bot, [pos])
    bot.guardian_pass(now_ms=int(candles[-1][0]) + 2 * CANDLE_MS)
    assert bot._current_lockout_set == set()
