"""Bit-identical parity test: Python sweep_h2 vs TS sweepH2 canonical fixtures."""
from __future__ import annotations

import json
import os
import unittest

from sweep_h2 import (
    H2Fill,
    compute_h2_ladder,
    compute_h2_tiers,
    recompute_avg_entry,
    rung_is_filled,
    tier_is_hit,
    stop_is_hit,
    FILL_DEPTH_FRACS,
    FILL_WEIGHTS,
    TIMEOUT_BARS_1H,
    MAX_CONCURRENT_LADDERS,
    TP_TIERS,
)

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "parity")
EPS = 1e-12


def _approx(a: float, b: float) -> bool:
    return abs(a - b) <= EPS + EPS * max(abs(a), abs(b))


class SweepH2ParityLong(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(os.path.join(FIX, "sweep_h2_ladder_long.json"), "r") as f:
            cls.fx = json.load(f)

    def test_constants_match_spec(self) -> None:
        self.assertEqual(FILL_WEIGHTS, [1, 3, 2])
        self.assertEqual(FILL_DEPTH_FRACS, [0.0, 0.5, 1.0])
        self.assertEqual(TIMEOUT_BARS_1H, 48)
        self.assertEqual(MAX_CONCURRENT_LADDERS, 2)
        self.assertEqual([float(t["frac"]) for t in TP_TIERS], [0.5, 0.3, 0.2])
        self.assertEqual([float(t["rr"]) for t in TP_TIERS], [1.75, 2.0, 2.5])

    def test_ladder_bit_identical(self) -> None:
        i, e = self.fx["inputs"], self.fx["expected"]
        lad = compute_h2_ladder(side="long", level=i["level"], atr_1h=i["atr_1h"],
                                leverage=i["leverage"], total_margin_usd=i["total_margin_usd"])
        self.assertTrue(_approx(lad.zone_edge_price, e["zone_edge_price"]))
        self.assertTrue(_approx(lad.stop_price, e["stop_price"]))
        for rung, exp in zip(lad.rungs, e["rungs"]):
            self.assertTrue(_approx(rung.price, exp["price"]))
            self.assertTrue(_approx(rung.margin_usd, exp["margin_usd"]))
            self.assertTrue(_approx(rung.qty, exp["qty"]))
            self.assertEqual(rung.weight, exp["weight"])

    def test_all_filled_and_tiers(self) -> None:
        i, e = self.fx["inputs"], self.fx["expected"]
        lad = compute_h2_ladder(side="long", level=i["level"], atr_1h=i["atr_1h"],
                                leverage=i["leverage"], total_margin_usd=i["total_margin_usd"])
        fills = [H2Fill(price=r.price, qty=r.qty, margin_usd=r.margin_usd) for r in lad.rungs]
        agg = recompute_avg_entry(fills, i["leverage"])
        self.assertTrue(_approx(agg["total_qty"], e["all_filled"]["total_qty"]))
        self.assertTrue(_approx(agg["avg_entry"], e["all_filled"]["avg_entry"]))
        res = compute_h2_tiers(side="long", avg_entry=agg["avg_entry"],
                               stop_price=lad.stop_price, total_qty=agg["total_qty"])
        self.assertTrue(_approx(res["R"], e["all_filled"]["R"]))
        for tier, exp in zip(res["tiers"], e["all_filled"]["tiers"]):
            self.assertTrue(_approx(tier.price, exp["price"]))
            self.assertTrue(_approx(tier.qty, exp["qty"]))
            self.assertEqual(tier.label, exp["label"])

    def test_partial_fill_2_of_3(self) -> None:
        i, e = self.fx["inputs"], self.fx["expected"]
        lad = compute_h2_ladder(side="long", level=i["level"], atr_1h=i["atr_1h"],
                                leverage=i["leverage"], total_margin_usd=i["total_margin_usd"])
        fills = [H2Fill(price=r.price, qty=r.qty, margin_usd=r.margin_usd) for r in lad.rungs[:2]]
        agg = recompute_avg_entry(fills, i["leverage"])
        self.assertTrue(_approx(agg["total_qty"], e["partial_first_two_filled"]["total_qty"]))
        self.assertTrue(_approx(agg["avg_entry"], e["partial_first_two_filled"]["avg_entry"]))
        res = compute_h2_tiers(side="long", avg_entry=agg["avg_entry"],
                               stop_price=lad.stop_price, total_qty=agg["total_qty"])
        for tier, exp in zip(res["tiers"], e["partial_first_two_filled"]["tiers"]):
            self.assertTrue(_approx(tier.price, exp["price"]))
            self.assertTrue(_approx(tier.qty, exp["qty"]))


class SweepH2ParityShort(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(os.path.join(FIX, "sweep_h2_ladder_short.json"), "r") as f:
            cls.fx = json.load(f)

    def test_short_ladder_and_tiers(self) -> None:
        i, e = self.fx["inputs"], self.fx["expected"]
        lad = compute_h2_ladder(side="short", level=i["level"], atr_1h=i["atr_1h"],
                                leverage=i["leverage"], total_margin_usd=i["total_margin_usd"])
        self.assertTrue(_approx(lad.zone_edge_price, e["zone_edge_price"]))
        self.assertTrue(_approx(lad.stop_price, e["stop_price"]))
        self.assertGreater(lad.zone_edge_price, i["level"])
        self.assertGreater(lad.stop_price, lad.zone_edge_price)
        fills = [H2Fill(price=r.price, qty=r.qty, margin_usd=r.margin_usd) for r in lad.rungs]
        agg = recompute_avg_entry(fills, i["leverage"])
        self.assertTrue(_approx(agg["avg_entry"], e["all_filled"]["avg_entry"]))
        res = compute_h2_tiers(side="short", avg_entry=agg["avg_entry"],
                               stop_price=lad.stop_price, total_qty=agg["total_qty"])
        for tier, exp in zip(res["tiers"], e["all_filled"]["tiers"]):
            self.assertTrue(_approx(tier.price, exp["price"]))
            self.assertTrue(_approx(tier.qty, exp["qty"]))
            # Short tiers are below avg entry
            self.assertLess(tier.price, agg["avg_entry"])


class SweepH2Predicates(unittest.TestCase):
    def test_fill_tier_stop_predicates(self) -> None:
        self.assertTrue(rung_is_filled("long", 99, bar_high=101, bar_low=98))
        self.assertFalse(rung_is_filled("long", 99, bar_high=101, bar_low=99.5))
        self.assertTrue(rung_is_filled("short", 101, bar_high=102, bar_low=100))
        self.assertTrue(tier_is_hit("long", 102, bar_high=102.5, bar_low=101))
        self.assertTrue(stop_is_hit("long", 97.5, bar_high=99, bar_low=97.5))
        self.assertFalse(stop_is_hit("long", 97.5, bar_high=99, bar_low=97.6))


if __name__ == "__main__":
    unittest.main()
