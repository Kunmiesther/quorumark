"""Parity tests — Python (live-worker) side.

Runs the live-path implementations against the SAME JSON fixtures used by
the TypeScript paper-side parity suite (`src/lib/paper/__tests__/parity/`).
Where the live side does not yet implement a behavior, the corresponding
test is `pytest.skip`-ed with the tracking DEBT-XX from
docs/MAINNET_PARITY.md §6 as the reason. That is the mandated documentation
mechanism for the 🔴 rows in §1 until subsequent debt-closure passes port
the missing logic.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

# Ensure the project root is on sys.path so we can import bot modules.
ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(ROOT, "..", ".."))
if PROJECT not in sys.path:
    sys.path.insert(0, PROJECT)

FIXTURES = os.path.join(PROJECT, "tests", "fixtures", "parity")


def _load(name: str) -> dict:
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return json.load(f)


# ─── 🔴 gaps — documented skips ─────────────────────────────────────────────

@pytest.mark.parametrize("fixture", [
    "regime_trend_btc.json",
    "regime_neutral_eth.json",
    "regime_highvol_sol.json",
])
def test_regime_and_routing_skipped(fixture):
    pytest.skip("DEBT-03: live-side regime classifier + routing not yet ported")


def test_entry_guard_skipped():
    _load("entry_guard_wait_opposing.json")
    pytest.skip("DEBT-04: live-side entry guard not yet ported")


def test_htf_bos_skipped():
    _load("bos_1h_bullish.json")
    pytest.skip("DEBT-06: live-side HTF BOS consumption not yet defined")


def test_max_loss_trigger_skipped():
    _load("max_loss_trigger.json")
    pytest.skip("DEBT-02: live-side max-loss cap not yet ported")


# ─── ✅ active parity checks ────────────────────────────────────────────────

def test_bos_5m_bearish_live_detects_break():
    """accumulator_signal.evaluate (live path) must find the same bearish
    break as the TS paper-side evaluate() on the same candle series."""
    import accumulator_signal as sig

    f = _load("bos_5m_bearish.json")
    result = sig.evaluate(f["candles"], "short", f["tick"])
    breaks = getattr(result, "breaks", None) or result.get("breaks", [])
    bearish = [b for b in breaks if getattr(b, "direction", None) == "short"]
    assert bearish, "live-side accumulator_signal found no bearish break"
    # level should be the pivot low (~95) within tolerance
    expected_level = float(f["expected"]["break_level"])
    matches = [b for b in bearish
               if abs(float(b.swing.level) - expected_level) < 0.5]
    assert matches, f"no bearish break within tolerance of {expected_level}"


def test_ladder_5rung_shared_constants():
    """Both sides must derive the five-rung fallback from the SAME parity JSON."""
    from shared.parity_constants import get as pc_get

    f = _load("ladder_5rung_btc_100x.json")
    exp = f["expected"]

    total = pc_get("ladder", "dca_total_margin_usd")
    per_rung_tp = pc_get("ladder", "dca_rung_tp_pct")
    hard_stop = pc_get("ladder", "hard_stop_beyond_last_rung_pct")
    span_roi = pc_get("ladder", "ladder_span_roi")
    span_cap = pc_get("ladder", "ladder_span_pct_cap")
    rungs_min = pc_get("ladder", "dca_rungs_min")
    rungs_max = pc_get("ladder", "dca_rungs_max")

    # Mirror the TS ladder.ts helpers: clamp(round(lev/12.5), min, max)
    lev = f["leverage"]
    raw = round(lev / 12.5)
    rungs = max(rungs_min, min(rungs_max, raw))
    per_rung = total / rungs
    span_pct = min(span_cap, span_roi / lev)

    assert total == exp["total_margin_usd"]
    assert rungs == exp["rungs"]
    assert abs(per_rung - exp["per_rung_margin_usd"]) < 1e-9
    assert per_rung_tp == exp["rung_tp_pct"]
    assert abs(span_pct - exp["span_pct"]) < 1e-9
    assert hard_stop == exp["hard_stop_beyond_last_rung_pct"]


# ─── contract parity ────────────────────────────────────────────────────────

def test_enum_contract_matches_python_constants():
    """The `enums` block in the shared parity JSON is the authoritative
    contract. Any live-side literal that DIVERGES from an enum here is a
    latent drift bug — assert every documented directive type / reason
    code exists as a matching literal in scout_guardian.py."""
    from shared.parity_constants import enums
    import scout_guardian as sg

    for dt in enums("directive_types"):
        assert dt in {
            sg.DIRECTIVE_CANCEL_UNFILLED_RUNGS,
            sg.DIRECTIVE_CLOSE_POSITION,
        }, f"live-side missing directive_type literal '{dt}'"

    for rc in enums("guardian_reason_codes"):
        assert rc in {
            sg.REASON_ADVERSE_BOS,
            sg.REASON_CLUSTER,
            sg.REASON_LADDER_UNDERWATER,
        }, f"live-side missing guardian_reason_code literal '{rc}'"


def test_python_strategy_constants_are_sourced_from_parity_json():
    """Assert the strategy modules load from the shared JSON at import
    time — not from stale in-module literals."""
    import accumulator_signal as a
    import hunter_signal as h
    import sniper_signal as s
    from shared.parity_constants import get as pc_get

    assert a.ATR_PERIOD == pc_get("accumulator", "atr_period")
    assert a.ZONE_ATR_MULT == pc_get("accumulator", "zone_atr_mult")
    assert h.ATR_SMA_PERIOD == pc_get("hunter", "atr_sma_period")
    assert s.FLAT_PCT == pc_get("sniper", "flat_pct")
    assert s.CONT_BODY_FRAC == pc_get("sniper", "cont_body_frac")

# ─── SWEEP 1:1 TS→Python parity ───────────────────────────────────────────
# The Python detector (sweep_signal.detect_sweep) is a straight port of
# src/lib/paper/sweep.ts. Feeding IDENTICAL candles/atr/htf/tick must yield
# an identical entry (direction, mode, entry price, stop, swept level).

def _run_python_sweep(fx):
    import sweep_signal as sw
    candles = fx["candles_1h"]
    atr = sw.atr_series(candles, sw.SWEEP_ATR_PERIOD)
    return sw.detect_sweep(candles, atr, fx.get("htf_bos_state", "none"), fx["tick"])


def test_sweep_long_rejection_fires():
    f = _load("sweep_1h_long_rejection.json")
    r = _run_python_sweep(f)
    assert r is not None, "expected python sweep to fire on long-rejection fixture"
    exp = f["expected"]
    assert r.direction == exp["direction"]
    assert r.mode == exp["mode"]
    assert abs(r.entry - exp["entry"]) < 1e-6


def test_sweep_short_rejection_fires():
    f = _load("sweep_1h_short_rejection.json")
    r = _run_python_sweep(f)
    assert r is not None, "expected python sweep to fire on short-rejection fixture"
    exp = f["expected"]
    assert r.direction == exp["direction"]
    assert r.mode == exp["mode"]


def test_routing_neutral_returns_sweep():
    import routing as r
    assert r.leg_for_regime("neutral") == "sweep"
