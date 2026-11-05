"""Public native Base feed. All pages share one indexed block; no venue fallback.

Source: SynFutures/oyster-sdk src/chart/kline.ts and src/config/base.json.
Empty intervals are carried forward only after the full, pinned query completes.
An incomplete page scan, indexing error or stale index refuses the entire feed.
"""
import re
import time
import requests
from market_data import Feed, FeedShapeError, FeedTransportError, FeedIntegrityError, validate_series
from shared.synfutures_math import WAD, price_at_tick, tick_at_price

ENDPOINT = "https://api.synfutures.com/thegraph/v3-base"
MARKETS = {"BTC-USDC": "0xec6c44e704eb1932ec5fe1e4aba58db6fee71460",
           "ETH-USDC": "0x04d72fb4803b4e02f14971e5bd092375eb330749"}
DIRECT = {60: "hourlyAmmDatas", 240: "per4HourAmmDatas", 1440: "dailyAmmDatas"}
PAGE_SIZE, MAX_PAGES = 1000, 20
# Index-health bound, not a strategy tuning parameter. Never fill beyond indexed time.
MAX_INDEX_LAG_SECONDS = 120


class SynFuturesPublicFeed:
    def __init__(self, session=None):
        self.session = session or requests.Session()

    def _query(self, query, variables=None):
        try:
            response = self.session.post(ENDPOINT, json={"query": query, "variables": variables or {}},
                                         timeout=(12, 15), allow_redirects=False)
            if response.status_code != 200:
                raise FeedTransportError("SynFutures subgraph HTTP failure")
            body = response.json()
        except requests.RequestException:
            raise FeedTransportError("SynFutures subgraph unavailable") from None
        except ValueError:
            raise FeedShapeError("SynFutures subgraph invalid JSON") from None
        if not isinstance(body, dict) or body.get("errors") or not isinstance(body.get("data"), dict):
            raise FeedShapeError("SynFutures subgraph query failed")
        return body["data"]

    def fetch(self, symbol, interval_min=5, need=198, now_ms=None):
        if symbol not in MARKETS:
            raise FeedShapeError("SynFutures symbol unsupported by deployed module")
        if interval_min not in (5, 15, 60, 240, 1440) or type(need) is not int or not 1 <= need <= 500:
            raise ValueError("SynFutures interval or count unsupported")
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        began = time.monotonic()
        meta = self._query("{_meta {hasIndexingErrors block {number timestamp hash}}}").get("_meta")
        try:
            block, indexed = int(meta["block"]["number"]), int(meta["block"]["timestamp"])
            block_hash = meta["block"]["hash"]
            # Head may advance while the HTTP request is in flight. Account
            # for elapsed read time without advancing the requested candle end.
            health_clock = now // 1000 + int(time.monotonic() - began)
            if meta["hasIndexingErrors"] is not False or not -5 <= health_clock - indexed <= MAX_INDEX_LAG_SECONDS:
                raise ValueError()
            if not isinstance(block_hash, str) or not re.fullmatch(r"0x[0-9a-f]{64}", block_hash):
                raise ValueError()
        except (TypeError, KeyError, ValueError):
            raise FeedIntegrityError("SynFutures index health unconfirmed") from None
        step = interval_min * 60
        # A candle must be closed both on the clock and in the indexed chain.
        end = min(now // 1000, indexed) // step * step
        if end != now // 1000 // step * step:
            raise FeedIntegrityError("SynFutures latest completed candle not indexed")
        start = end - (need + 12) * step
        entity = DIRECT.get(interval_min, "virtualTrades")
        fields = "id timestamp open high low close baseVolume" if interval_min in DIRECT else "id timestamp blockNumber price size"
        extra = "open_gt:0," if interval_min in DIRECT else "type_in:[LIQUIDATION,MARKET],fee_gt:0,"
        query = ("query($cursor:String!,$block:Bytes!){" + entity +
                 f'(first:{PAGE_SIZE},block:{{hash:$block}},orderBy:id,orderDirection:asc,where:{{'
                 f'amm:"{MARKETS[symbol]}-4294967295",{extra}timestamp_gte:{start},timestamp_lt:{end},id_gt:$cursor}})'
                 + "{" + fields + "} _meta(block:{hash:$block}){block{hash}}}")
        rows, cursor = [], ""
        for _ in range(MAX_PAGES):
            data = self._query(query, {"cursor": cursor, "block": block_hash})
            if data.get("_meta", {}).get("block", {}).get("hash") != block_hash:
                raise FeedIntegrityError("SynFutures indexed block changed during pagination")
            page = data.get(entity)
            if not isinstance(page, list) or len(page) > PAGE_SIZE:
                raise FeedShapeError("SynFutures page malformed")
            for row in page:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] <= cursor:
                    raise FeedIntegrityError("SynFutures pagination did not advance")
                cursor = row["id"]
                try:
                    ts = int(row["timestamp"])
                    if not start <= ts < end:
                        raise ValueError()
                except (KeyError, TypeError, ValueError):
                    raise FeedShapeError("SynFutures timestamp invalid") from None
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                break
        else:
            raise FeedIntegrityError("SynFutures page limit reached; refusing partial candles")
        candles = {}
        try:
            if interval_min in DIRECT:
                for row in rows:
                    ts = int(row["timestamp"])
                    if ts % step or ts in candles:
                        raise ValueError()
                    candles[ts] = [ts * 1000] + [int(row[k]) / WAD for k in ("open", "high", "low", "close", "baseVolume")]
            else:
                # Event IDs contain transaction hash and GLOBAL log index. Hash
                # order alone is not trade order within the same block.
                def event_order(row):
                    match = re.fullmatch(r"0x[0-9a-fA-F]{64}-0x([0-9a-fA-F]+)-(?:MARKET|LIQUIDATION)", row["id"])
                    if not match:
                        raise ValueError()
                    return int(row["blockNumber"]), int(match[1], 16)
                rows.sort(key=event_order)
                previous_order = None
                previous_ts = -1
                for row in rows:
                    order, ts = event_order(row), int(row["timestamp"])
                    if order == previous_order or ts < previous_ts:
                        raise ValueError()
                    previous_order, previous_ts = order, ts
                    price, size = int(row["price"]), abs(int(row["size"]))
                    if price <= 0 or size <= 0:
                        raise ValueError()
                    bucket, px, volume = ts // step * step, price / WAD, size / WAD
                    if bucket not in candles:
                        candles[bucket] = [bucket * 1000, px, px, px, px, volume]
                    else:
                        c = candles[bucket]
                        c[2], c[3], c[4], c[5] = max(c[2], px), min(c[3], px), px, c[5] + volume
            if not candles:
                raise ValueError()
        except (KeyError, TypeError, ValueError, OverflowError):
            raise FeedShapeError("SynFutures candle data invalid") from None
        first = min(candles)
        completed, previous = [], None
        for ts in range(first, end, step):
            candle = candles.get(ts)
            if candle is None:
                px = previous[4]
                candle = [ts * 1000, px, px, px, px, 0.0]
            completed.append(candle)
            previous = candle
        if len(completed) < need:
            raise FeedIntegrityError("SynFutures insufficient completed candles")
        completed = completed[-need:]
        validate_series(completed, interval_min, symbol)
        mark = int(round(completed[-1][4] * WAD))
        tick = tick_at_price(mark)
        # Local geometric increment is used ONLY by signal zone tolerance.
        increment = (price_at_tick(tick + 1) - price_at_tick(tick)) / WAD
        return Feed(symbol=symbol, interval_min=interval_min, candles=completed,
                    tick=increment, last_close_ts_ms=end * 1000, fetched_at_ms=now, source=ENDPOINT)
