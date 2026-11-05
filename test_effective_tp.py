"""Parity: test_effective_tp — mirrors src/lib/paper/__tests__/effectiveTp.test.ts."""
from effective_tp import effective_tp


def test_long_uses_tp_level_when_nearer():
    # DOGE regression: strategy target 0.072672, rung TP 0.074.
    assert effective_tp("long", 0.074, 0.072672) == 0.072672


def test_long_keeps_lot_tp_when_nearer():
    assert effective_tp("long", 100.5, 101.0) == 100.5


def test_short_uses_tp_level_when_nearer():
    assert effective_tp("short", 99.0, 99.5) == 99.5


def test_short_keeps_lot_tp_when_nearer():
    assert effective_tp("short", 100.0, 99.5) == 100.0


def test_falls_back_on_missing_or_invalid():
    assert effective_tp("long", 100, None) == 100
    assert effective_tp("long", 100, 0) == 100
    assert effective_tp("long", 100, float("nan")) == 100
