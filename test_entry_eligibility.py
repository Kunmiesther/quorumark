"""Historical entries must NEVER create intents. Behavioral, not vocabulary."""
from __future__ import annotations

import pytest

import accumulator_signal as sig
from entry_eligibility import eligible_entries, entry_key, newly_confirmed_entry

STEP = 300_000
BASE = 1_784_263_500_000 // STEP * STEP


def candles(n, last_ts=BASE):
    start = last_ts - (n - 1) * STEP
    return [[start + i * STEP, 100.0, 101.0, 99.0, 100.5, 1.0] for i in range(n)]


class FakeBreak:
    def __init__(self, ts, direction="long"):
        self.break_ts = ts; self.direction = direction; self.break_index = 0


class FakeRetest:
    def __init__(self, idx, ts, state="confirmed", break_ts=None):
        self.state = state; self.retest_index = idx; self.retest_ts = ts
        self.break_event = FakeBreak(break_ts if break_ts is not None else ts - STEP)


def result(*retests):
    return {"entries": [r for r in retests if r.state == "confirmed"]}


# --- the core rule ---------------------------------------------------------
def test_entry_on_newest_completed_candle_is_eligible():
    c = candles(198)
    r = FakeRetest(197, int(c[197][0]))
    assert newly_confirmed_entry(result(r), c) is r


@pytest.mark.parametrize("idx", [0, 50, 100, 195, 196])
def test_historical_entries_are_never_eligible(idx):
    """THE POINT. `entries` holds the whole lookback; only the edge may trade."""
    c = candles(198)
    r = FakeRetest(idx, int(c[idx][0]))
    assert newly_confirmed_entry(result(r), c) is None


def test_full_lookback_of_history_yields_nothing():
    """Reproduces the live payload: 15 confirmed entries in the window, none
    on the newest candle. A worker keying off `entries` would fire 15 intents."""
    c = candles(198)
    hist = [FakeRetest(i, int(c[i][0])) for i in range(10, 190, 12)]
    assert len(result(*hist)["entries"]) == 15
    assert eligible_entries(result(*hist), c) == []


def test_at_most_one_eligible_entry():
    c = candles(198)
    r_new = FakeRetest(197, int(c[197][0]))
    hist = [FakeRetest(i, int(c[i][0])) for i in (20, 80, 150)]
    assert len(eligible_entries(result(r_new, *hist), c)) == 1


# --- sliding window must not promote history ------------------------------
def test_sliding_window_does_not_promote_an_old_entry():
    """A confirmation eligible at cycle N must be INELIGIBLE at cycle N+1,
    even though its index shifts to look 'recent'."""
    c1 = candles(198, last_ts=BASE)
    ts = int(c1[197][0])
    r1 = FakeRetest(197, ts)
    assert newly_confirmed_entry(result(r1), c1) is r1        # eligible now

    c2 = candles(198, last_ts=BASE + STEP)                    # window slides
    r2 = FakeRetest(196, ts)                                  # same entry, re-indexed
    assert newly_confirmed_entry(result(r2), c2) is None       # history now


def test_reindexed_entry_cannot_masquerade_as_new():
    """An index at the edge is NOT sufficient — the timestamp must match the
    newest candle. Guards against a re-indexed old entry sitting at 197."""
    c = candles(198, last_ts=BASE)
    stale = FakeRetest(197, int(c[100][0]))   # edge index, OLD timestamp
    assert newly_confirmed_entry(result(stale), c) is None


def test_repeated_cycles_do_not_retrade_history():
    """Simulates 20 loop iterations across 20 candles. Exactly the candles
    that actually confirmed are eligible — each once, never again."""
    fired = []
    seen = set()
    confirm_at = {BASE + 3 * STEP, BASE + 11 * STEP}
    for cycle in range(20):
        last = BASE + cycle * STEP
        c = candles(198, last_ts=last)
        rs = [FakeRetest(197, last)] if last in confirm_at else []
        # history always present in the window, as in the live payload
        rs += [FakeRetest(i, int(c[i][0])) for i in (5, 60, 120)]
        for e in eligible_entries(result(*rs), c):
            k = entry_key("BTC-USDT", 5, e)
            if k in seen:
                pytest.fail("same confirmation became eligible twice")
            seen.add(k); fired.append(k)
    assert len(fired) == 2                    # not 20, not 60


# --- the same confirmation cannot trade twice -----------------------------
def test_entry_key_is_stable_across_cycles():
    ts = BASE
    a = entry_key("BTC-USDT", 5, FakeRetest(197, ts))
    b = entry_key("BTC-USDT", 5, FakeRetest(120, ts))   # same entry, re-indexed
    assert a == b, "identity must survive re-indexing"


def test_entry_key_is_timestamp_anchored_not_index_anchored():
    """Index-keyed dedup would silently re-admit the same trade under a new
    number as the window slides."""
    k = entry_key("BTC-USDT", 5, FakeRetest(197, BASE))
    assert 197 not in k
    assert BASE in k


def test_entry_key_separates_direction_symbol_and_break():
    ts = BASE
    long_k = entry_key("BTC-USDT", 5, FakeRetest(197, ts))
    short_r = FakeRetest(197, ts); short_r.break_event.direction = "short"
    assert long_k != entry_key("BTC-USDT", 5, short_r)
    assert long_k != entry_key("ETH-USDT", 5, FakeRetest(197, ts))
    assert long_k != entry_key("BTC-USDT", 15, FakeRetest(197, ts))
    # different break, same retest candle -> different entry
    assert long_k != entry_key("BTC-USDT", 5, FakeRetest(197, ts, break_ts=ts - 9 * STEP))


# --- non-confirmed states never eligible ----------------------------------
@pytest.mark.parametrize("state", ["pending", "expired_window", "expired_breach"])
def test_unconfirmed_states_never_eligible(state):
    c = candles(198)
    r = FakeRetest(197, int(c[197][0]), state=state)
    assert newly_confirmed_entry({"entries": [r]}, c) is None


def test_empty_and_degenerate_inputs():
    assert newly_confirmed_entry({}, candles(198)) is None
    assert newly_confirmed_entry({"entries": []}, candles(198)) is None
    assert newly_confirmed_entry({"entries": [FakeRetest(0, BASE)]}, []) is None
    assert newly_confirmed_entry({"entries": [FakeRetest(None, BASE)]}, candles(198)) is None
