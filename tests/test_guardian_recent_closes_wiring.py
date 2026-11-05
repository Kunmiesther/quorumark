"""Wiring tests for the recent-closes → lockout path and shadow ledger row shape.

Proves the two Live-Readiness closures:

1. `bot_worker.guardian_pass` calls `ingest.read_recent_guardian_closes()` and
   feeds the result through `worker_live_wiring.build_lockout_set`, so an
   entry candidate for the returned (symbol, direction) is blocked.
2. `bot_worker._emit_shadow_ledger` produces rows in the shape the
   `SHADOW_LEDGER_INSERT` edge-function handler accepts (user_id + long/short
   direction only; flat rows skipped client-side).
"""
from __future__ import annotations

import bot_worker as bw
import worker_live_wiring as _live
import reentry_lockout

USER = "22222222-2222-4222-8222-222222222222"


class FakeIngest:
    def __init__(self, recent_closes=None):
        self.recent_closes = recent_closes or []
        self.shadow_batches: list[list[dict]] = []
        self.decisions: list = []
        self.directives: list = []
        self.recent_closes_calls = 0

    def read_open_positions(self):
        return []

    def read_recent_guardian_closes(self, *, window_ms=None):
        self.recent_closes_calls += 1
        return self.recent_closes

    def insert_guardian_decisions(self, decisions):
        self.decisions.append(decisions)
        return {"ok": True}

    def upsert_guardian_directives(self, directives):
        self.directives.append(directives)
        return {"ok": True}

    def insert_shadow_ledger(self, rows):
        self.shadow_batches.append(rows)
        return {"ok": True}


def _make_bot(ingest):
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = ingest
    bot.mode = "paper"
    bot.credentials_ok = True
    bot.supabase = None
    bot._signal_seen = {}
    bot._guardian_stale_cycles = {}
    bot._current_lockout_set = set()
    return bot


def test_guardian_pass_builds_lockout_from_ingest_recent_closes():
    now_ms = 1_700_000_000_000
    # A guardian-class close within the lockout window on BTC-USDT long.
    recent = [{
        "symbol": "BTC-USDT",
        "direction": "long",
        "exit_reason": "scout_guardian_bos",
        "closed_at_ms": now_ms - 60_000,
    }]
    ingest = FakeIngest(recent_closes=recent)
    bot = _make_bot(ingest)

    summary = bot.guardian_pass(now_ms=now_ms)
    # Empty book still triggers the recent-closes fetch on the cycle.
    assert ingest.recent_closes_calls == 1
    assert summary == {"positions": 0, "decisions": 0, "directives": 0} or summary["positions"] == 0
    # Lockout set now contains the (symbol, direction) pair.
    assert reentry_lockout.is_locked_out(bot._current_lockout_set, "BTC-USDT", "long")
    # Opposite direction is never blocked.
    assert not reentry_lockout.is_locked_out(bot._current_lockout_set, "BTC-USDT", "short")


def test_guardian_pass_recent_closes_read_failure_is_fail_safe():
    ingest = FakeIngest(recent_closes=[])

    def raise_transient(**_kwargs):
        raise bw.WorkerIngestTransientError("boom")

    ingest.read_recent_guardian_closes = raise_transient  # type: ignore[assignment]
    bot = _make_bot(ingest)
    # Must not raise; lockout collapses to empty.
    bot.guardian_pass(now_ms=1_700_000_000_000)
    assert bot._current_lockout_set == set()


def test_shadow_ledger_row_shape_matches_edge_function_contract():
    ingest = FakeIngest()
    bot = _make_bot(ingest)

    decisions = [
        # long — valid, must be emitted
        {"user_id": USER, "correlation_id": "c", "symbol": "BTC-USDT", "side": "long",
         "decision": "hold", "detail": {"rule": "none"}, "supporting_codes": []},
        # flat — must be dropped client-side (table CHECK is long|short)
        {"user_id": USER, "correlation_id": "c", "symbol": "ETH-USDT", "side": "flat",
         "decision": "hold", "detail": {}, "supporting_codes": []},
        # missing user_id — dropped
        {"user_id": None, "correlation_id": "c", "symbol": "SOL-USDT", "side": "short",
         "decision": "close", "detail": {}, "supporting_codes": ["scout_guardian_bos"]},
        # short with reason — valid
        {"user_id": USER, "correlation_id": "c", "symbol": "SOL-USDT", "side": "short",
         "decision": "close", "detail": {"rule": "adverse_bos"},
         "supporting_codes": ["scout_guardian_bos"]},
    ]
    bot._emit_shadow_ledger(decisions, cycle_corr="c" * 8, now_ms=1_700_000_000_000)
    assert len(ingest.shadow_batches) == 1
    rows = ingest.shadow_batches[0]
    assert len(rows) == 2  # flat + missing user dropped
    keys = {"source", "user_id", "leg", "cycle_ts_ms", "symbol", "side",
            "decision", "reason_code", "correlation_id", "detail"}
    for row in rows:
        assert set(row.keys()) == keys
        assert row["source"] == "paper"
        assert row["leg"] == "guardian"
        assert row["side"] in ("long", "short")
        assert row["user_id"] == USER
    # reason_code pulls from supporting_codes[0]
    short_row = next(r for r in rows if r["side"] == "short")
    assert short_row["reason_code"] == "scout_guardian_bos"


def test_shadow_ledger_noop_when_no_decisions():
    ingest = FakeIngest()
    bot = _make_bot(ingest)
    bot._emit_shadow_ledger([], cycle_corr="c", now_ms=1)
    assert ingest.shadow_batches == []
