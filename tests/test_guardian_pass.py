"""Integration tests for bot_worker.RailwayTurtleBot.guardian_pass().

Proves the always-on Position Guardian wiring: it reads the open book, runs the
pure rule engine, then enqueues risk-reducing directives and logs a decision per
position — including HOLD — without ever signing or submitting an order. The
pure rules themselves are covered by test_scout_guardian.py; here we drive the
worker orchestration and fail-safe behaviour with fakes (no network).
"""
from __future__ import annotations

import market_data
import bot_worker as bw
import scout_guardian as sg

USER = "11111111-1111-4111-8111-111111111111"


class FakeFeed:
    """Feed stub — guardian_pass tolerates a broken feed (no_market_data)."""

    def __init__(self, raise_exc=None):
        self.raise_exc = raise_exc or market_data.FeedError("no feed in test")

    def fetch(self, *a, **k):
        raise self.raise_exc


class FakeIngest:
    def __init__(self, positions, read_exc=None):
        self._positions = positions
        self._read_exc = read_exc
        self.decisions = []
        self.directives = []

    def read_open_positions(self):
        if self._read_exc is not None:
            raise self._read_exc
        return self._positions

    def insert_guardian_decisions(self, decisions):
        self.decisions.append(decisions)
        return {"ok": True}

    def upsert_guardian_directives(self, directives):
        self.directives.append(directives)
        return {"ok": True}


def make_bot(ingest):
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = ingest
    bot.mode = "paper"
    bot.credentials_ok = True
    bot.supabase = None
    bot._signal_feed_client = FakeFeed()
    bot._signal_seen = {}
    bot._guardian_stale_cycles = {}
    return bot


def _pos(pid, symbol, direction="long"):
    return {
        "id": pid, "user_id": USER, "symbol": symbol,
        "wallet_key": f"{symbol.split('-')[0]}-{direction}", "direction": direction,
        "entry_price": 100.0, "fills": [{"price": 100.0, "qty": 1.0, "margin": 7.5, "tp": 101.0}],
        "pending_rungs": [],
    }


def test_empty_book_no_emits():
    ingest = FakeIngest(positions=[])
    bot = make_bot(ingest)
    summary = bot.guardian_pass(now_ms=1_700_000_000_000)
    assert summary == {"positions": 0, "decisions": 0, "directives": 0}
    assert ingest.decisions == [] and ingest.directives == []


def test_read_failure_is_fail_safe(monkeypatch):
    ingest = FakeIngest(positions=[], read_exc=bw.WorkerIngestTransientError("boom"))
    bot = make_bot(ingest)
    assert bot.guardian_pass() is None
    assert ingest.decisions == [] and ingest.directives == []


def test_hold_still_logs_a_decision(monkeypatch):
    pos = _pos("p1", "BTC-USDT")
    ingest = FakeIngest(positions=[pos])
    bot = make_bot(ingest)

    def fake_eval(positions, market_by_symbol, **kwargs):
        v = sg.Verdict("p1", "BTC-USDT", "long", "hold", None, [], {"rule": "none"})
        return sg.PortfolioResult([v], [])

    monkeypatch.setattr(sg, "evaluate_portfolio", fake_eval)
    summary = bot.guardian_pass(now_ms=1_700_000_000_000)
    assert summary["positions"] == 1 and summary["decisions"] == 1 and summary["directives"] == 0
    # A HOLD is still recorded to the ledger; no directive enqueued.
    assert len(ingest.decisions) == 1
    row = ingest.decisions[0][0]
    assert row["decision"] == "hold" and row["side"] == "long" and row["user_id"] == USER
    assert row["correlation_id"] == summary["correlation_id"]
    assert ingest.directives == []


def test_bos_emits_cancel_and_close_directives(monkeypatch):
    pos = _pos("p1", "BTC-USDT")
    ingest = FakeIngest(positions=[pos])
    bot = make_bot(ingest)

    def fake_eval(positions, market_by_symbol, **kwargs):
        ev = {"rule": "adverse_bos"}
        directives = [
            sg.Directive("p1", sg.DIRECTIVE_CANCEL_UNFILLED_RUNGS, sg.REASON_ADVERSE_BOS, "BTC-USDT", "BTC-long", ev),
            sg.Directive("p1", sg.DIRECTIVE_CLOSE_POSITION, sg.REASON_ADVERSE_BOS, "BTC-USDT", "BTC-long", ev),
        ]
        v = sg.Verdict("p1", "BTC-USDT", "long", "close", sg.REASON_ADVERSE_BOS, directives, ev)
        return sg.PortfolioResult([v], [])

    monkeypatch.setattr(sg, "evaluate_portfolio", fake_eval)
    summary = bot.guardian_pass(now_ms=1_700_000_000_000)
    assert summary["directives"] == 2 and summary["decisions"] == 1
    emitted = ingest.directives[0]
    types = sorted(d["directive_type"] for d in emitted)
    assert types == [sg.DIRECTIVE_CANCEL_UNFILLED_RUNGS, sg.DIRECTIVE_CLOSE_POSITION]
    # Every directive carries the cycle correlation id + user + position.
    for d in emitted:
        assert d["user_id"] == USER and d["position_id"] == "p1"
        assert d["correlation_id"] == summary["correlation_id"]
        assert d["guardian_cycle_ts_ms"] == 1_700_000_000_000
    assert ingest.decisions[0][0]["decision"] == "close"


def test_cluster_override_upgrades_hold_to_close(monkeypatch):
    pos = _pos("p1", "BTC-USDT")
    ingest = FakeIngest(positions=[pos])
    bot = make_bot(ingest)

    def fake_eval(positions, market_by_symbol, **kwargs):
        # Per-position rule says hold; the portfolio cluster rule says close.
        v = sg.Verdict("p1", "BTC-USDT", "long", "hold", None, [], {"rule": "none"})
        cluster = [sg.Directive("p1", sg.DIRECTIVE_CLOSE_POSITION, sg.REASON_CLUSTER, "BTC-USDT", "BTC-long", {"rule": "correlated_cluster"})]
        return sg.PortfolioResult([v], cluster)

    monkeypatch.setattr(sg, "evaluate_portfolio", fake_eval)
    summary = bot.guardian_pass(now_ms=1_700_000_000_000)
    assert summary["directives"] == 1
    # The logged decision is upgraded to close with the cluster reason.
    row = ingest.decisions[0][0]
    assert row["decision"] == "close"
    assert sg.REASON_CLUSTER in row["supporting_codes"]
    assert ingest.directives[0][0]["directive_type"] == sg.DIRECTIVE_CLOSE_POSITION


def test_directive_dedup_same_position_same_type(monkeypatch):
    pos = _pos("p1", "BTC-USDT")
    ingest = FakeIngest(positions=[pos])
    bot = make_bot(ingest)

    def fake_eval(positions, market_by_symbol, **kwargs):
        ev = {"rule": "adverse_bos"}
        # Per-position close AND cluster close for the SAME position — must
        # collapse to a single close_position directive.
        v = sg.Verdict("p1", "BTC-USDT", "long", "close", sg.REASON_ADVERSE_BOS,
                       [sg.Directive("p1", sg.DIRECTIVE_CLOSE_POSITION, sg.REASON_ADVERSE_BOS, "BTC-USDT", "BTC-long", ev)], ev)
        cluster = [sg.Directive("p1", sg.DIRECTIVE_CLOSE_POSITION, sg.REASON_CLUSTER, "BTC-USDT", "BTC-long", {"rule": "cluster"})]
        return sg.PortfolioResult([v], cluster)

    monkeypatch.setattr(sg, "evaluate_portfolio", fake_eval)
    summary = bot.guardian_pass(now_ms=1_700_000_000_000)
    assert summary["directives"] == 1  # deduped to one
