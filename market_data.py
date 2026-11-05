"""ApeX Omni PUBLIC market-data feed — Stage 1.

Supplies the missing input to `accumulator_signal.evaluate()`.

SCOPE — read this before trusting anything below
------------------------------------------------
PUBLIC ONLY. No API key, no passphrase, no HMAC, no zk signing, no headers.
This module cannot authenticate and therefore cannot trade, cannot read an
account, and cannot touch `exchange_connections`. It issues exactly two GETs:

    GET /api/v3/symbols   -> tick size (S22 needs `tick`; never invented)
    GET /api/v3/klines    -> candles

Endpoints and parameter names verified against the official SDK
(apexomni 3.3.1, `apexomni/http_public.py` klines_v3 / `__init__.py`
configs_v3). Base URL from `apexomni/constants.py`:
APEX_OMNI_HTTP_MAIN = 'https://omni.apex.exchange'.

VERIFIED RESPONSE SHAPE — live Railway capture, 2026-07-16
----------------------------------------------------------
Captured from the deployed worker container against mainnet. This is an
observation, not a reading of the docs:

    GET /api/v3/klines?symbol=ETHUSDT&interval=5&limit=200
    {"data": {"ETHUSDT": [
        {"s":"ETHUSDT","i":"5","t":1784169900000,
         "c":"1923.25","h":"1923.91","l":"1920.94","o":"1920.94",
         "v":"16.1","tr":"30956.2232"},
        ...
    ]}, "timeCost": 2123}

Facts this capture establishes:
  * `data` is an OBJECT KEYED BY SYMBOL. It is never an array. A bare-list
    `data` branch previously existed here on no evidence and has been removed.
  * `timeCost` is a sibling of `data`, outside it, and is ignored.
  * Rows carry `s`, `i`, `t`, `o`, `h`, `l`, `c`, `v`, `tr`. `tr` is ignored.
  * JSON key order is `s,i,t,c,h,l,o,v,tr` — parsing is BY KEY, never by
    position.
  * `t` is MILLISECONDS. 1784169900000 -> 2026-07-16 02:45:00 UTC, exactly
    5m-aligned, consecutive rows spaced 300000ms.

VERIFIED LIMIT BEHAVIOUR — same capture
---------------------------------------
    limit=200  -> candles
    limit=202  -> {"data": {}, "timeCost": 2123}   HTTP 200, no error
    limit=201  -> NOT TESTED. Not verified. Do not describe it as verified.

200 is therefore the VERIFIED ceiling, not an inferred one. `MAX_LIMIT = 1500`
previously stood here as an invented number and was the entire cause of the
first live probe failure: `fetch(need=200)` asked for limit=202, ApeX answered
with empty data, and the dict branch reported it as a missing symbol key.

An empty `data` object is NOT self-diagnosing. It may mean the limit exceeded
the venue's maximum, or an unsupported symbol, or a period with no candles.
`extract_rows` reports the request and refuses to guess between them.

COMPLETED CANDLES ONLY
----------------------
`accumulator_signal` is specified over COMPLETED candles throughout (S19
pivots, S20 lookback, S25 retest window). A live klines response includes the
CURRENT, still-forming candle as its last element. Feeding that to the signal
path reintroduces exactly the lookahead bias that was removed from Vanguard.
`completed_candles()` drops it: a candle at open time `t` is complete only
once `now_ms >= t + interval_ms`.

STALENESS IS REPORTED, NOT ENFORCED
-----------------------------------
B-6 (`stale_feed_halt: true` has no threshold) is an open v1.1 ratification
blocker. This module returns `age_sec` and refuses to invent a halt
threshold. The 30s bound in `bot_worker.EXECUTION_GUARD_MAX_AGE_SEC` is a
GUARD-read bound and has nothing to do with market data — do not borrow it.

NO PERSISTENCE
--------------
G32 ruled `strategy_state` out and authorised no table. Nothing here writes to
the database. Callers log through the existing `BOT_EVENT_INSERT` op of
worker-ingest or not at all.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional, Sequence

import requests

APEX_OMNI_HTTP_MAIN = "https://omni.apex.exchange"
APEX_OMNI_HTTP_TEST = "https://testnet.omni.apex.exchange"

# Testnet candles are fiction — thin books, synthetic prints. The entry path is
# pure structure (S19/S20/S25), so validating it against a market that does not
# exist validates nothing. Mainnet public data is the default and should stay
# the default; testnet belongs to Stage 3 order mechanics, not to this module.
DEFAULT_BASE_URL = APEX_OMNI_HTTP_MAIN

KLINES_PATH = "/api/v3/klines"
SYMBOLS_PATH = "/api/v3/symbols"

HTTP_TIMEOUT = (5, 10)  # (connect, read)

# VERIFIED ceiling — see the limit table in the module docstring. 200 returns
# candles; 202 returns an empty data object with HTTP 200. 201 is untested.
# This is an observation from the deployed container, not a documented value:
# ApeX publishes no maximum and the SDK's own demo calls limit=5.
MAX_LIMIT = 200

# Most completed candles obtainable in ONE call: the venue ceiling, less the
# still-forming candle `drop_incomplete` removes, less one boundary race.
MAX_NEED_PER_CALL = MAX_LIMIT - 2

# Row keys required on every candle. `s` and `i` are required and CHECKED, not
# merely present: a response echoing a different symbol or interval than the
# one requested is a wrong answer, not a parseable one.
_ROW_SYMBOL = "s"
_ROW_INTERVAL = "i"
_ROW_TS = "t"
_ROW_OPEN = "o"
_ROW_HIGH = "h"
_ROW_LOW = "l"
_ROW_CLOSE = "c"
_ROW_VOLUME = "v"
_REQUIRED_ROW_KEYS = (
    _ROW_SYMBOL,
    _ROW_INTERVAL,
    _ROW_TS,
    _ROW_OPEN,
    _ROW_HIGH,
    _ROW_LOW,
    _ROW_CLOSE,
    _ROW_VOLUME,
)


class FeedError(Exception):
    """Base. Every failure here is a REFUSAL to return candles, never a
    partial or patched series. A strategy fed guessed data is worse than a
    strategy fed nothing."""


class FeedTransportError(FeedError):
    """DNS / TLS / timeout / connection / non-200. Retryable."""


class FeedShapeError(FeedError):
    """Response reached us but did not match the verified shape. NOT
    retryable — the parser, the request, or the assumption is wrong."""


class FeedIntegrityError(FeedError):
    """Shape matched, contents did not survive validation: gaps, duplicates,
    non-monotonic timestamps, non-positive prices, inverted high/low."""


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Feed:
    symbol: str
    interval_min: int
    candles: list[list[float]]      # [[ts_ms, o, h, l, c, v], ...] ascending
    tick: float
    last_close_ts_ms: int           # close time of the newest COMPLETED candle
    fetched_at_ms: int
    source: str

    @property
    def age_sec(self) -> float:
        """Seconds between the newest completed candle's CLOSE and the fetch.
        Reported only. No threshold is applied — see B-6."""
        return (self.fetched_at_ms - self.last_close_ts_ms) / 1000.0

    def summary(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval_min": self.interval_min,
            "candles": len(self.candles),
            "tick": self.tick,
            "first_ts_ms": int(self.candles[0][0]) if self.candles else None,
            "last_ts_ms": int(self.candles[-1][0]) if self.candles else None,
            "last_close_ts_ms": self.last_close_ts_ms,
            "age_sec": round(self.age_sec, 1),
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# Parsing — fails closed
# ---------------------------------------------------------------------------
def extract_rows(
    body: Any,
    symbol: str,
    interval_min: int,
    limit: Optional[int] = None,
) -> list[dict]:
    """Pull the row list out of the verified `{"data": {"<SYMBOL>": [...]}}`
    envelope. Any other shape raises with what was actually seen.

    `symbol` must be the EXACT string sent to the venue (no dash, matching
    `klines_raw`). No case folding, no punctuation tolerance: neither is
    supported by the capture, and a normalising parser hides a wrong answer.
    """
    if not isinstance(body, dict):
        raise FeedShapeError(f"klines body is {type(body).__name__}, expected object")

    if "data" not in body:
        raise FeedShapeError(
            f"klines body has no 'data' key; top-level keys={sorted(body.keys())}"
        )

    data = body["data"]

    if not isinstance(data, dict):
        raise FeedShapeError(
            f"klines 'data' is {type(data).__name__}, expected object keyed by symbol"
        )

    if not data:
        # Verified to occur at limit=202. NOT diagnosed here: an empty data
        # object is also consistent with an unsupported symbol or a period
        # with no candles. Report the request and let the caller investigate.
        raise FeedShapeError(
            f"ApeX returned no candle data: 'data' is an empty object. "
            f"Request was symbol={symbol} interval={interval_min} limit={limit}. "
            f"Cause not determined here — an empty result is consistent with a "
            f"limit above the venue maximum (verified: 200 returns candles, 202 "
            f"returns empty), an unsupported symbol, or a period with no candles."
        )

    if symbol not in data:
        raise FeedShapeError(
            f"klines data has no '{symbol}' key; keys={sorted(data.keys())}"
        )

    return _as_rows(data[symbol], symbol, interval_min)


def _as_rows(v: Any, symbol: str, interval_min: int) -> list[dict]:
    if not isinstance(v, list):
        raise FeedShapeError(f"klines rows is {type(v).__name__}, expected array")
    want_interval = str(interval_min)
    for i, r in enumerate(v):
        if not isinstance(r, dict):
            raise FeedShapeError(f"klines row[{i}] is {type(r).__name__}, expected object")
        missing = [k for k in _REQUIRED_ROW_KEYS if k not in r]
        if missing:
            raise FeedShapeError(
                f"klines row[{i}] missing {missing}; actual keys={sorted(r.keys())}"
            )
        got_symbol = r[_ROW_SYMBOL]
        if got_symbol != symbol:
            raise FeedShapeError(
                f"klines row[{i}] symbol '{got_symbol}' != requested '{symbol}'"
            )
        got_interval = r[_ROW_INTERVAL]
        if got_interval != want_interval:
            raise FeedShapeError(
                f"klines row[{i}] interval '{got_interval}' != requested "
                f"'{want_interval}'"
            )
    return v


def parse_klines(
    body: Any,
    symbol: str,
    interval_min: int,
    limit: Optional[int] = None,
) -> list[list[float]]:
    """Envelope -> ascending [[ts_ms, o, h, l, c, v], ...].

    Timestamps are NOT rescaled. The live capture shows `t` in milliseconds
    (1784169900000 -> 2026-07-16 02:45:00 UTC, 5m-aligned). Fields are read by
    KEY: the venue's JSON key order is `s,i,t,c,h,l,o,v,tr`, so any
    positional read would silently transpose open and close.
    """
    rows = extract_rows(body, symbol, interval_min, limit)
    out: list[list[float]] = []
    for i, r in enumerate(rows):
        try:
            out.append([
                float(r[_ROW_TS]),
                float(r[_ROW_OPEN]),
                float(r[_ROW_HIGH]),
                float(r[_ROW_LOW]),
                float(r[_ROW_CLOSE]),
                float(r[_ROW_VOLUME]),
            ])
        except (TypeError, ValueError) as e:
            raise FeedShapeError(f"klines row[{i}] not numeric: {e}") from e
    out.sort(key=lambda c: c[0])
    return out


def validate_series(
    candles: Sequence[Sequence[float]], interval_min: int, symbol: str
) -> None:
    """Refuse anything the signal path would silently misread.

    A gap is NOT forward-filled. `find_confirmed_swings` and `select_subject`
    both count in candle INDICES, not wall-clock: a missing bar shifts the
    48-candle lookback and the 6-candle retest window by one and nothing
    complains. Better to skip the cycle than to evaluate a warped chart.
    """
    if not candles:
        raise FeedIntegrityError(f"{symbol}: zero candles")
    step_ms = interval_min * 60_000
    prev_ts = None
    for i, c in enumerate(candles):
        ts, o, h, l, cl = c[0], c[1], c[2], c[3], c[4]
        if min(o, h, l, cl) <= 0:
            raise FeedIntegrityError(f"{symbol}: non-positive price at index {i} ts={int(ts)}")
        if h < max(o, cl) or l > min(o, cl) or h < l:
            raise FeedIntegrityError(f"{symbol}: impossible OHLC at index {i} ts={int(ts)}")
        if ts % step_ms != 0:
            raise FeedIntegrityError(
                f"{symbol}: ts {int(ts)} at index {i} is not aligned to {interval_min}m"
            )
        if prev_ts is not None:
            delta = ts - prev_ts
            if delta == 0:
                raise FeedIntegrityError(f"{symbol}: duplicate ts {int(ts)} at index {i}")
            if delta != step_ms:
                raise FeedIntegrityError(
                    f"{symbol}: gap of {int(delta // 60_000)}m before index {i} "
                    f"(ts={int(ts)}); expected {interval_min}m"
                )
        prev_ts = ts


def drop_incomplete(
    candles: Sequence[Sequence[float]], interval_min: int, now_ms: int
) -> list[list[float]]:
    """Keep only candles whose close time has passed. See module docstring."""
    step_ms = interval_min * 60_000
    return [list(c) for c in candles if c[0] + step_ms <= now_ms]


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------
class ApexPublicFeed:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        session: Optional[requests.Session] = None,
        timeout: tuple = HTTP_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout
        self._tick_cache: dict[str, float] = {}

    def _get(self, path: str, params: Optional[dict] = None) -> Any:
        url = self.base_url + path
        try:
            r = self.session.get(url, params=params or {}, timeout=self.timeout)
        except requests.exceptions.RequestException as e:
            raise FeedTransportError(f"GET {path}: {type(e).__name__}") from e
        if r.status_code != 200:
            # 403 from ApeX means the IP is banned, not that the request was
            # malformed. Surface the code; do not retry into a longer ban.
            raise FeedTransportError(f"GET {path}: HTTP {r.status_code}")
        try:
            return r.json()
        except ValueError as e:
            raise FeedShapeError(f"GET {path}: response is not JSON") from e

    # -- tick size ---------------------------------------------------------
    def tick_size(self, symbol: str, refresh: bool = False) -> float:
        """`tickSize` for `symbol` from /api/v3/symbols.

        S22 sets zone tolerance = max(1 tick, 0.05 x ATR14). The tick is a
        VENUE fact. It is never defaulted here: a wrong tick silently widens
        or narrows every zone edge in the strategy.
        """
        key = symbol.replace("-", "").upper()
        if not refresh and key in self._tick_cache:
            return self._tick_cache[key]

        body = self._get(SYMBOLS_PATH)
        if not isinstance(body, dict) or "data" not in body:
            raise FeedShapeError("symbols body has no 'data' key")
        cc = body["data"].get("contractConfig") if isinstance(body["data"], dict) else None
        if not isinstance(cc, dict):
            raise FeedShapeError(
                f"symbols data has no 'contractConfig'; keys="
                f"{sorted(body['data'].keys()) if isinstance(body['data'], dict) else '?'}"
            )

        seen: list[str] = []
        for group in ("perpetualContract", "stockContract"):
            for entry in cc.get(group, []) or []:
                if not isinstance(entry, dict):
                    continue
                sym = str(entry.get("symbol", ""))
                cross = str(entry.get("crossSymbolName", ""))
                seen.append(sym)
                if key in (sym.replace("-", "").upper(), cross.replace("-", "").upper()):
                    raw = entry.get("tickSize")
                    if raw is None:
                        raise FeedShapeError(f"{symbol}: contract entry has no tickSize")
                    tick = float(raw)
                    if tick <= 0:
                        raise FeedShapeError(f"{symbol}: tickSize {raw} is not positive")
                    self._tick_cache[key] = tick
                    return tick
        raise FeedShapeError(
            f"{symbol} not found in contractConfig ({len(seen)} contracts listed)"
        )

    # -- venue contract config --------------------------------------------
    # VERIFIED against live ApeX BTC-USDT, 2026-07-17 (owner probe):
    #     minOrderSize 0.0010 · stepSize 0.001 · tickSize 0.1
    #     maxOrderSize 50 · maxPositionSize 225 · maxPositionValue 15000000
    #
    # THERE IS NO MINIMUM-NOTIONAL FIELD. An earlier version guessed at
    # minOrderValue/minNotional/minOrderNotional/minValue — wrong in KIND, not
    # just in name: ApeX bounds order QUANTITY, not order value. Those aliases
    # are removed. Any minimum notional is DERIVED (minOrderSize x price) and
    # is for display/validation only, never a venue field.
    _REQUIRED_CONTRACT_FIELDS = (
        "minOrderSize", "stepSize", "tickSize",
        "maxOrderSize", "maxPositionSize", "maxPositionValue",
    )

    _OPTIONAL_LEVERAGE_FIELDS = ("displayMaxLeverage", "initialMarginRate")

    def contract_config(self, symbol: str) -> dict:
        """Verified contract bounds from /api/v3/symbols. Fails closed if ANY
        required field is missing or non-positive — no defaults, no aliases."""
        key = symbol.replace("-", "").upper()
        body = self._get(SYMBOLS_PATH)
        cc = body.get("data", {}).get("contractConfig") if isinstance(body, dict) else None
        if not isinstance(cc, dict):
            raise FeedShapeError("symbols data has no 'contractConfig'")
        for group in ("perpetualContract", "stockContract"):
            for e in cc.get(group, []) or []:
                if not isinstance(e, dict):
                    continue
                sym = str(e.get("symbol", "")).replace("-", "").upper()
                cross = str(e.get("crossSymbolName", "")).replace("-", "").upper()
                if key not in (sym, cross):
                    continue
                missing = [f for f in self._REQUIRED_CONTRACT_FIELDS if e.get(f) is None]
                if missing:
                    raise FeedShapeError(
                        f"{symbol}: contract missing {missing}; actual keys={sorted(e.keys())}"
                    )
                out = {}
                for f in self._REQUIRED_CONTRACT_FIELDS:
                    try:
                        v = float(e[f])
                    except (TypeError, ValueError):
                        raise FeedShapeError(f"{symbol}: {f} is not numeric")
                    if v <= 0:
                        raise FeedShapeError(f"{symbol}: {f} is not positive")
                    out[f] = v
                out["symbol"] = str(e.get("symbol"))
                # Venue leverage ceiling. OPTIONAL on purpose: it is not part
                # of the fail-closed required set (an order can be sized
                # without it), but when ApeX publishes it the sizer must use
                # it instead of any table baked into this repo.
                for f in self._OPTIONAL_LEVERAGE_FIELDS:
                    v = e.get(f)
                    if v is None:
                        continue
                    try:
                        fv = float(v)
                    except (TypeError, ValueError):
                        continue
                    if fv > 0:
                        out[f] = fv
                return out
        raise FeedShapeError(f"{symbol} not found in contractConfig")

    def contract_probe(self, symbol: str = "BTC-USDT") -> dict:
        """Dump the live contract entry. Read-only."""
        cc = self._get(SYMBOLS_PATH)["data"]["contractConfig"]
        key = symbol.replace("-", "").upper()
        for group in ("perpetualContract", "stockContract"):
            for e in cc.get(group, []) or []:
                if key == str(e.get("symbol", "")).replace("-", "").upper():
                    return e
        raise FeedShapeError(f"{symbol} not found")

    # -- candles -----------------------------------------------------------
    def klines_raw(
        self,
        symbol: str,
        interval_min: int = 5,
        limit: int = 200,
        start_sec: Optional[int] = None,
        end_sec: Optional[int] = None,
    ) -> Any:
        """Raw envelope. `symbol` is sent without the dash, matching the SDK's
        `kwargs['symbol'].replace('-', '')`. `interval` is the minute count as
        a string ('5'), `start`/`end` are SECONDS (SDK demo: 1718358480)."""
        if limit < 1 or limit > MAX_LIMIT:
            raise ValueError(f"limit {limit} out of range 1..{MAX_LIMIT}")
        params: dict[str, Any] = {
            "symbol": symbol.replace("-", ""),
            "interval": str(interval_min),
            "limit": limit,
        }
        if start_sec is not None:
            params["start"] = int(start_sec)
        if end_sec is not None:
            params["end"] = int(end_sec)
        return self._get(KLINES_PATH, params)

    def fetch(
        self,
        symbol: str,
        interval_min: int = 5,
        need: int = MAX_NEED_PER_CALL,
        now_ms: Optional[int] = None,
    ) -> Feed:
        """Completed, validated, ascending candles ready for
        `accumulator_signal.evaluate(feed.candles, direction, feed.tick)`.

        `need` is the count of COMPLETED candles required, capped at
        MAX_NEED_PER_CALL (198) by the venue's verified 200 ceiling. Asking
        for more raises BEFORE any request is issued rather than silently
        returning a short series — the failure mode that made a limit=202 ask
        look like a parser bug.

        198 clears the signal path's own minimums with real headroom:
            48  S20 lookback
          + 14  ATR14 seed
          + 15  EMA(15) seed
          +  4  five-candle pivot shoulders
          +  6  S25 retest window
        Do not tune below ~90 without re-reading `accumulator_signal`; a short
        series does not error, it just returns None from `detect_break`
        forever and looks like a quiet market.
        """
        if need > MAX_NEED_PER_CALL:
            raise ValueError(
                f"need {need} exceeds MAX_NEED_PER_CALL {MAX_NEED_PER_CALL} "
                f"(venue limit ceiling {MAX_LIMIT}, verified). Paging is not "
                f"implemented; request {MAX_NEED_PER_CALL} or fewer."
            )
        if need < 1:
            raise ValueError(f"need {need} must be >= 1")

        fetched_at = int(time.time() * 1000) if now_ms is None else now_ms
        tick = self.tick_size(symbol)
        requested = symbol.replace("-", "")
        # +2 covers the in-progress candle plus one boundary race.
        limit = min(need + 2, MAX_LIMIT)
        body = self.klines_raw(symbol, interval_min, limit=limit)
        parsed = parse_klines(body, requested, interval_min, limit)
        completed = drop_incomplete(parsed, interval_min, fetched_at)
        if len(completed) < need:
            raise FeedIntegrityError(
                f"{symbol}: {len(completed)} completed candles, need {need} "
                f"({len(parsed)} returned)"
            )
        completed = completed[-need:]
        validate_series(completed, interval_min, symbol)
        step_ms = interval_min * 60_000
        return Feed(
            symbol=symbol,
            interval_min=interval_min,
            candles=completed,
            tick=tick,
            last_close_ts_ms=int(completed[-1][0]) + step_ms,
            fetched_at_ms=fetched_at,
            source=self.base_url,
        )


    def fetch_range(
        self,
        symbol: str,
        interval_min: int = 5,
        hours: int = 168,
        now_ms: Optional[int] = None,
    ) -> Feed:
        """Paged history. Walks BACKWARD in `end`-anchored windows.

        Exists because MAX_LIMIT is a VERIFIED 200 (limit=202 returns
        {"data": {}}), so any window longer than ~16h needs multiple calls.
        `start`/`end` are SECONDS per the SDK demo; `t` comes back in ms.

        Pages are stitched, de-duplicated by open time, sorted, and then run
        through the SAME drop_incomplete + validate_series as fetch(). A gap
        across a page boundary raises exactly like a gap inside one — history
        is never forward-filled to make a backtest look continuous.
        """
        step_ms = interval_min * 60_000
        fetched_at = int(time.time() * 1000) if now_ms is None else now_ms
        tick = self.tick_size(symbol)
        want = (hours * 3_600_000) // step_ms

        by_ts: dict[int, list[float]] = {}
        end_sec = fetched_at // 1000
        pages = 0
        # +8 pages of headroom; hard-stopped so a venue quirk cannot spin.
        max_pages = (want // (MAX_LIMIT - 1)) + 8
        while len(by_ts) < want and pages < max_pages:
            body = self.klines_raw(symbol, interval_min, limit=MAX_LIMIT, end_sec=end_sec)
            rows = parse_klines(body, symbol.replace("-", ""), interval_min, MAX_LIMIT)
            pages += 1
            if not rows:
                break
            before = len(by_ts)
            for c in rows:
                by_ts[int(c[0])] = c
            if len(by_ts) == before:
                break  # venue returned nothing new; stop rather than loop
            end_sec = (int(rows[0][0]) - step_ms) // 1000

        candles = [by_ts[k] for k in sorted(by_ts)]
        completed = drop_incomplete(candles, interval_min, fetched_at)
        if len(completed) < want:
            raise FeedIntegrityError(
                f"{symbol}: {len(completed)} completed candles over {pages} page(s), "
                f"need {want} for {hours}h"
            )
        completed = completed[-want:]
        validate_series(completed, interval_min, symbol)
        return Feed(
            symbol=symbol, interval_min=interval_min, candles=completed, tick=tick,
            last_close_ts_ms=int(completed[-1][0]) + step_ms,
            fetched_at_ms=fetched_at, source=self.base_url,
        )


# ---------------------------------------------------------------------------
# Probe — re-run after any change to the request or the parser
# ---------------------------------------------------------------------------
def _probe(symbol: str, interval_min: int = 5) -> int:
    feed = ApexPublicFeed()
    print(f"base_url = {feed.base_url}")

    print(f"\n--- GET {SYMBOLS_PATH} ---")
    try:
        print(f"tickSize({symbol}) = {feed.tick_size(symbol)}")
    except FeedError as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        return 1

    print(f"\n--- GET {KLINES_PATH} (raw, limit=3) ---")
    try:
        raw = feed.klines_raw(symbol, interval_min, limit=3)
    except (FeedError, ValueError) as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        return 1
    print(json.dumps(raw, indent=2)[:2000])

    print(f"\n--- parse + completed-only (need={MAX_NEED_PER_CALL}, limit={MAX_LIMIT}) ---")
    try:
        f = feed.fetch(symbol, interval_min)
    except (FeedError, ValueError) as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        print("\nThe raw body above is ground truth. Read it before changing the parser.")
        return 1
    print(json.dumps(f.summary(), indent=2))
    print(f"\nnewest completed candle: {f.candles[-1]}")
    print("OK — verified shape holds. Record this run against the docstring.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "probe":
        sym = sys.argv[2] if len(sys.argv) > 2 else "ETHUSDT"
        iv = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        raise SystemExit(_probe(sym, iv))
    print("usage: python market_data.py probe [SYMBOL] [INTERVAL_MIN]")
    raise SystemExit(2)
