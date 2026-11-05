import unittest

from shared.zen_sweep_contract import (
    SCAN_SYMBOLS,
    ZEN_SWEEP,
    alignment_votes,
    build_ladder,
    decide_exit,
    is_scan_symbol,
    passes_alignment,
)


class ZenSweepContractTests(unittest.TestCase):
    def test_symbol_agnostic_four_symbol_universe(self):
        self.assertEqual(
            SCAN_SYMBOLS,
            ("BTC-USDT", "XRP-USDT", "SOL-USDT", "ETH-USDT"),
        )
        self.assertTrue(all(is_scan_symbol(symbol) for symbol in SCAN_SYMBOLS))
        self.assertFalse(is_scan_symbol("DOGE-USDT"))

    def test_two_of_three_alignment(self):
        states = ("bullish_bos", "none", "bullish_bos")
        self.assertEqual(alignment_votes("long", states), 2)
        self.assertTrue(passes_alignment("long", states))
        self.assertFalse(passes_alignment("short", states))

    def test_shared_five_rung_geometry(self):
        rungs = build_ladder(
            direction="long",
            alert_price=100,
            leverage=50,
            available_equity=2_500,
        )
        self.assertEqual([r.price for r in rungs], [100, 99.5, 99, 98.5, 98])
        self.assertAlmostEqual(sum(r.margin for r in rungs), 125)

    def test_net_roi_exit_state_machine(self):
        first = decide_exit(
            banked_net_pnl=0,
            open_net_pnl=125,
            initial_margin=125,
            first_target_taken=False,
        )
        self.assertEqual(first.action, "close_half")

        runner = decide_exit(
            banked_net_pnl=62.5,
            open_net_pnl=125,
            initial_margin=125,
            first_target_taken=True,
            previous_high_water_roi_pct=140,
        )
        self.assertEqual(runner.action, "hold")
        self.assertEqual(runner.high_water_roi_pct, 150)
        self.assertEqual(runner.trailing_floor_roi_pct, 100)

        trailing = decide_exit(
            banked_net_pnl=62.5,
            open_net_pnl=50,
            initial_margin=125,
            first_target_taken=True,
            previous_high_water_roi_pct=150,
        )
        self.assertEqual(trailing.action, "close_all_trailing")
        self.assertEqual(ZEN_SWEEP["exit"]["final_target_margin_roi_pct"], 200)


if __name__ == "__main__":
    unittest.main()
