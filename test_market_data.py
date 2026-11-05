"""Offline tests for market_data.py.

NO NETWORK. Every test builds a synthetic response body, except
`TestLiveEnvelope`, which replays bytes CAPTURED from the deployed Railway
worker against ApeX mainnet on 2026-07-16. That capture is the only reason the
response shape is called verified anywhere in this module.

stdlib `unittest`, not pytest, on purpose: pytest is not in requirements.txt and
this file must not add a production dependency to the worker image.

    python -m unittest test_market_data -v
"""

from __future__ import annotations

import unittest

from market_data import (
    MAX_LIMIT,
    MAX_NEED_PER_CALL,
    ApexPublicFeed,
    Feed,
    FeedIntegrityError,
    FeedShapeError,
    drop_incomplete,
    extract_rows,
    parse_klines,
    validate_series,
)

STEP_MS = 5 * 60_000
BASE_TS = 1_752_000_000_000 // STEP_MS * STEP_MS  # 5m-aligned


def row(ts: int, o: float, h: float, l: float, c: float, v: float = 10.0) -> dict:
    return {
        "s": "ETHUSDT",
        "i": "5",
        "t": ts,
        "o": f"{o:.2f}",
        "h": f"{h:.2f}",
        "l": f"{l:.2f}",
        "c": f"{c:.2f}",
        "v": f"{v:.2f}",
        "tr": "1",
    }


def series(n: int, start_ts: int = None, price: float = 3000.0) -> list[dict]:
    """n contiguous 5m rows, ascending, mildly trending."""
    start = BASE_TS - (n - 1) * STEP_MS if start_ts is None else start_ts
    out = []
    for k in range(n):
        o = price + k
        c = o + 0.5
        out.append(row(start + k * STEP_MS, o, max(o, c) + 0.25, min(o, c) - 0.25, c))
    return out


def envelope(rows: list[dict], symbol: str = "ETHUSDT") -> dict:
    return {"data": {symbol: rows}, "timeCost": 2123}


# ---------------------------------------------------------------------------
# Captured live envelope — Railway container, ApeX mainnet, 2026-07-16
# ---------------------------------------------------------------------------
LIVE_LIMIT_200 = {
    "data": {
        "ETHUSDT": [
            {"s": "ETHUSDT", "i": "5", "t": 1784169900000, "c": "1923.25",
             "h": "1923.91", "l": "1920.94", "o": "1920.94", "v": "16.1",
             "tr": "30956.2232"},
            {"s": "ETHUSDT", "i": "5", "t": 1784170200000, "c": "1923.57",
             "h": "1923.62", "l": "1922.37", "o": "1923.25", "v": "8.73",
             "tr": "16"},
        ]
    },
    "timeCost": 2123,
}

LIVE_LIMIT_202 = {"data": {}, "timeCost": 2123}


class TestLiveEnvelope(unittest.TestCase):
    """Replays the verified capture. If these fail, either ApeX changed or the
    parser drifted from the observed truth."""

    def test_captured_envelope_parses(self):
        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        self.assertEqual(len(out), 2)

    def test_ohlcv_read_by_key_not_position(self):
        # Venue key order is s,i,t,c,h,l,o,v,tr — a positional read would
        # transpose open and close.
        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        self.assertEqual(out[0], [1784169900000.0, 1920.94, 1923.91, 1920.94, 1923.25, 16.1])
        self.assertEqual(out[1], [1784170200000.0, 1923.25, 1923.62, 1922.37, 1923.57, 8.73])

    def test_timestamps_are_milliseconds_and_aligned(self):
        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        for c in out:
            self.assertEqual(int(c[0]) % STEP_MS, 0)
        self.assertEqual(int(out[1][0]) - int(out[0][0]), STEP_MS)

    def test_captured_series_passes_validation(self):
        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        validate_series(out, 5, "ETHUSDT")  # must not raise

    def test_timecost_and_tr_ignored(self):
        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        self.assertEqual(len(out[0]), 6)  # no tr, no timeCost


class TestEmptyData(unittest.TestCase):
    """limit=202 -> {"data": {}} with HTTP 200. Verified live."""

    def test_empty_data_raises_shape_error(self):
        with self.assertRaises(FeedShapeError):
            extract_rows(LIVE_LIMIT_202, "ETHUSDT", 5, 202)

    def test_error_names_symbol_interval_and_limit(self):
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(LIVE_LIMIT_202, "ETHUSDT", 5, 202)
        msg = str(cm.exception)
        self.assertIn("ETHUSDT", msg)
        self.assertIn("interval=5", msg)
        self.assertIn("limit=202", msg)

    def test_error_states_no_candle_data(self):
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(LIVE_LIMIT_202, "ETHUSDT", 5, 202)
        self.assertIn("no candle data", str(cm.exception))

    def test_error_does_not_blame_limit_alone(self):
        # An empty result is also consistent with an unsupported symbol or a
        # period with no candles. The message must not diagnose.
        msg = ""
        try:
            extract_rows(LIVE_LIMIT_202, "ETHUSDT", 5, 202)
        except FeedShapeError as e:
            msg = str(e)
        self.assertIn("unsupported symbol", msg)
        self.assertIn("no candles", msg)

    def test_empty_data_not_reported_as_missing_symbol_key(self):
        # The original failure mode: "no 'ETHUSDT' key; keys=[]".
        msg = ""
        try:
            extract_rows(LIVE_LIMIT_202, "ETHUSDT", 5, 202)
        except FeedShapeError as e:
            msg = str(e)
        self.assertNotIn("keys=[]", msg)


class TestExtractRows(unittest.TestCase):
    def test_verified_envelope(self):
        self.assertEqual(len(extract_rows(envelope(series(3)), "ETHUSDT", 5, 200)), 3)

    def test_bare_list_data_rejected(self):
        # No evidence ApeX ever returns an array. Previously accepted on none.
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows({"data": series(2)}, "ETHUSDT", 5, 200)
        self.assertIn("expected object keyed by symbol", str(cm.exception))

    def test_symbol_punctuation_not_tolerated(self):
        # Live returns 'ETHUSDT' exactly. Normalising would hide a wrong answer.
        with self.assertRaises(FeedShapeError):
            extract_rows({"data": {"ETH-USDT": series(2)}}, "ETHUSDT", 5, 200)

    def test_not_an_object(self):
        with self.assertRaises(FeedShapeError):
            extract_rows([1, 2, 3], "ETHUSDT", 5, 200)

    def test_no_data_key_reports_actual_keys(self):
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows({"result": {}, "code": 0}, "ETHUSDT", 5, 200)
        self.assertIn("code", str(cm.exception))
        self.assertIn("result", str(cm.exception))

    def test_wrong_symbol_key_is_named(self):
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows({"data": {"BTCUSDT": series(2)}}, "ETHUSDT", 5, 200)
        self.assertIn("BTCUSDT", str(cm.exception))

    def test_rows_not_a_list(self):
        with self.assertRaises(FeedShapeError):
            extract_rows({"data": {"ETHUSDT": {"t": 1}}}, "ETHUSDT", 5, 200)

    def test_missing_row_keys_reports_what_was_seen(self):
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows({"data": {"ETHUSDT": [{"t": 1, "o": "1"}]}}, "ETHUSDT", 5, 200)
        msg = str(cm.exception)
        self.assertIn("missing", msg)


class TestRowIdentity(unittest.TestCase):
    """`s` and `i` are required AND checked. A response echoing a different
    symbol or interval is a wrong answer, not a parseable one."""

    def test_missing_s_rejected(self):
        r = row(BASE_TS, 1, 2, 0.5, 1.5)
        del r["s"]
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(envelope([r]), "ETHUSDT", 5, 200)
        self.assertIn("'s'", str(cm.exception).replace('"', "'"))

    def test_missing_i_rejected(self):
        r = row(BASE_TS, 1, 2, 0.5, 1.5)
        del r["i"]
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(envelope([r]), "ETHUSDT", 5, 200)
        self.assertIn("'i'", str(cm.exception).replace('"', "'"))

    def test_row_symbol_mismatch_rejected(self):
        r = row(BASE_TS, 1, 2, 0.5, 1.5)
        r["s"] = "BTCUSDT"
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(envelope([r]), "ETHUSDT", 5, 200)
        self.assertIn("BTCUSDT", str(cm.exception))
        self.assertIn("ETHUSDT", str(cm.exception))

    def test_row_interval_mismatch_rejected(self):
        r = row(BASE_TS, 1, 2, 0.5, 1.5)
        r["i"] = "15"
        with self.assertRaises(FeedShapeError) as cm:
            extract_rows(envelope([r]), "ETHUSDT", 5, 200)
        self.assertIn("'15'", str(cm.exception))

    def test_interval_compared_as_string(self):
        r = row(BASE_TS, 1, 2, 0.5, 1.5)
        r["i"] = 5  # int, not "5"
        with self.assertRaises(FeedShapeError):
            extract_rows(envelope([r]), "ETHUSDT", 5, 200)

    def test_matching_s_and_i_accepted(self):
        rows = extract_rows(envelope(series(2)), "ETHUSDT", 5, 200)
        self.assertEqual(len(rows), 2)


class TestParseKlines(unittest.TestCase):
    def test_ohlcv_order_matches_accumulator_signal(self):
        # accumulator_signal: TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0..5
        body = envelope([row(BASE_TS, 100.0, 105.0, 99.0, 104.0, 7.0)])
        c = parse_klines(body, "ETHUSDT", 5)[0]
        self.assertEqual(c, [float(BASE_TS), 100.0, 105.0, 99.0, 104.0, 7.0])

    def test_sorted_ascending_regardless_of_input_order(self):
        rows = series(5)
        out = parse_klines(envelope(list(reversed(rows))), "ETHUSDT", 5)
        self.assertEqual([c[0] for c in out], sorted(c[0] for c in out))

    def test_timestamps_not_rescaled(self):
        out = parse_klines(envelope([row(BASE_TS, 1, 2, 0.5, 1.5)]), "ETHUSDT", 5)
        self.assertEqual(int(out[0][0]), BASE_TS)

    def test_non_numeric_price_fails_closed(self):
        bad = row(BASE_TS, 1, 2, 0.5, 1.5)
        bad["c"] = "n/a"
        with self.assertRaises(FeedShapeError):
            parse_klines(envelope([bad]), "ETHUSDT", 5)

    def test_empty_series_parses_to_empty(self):
        self.assertEqual(parse_klines(envelope([]), "ETHUSDT", 5), [])


class TestDropIncomplete(unittest.TestCase):
    """The lookahead guard. A live response ends with the forming candle."""

    def setUp(self):
        self.candles = parse_klines(envelope(series(10)), "ETHUSDT", 5)
        self.last_open = int(self.candles[-1][0])

    def test_forming_candle_dropped_mid_bar(self):
        out = drop_incomplete(self.candles, 5, self.last_open + 60_000)
        self.assertEqual(len(out), len(self.candles) - 1)

    def test_forming_candle_dropped_at_its_open(self):
        out = drop_incomplete(self.candles, 5, self.last_open)
        self.assertEqual(len(out), len(self.candles) - 1)

    def test_kept_exactly_at_close(self):
        out = drop_incomplete(self.candles, 5, self.last_open + STEP_MS)
        self.assertEqual(len(out), len(self.candles))

    def test_one_ms_before_close_is_still_incomplete(self):
        out = drop_incomplete(self.candles, 5, self.last_open + STEP_MS - 1)
        self.assertEqual(len(out), len(self.candles) - 1)

    def test_returns_copies_not_views(self):
        out = drop_incomplete(self.candles, 5, self.last_open + STEP_MS)
        out[0][1] = -999.0
        self.assertNotEqual(self.candles[0][1], -999.0)


class TestValidateSeries(unittest.TestCase):
    def setUp(self):
        self.clean = parse_klines(envelope(series(20)), "ETHUSDT", 5)

    def test_clean_series_passes(self):
        validate_series(self.clean, 5, "ETHUSDT")  # must not raise

    def test_empty_rejected(self):
        with self.assertRaises(FeedIntegrityError):
            validate_series([], 5, "ETHUSDT")

    def test_gap_rejected_not_filled(self):
        # One missing bar shifts the 48-candle lookback and 6-candle retest
        # window by one index and nothing downstream complains.
        gapped = self.clean[:10] + self.clean[11:]
        with self.assertRaises(FeedIntegrityError) as cm:
            validate_series(gapped, 5, "ETHUSDT")
        self.assertIn("gap", str(cm.exception))

    def test_duplicate_ts_rejected(self):
        dup = self.clean[:5] + [list(self.clean[4])] + self.clean[5:]
        with self.assertRaises(FeedIntegrityError):
            validate_series(dup, 5, "ETHUSDT")

    def test_misaligned_ts_rejected(self):
        skew = [list(c) for c in self.clean]
        for c in skew:
            c[0] += 1_000
        with self.assertRaises(FeedIntegrityError) as cm:
            validate_series(skew, 5, "ETHUSDT")
        self.assertIn("aligned", str(cm.exception))

    def test_non_positive_price_rejected(self):
        bad = [list(c) for c in self.clean]
        bad[3][3] = 0.0
        with self.assertRaises(FeedIntegrityError):
            validate_series(bad, 5, "ETHUSDT")

    def test_high_below_close_rejected(self):
        bad = [list(c) for c in self.clean]
        bad[7][2] = bad[7][4] - 1.0
        with self.assertRaises(FeedIntegrityError) as cm:
            validate_series(bad, 5, "ETHUSDT")
        self.assertIn("OHLC", str(cm.exception))

    def test_low_above_open_rejected(self):
        bad = [list(c) for c in self.clean]
        bad[7][3] = bad[7][1] + 1.0
        with self.assertRaises(FeedIntegrityError):
            validate_series(bad, 5, "ETHUSDT")


class TestLimitBoundary(unittest.TestCase):
    """The verified 200 ceiling. No network: fetch must raise BEFORE any
    request is issued, and klines_raw must reject out-of-range limits."""

    def test_constants(self):
        self.assertEqual(MAX_LIMIT, 200)
        self.assertEqual(MAX_NEED_PER_CALL, 198)

    def test_need_198_is_the_default(self):
        import inspect
        sig = inspect.signature(ApexPublicFeed.fetch)
        self.assertEqual(sig.parameters["need"].default, 198)

    def test_need_198_derives_limit_200(self):
        self.assertEqual(min(198 + 2, MAX_LIMIT), 200)

    def test_need_199_raises_before_request(self):
        # A raising session: if fetch touches the network, this fails loudly.
        class NoNet:
            def get(self, *a, **k):
                raise AssertionError("fetch issued a request before validating need")

        feed = ApexPublicFeed(session=NoNet())
        with self.assertRaises(ValueError) as cm:
            feed.fetch("ETHUSDT", 5, need=199)
        self.assertIn("199", str(cm.exception))

    def test_need_zero_raises(self):
        class NoNet:
            def get(self, *a, **k):
                raise AssertionError("fetch issued a request before validating need")

        feed = ApexPublicFeed(session=NoNet())
        with self.assertRaises(ValueError):
            feed.fetch("ETHUSDT", 5, need=0)

    def test_klines_raw_rejects_limit_above_ceiling(self):
        class NoNet:
            def get(self, *a, **k):
                raise AssertionError("klines_raw issued a request with a bad limit")

        feed = ApexPublicFeed(session=NoNet())
        with self.assertRaises(ValueError) as cm:
            feed.klines_raw("ETHUSDT", 5, limit=202)
        self.assertIn("202", str(cm.exception))


class TestFeedAge(unittest.TestCase):
    """Staleness is REPORTED. B-6 has no ratified threshold; nothing here
    enforces one, and the worker's 30s guard bound must not be borrowed."""

    def _feed(self, fetched_at_ms: int) -> Feed:
        candles = parse_klines(envelope(series(3)), "ETHUSDT", 5)
        last_open = int(candles[-1][0])
        return Feed(
            symbol="ETHUSDT",
            interval_min=5,
            candles=candles,
            tick=0.01,
            last_close_ts_ms=last_open + STEP_MS,
            fetched_at_ms=fetched_at_ms,
            source="test",
        )

    def test_age_zero_at_close(self):
        f = self._feed(BASE_TS + STEP_MS)
        self.assertEqual(f.age_sec, 0.0)

    def test_age_counts_from_close_not_open(self):
        f = self._feed(BASE_TS + STEP_MS + 90_000)
        self.assertEqual(f.age_sec, 90.0)

    def test_summary_reports_age_and_never_halts(self):
        f = self._feed(BASE_TS + STEP_MS + 3_600_000)
        s = f.summary()
        self.assertEqual(s["age_sec"], 3600.0)
        self.assertEqual(s["candles"], 3)
        self.assertNotIn("halt", " ".join(s.keys()).lower())


class TestSignalPathContract(unittest.TestCase):
    """The feed's output must be directly consumable by accumulator_signal
    without reshaping. If this breaks, the wiring step is unsafe."""

    def test_candle_index_contract(self):
        from accumulator_signal import CLOSE, HIGH, LOW, OPEN, TS, VOLUME

        body = envelope([row(BASE_TS, 100.0, 105.0, 99.0, 104.0, 7.0)])
        c = parse_klines(body, "ETHUSDT", 5)[0]
        self.assertEqual(c[TS], float(BASE_TS))
        self.assertEqual(c[OPEN], 100.0)
        self.assertEqual(c[HIGH], 105.0)
        self.assertEqual(c[LOW], 99.0)
        self.assertEqual(c[CLOSE], 104.0)
        self.assertEqual(c[VOLUME], 7.0)

    def test_wilder_atr_consumes_feed_output(self):
        from accumulator_signal import ATR_PERIOD, wilder_atr_series

        candles = parse_klines(envelope(series(60)), "ETHUSDT", 5)
        atr = wilder_atr_series(candles)
        self.assertIsNone(atr[ATR_PERIOD - 2])
        self.assertIsNotNone(atr[ATR_PERIOD - 1])
        self.assertGreater(atr[-1], 0.0)

    def test_captured_live_candles_feed_wilder_atr(self):
        from accumulator_signal import true_ranges

        out = parse_klines(LIVE_LIMIT_200, "ETHUSDT", 5, 200)
        tr = true_ranges(out)
        self.assertEqual(len(tr), 2)
        self.assertGreater(tr[0], 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestContractConfigVerified(unittest.TestCase):
    """Live BTC-USDT capture, 2026-07-17. No minimum-notional field exists."""

    LIVE = {"symbol": "BTC-USDT", "crossSymbolName": "BTCUSDT",
            "minOrderSize": "0.0010", "stepSize": "0.001", "tickSize": "0.1",
            "maxOrderSize": "50", "maxPositionSize": "225",
            "maxPositionValue": "15000000"}

    def _feed(self, entry):
        class R:
            status_code = 200
            def __init__(s, b): s._b = b
            def json(s): return s._b
        class S:
            def get(s, url, params=None, timeout=None):
                return R({"data": {"contractConfig": {"perpetualContract": [entry]}}})
        return ApexPublicFeed(session=S())

    def test_reads_verified_fields(self):
        c = self._feed(self.LIVE).contract_config("BTC-USDT")
        self.assertEqual(c["minOrderSize"], 0.0010)
        self.assertEqual(c["stepSize"], 0.001)
        self.assertEqual(c["tickSize"], 0.1)
        self.assertEqual(c["maxOrderSize"], 50.0)
        self.assertEqual(c["maxPositionSize"], 225.0)
        self.assertEqual(c["maxPositionValue"], 15000000.0)

    def test_no_minimum_notional_field_is_expected(self):
        self.assertNotIn("minOrderValue", self.LIVE)
        self.assertNotIn("minNotional", self.LIVE)

    def test_missing_required_field_fails_closed(self):
        for f in ("minOrderSize", "stepSize", "maxOrderSize", "maxPositionValue"):
            e = {k: v for k, v in self.LIVE.items() if k != f}
            with self.assertRaises(FeedShapeError) as cm:
                self._feed(e).contract_config("BTC-USDT")
            self.assertIn(f, str(cm.exception))

    def test_non_positive_field_fails_closed(self):
        with self.assertRaises(FeedShapeError):
            self._feed({**self.LIVE, "minOrderSize": "0"}).contract_config("BTC-USDT")
