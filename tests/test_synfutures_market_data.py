from unittest.mock import Mock
import pytest
import synfutures_market_data as md
from market_data import FeedIntegrityError, FeedShapeError
from shared.synfutures_math import WAD

NOW=1800000000; HASH="0x"+"ab"*32


def meta(timestamp=NOW):
    return {"_meta":{"hasIndexingErrors":False,"block":{"number":123,"timestamp":timestamp,"hash":HASH}}}


def page(entity, rows, hash=HASH):
    return {entity:rows,"_meta":{"block":{"hash":hash}}}


def event(log, block, timestamp, price):
    return {"id":"0x"+f"{100-log:064x}"+f"-0x{log:x}-MARKET", "blockNumber":str(block),
            "timestamp":str(timestamp), "price":str(price*WAD), "size":str(-WAD)}


def test_trade_ohlc_uses_block_and_log_order_not_hash():
    # Sort pages by ID as the endpoint does; the chronological price sequence
    # must still be 100 -> 105 -> 103 -> 101 inside this candle.
    end=NOW//300*300; start=end-600
    rows=[event(1,1,start,100),event(2,1,start,105),event(3,2,start+2,103),event(4,2,start+2,101)]
    rows.sort(key=lambda r:r["id"])
    f=md.SynFuturesPublicFeed(); f._query=Mock(side_effect=[meta(),page("virtualTrades",rows)])
    feed=f.fetch("BTC-USDC",5,2,now_ms=NOW*1000)
    assert feed.candles[0][1:] == [100.,105.,100.,101.,4.]
    assert feed.candles[1][1:] == [101.,101.,101.,101.,0.]
    assert feed.last_close_ts_ms==end*1000


@pytest.mark.parametrize("interval,entity", list(md.DIRECT.items()))
def test_higher_timeframes_use_native_entities(interval,entity):
    end=NOW//(interval*60)*(interval*60)
    row=dict(id="a",timestamp=str(end-interval*60),open=str(100*WAD),high=str(102*WAD),
             low=str(99*WAD),close=str(101*WAD),baseVolume=str(WAD))
    f=md.SynFuturesPublicFeed(); f._query=Mock(side_effect=[meta(),page(entity,[row])])
    assert f.fetch("ETH-USDC",interval,1,now_ms=NOW*1000).candles[0][1:]==[100.,102.,99.,101.,1.]
    assert entity in f._query.call_args.args[0]
    assert f._query.call_args.args[1]["block"]==HASH


def test_stale_or_indexing_error_refuses_before_candles():
    for m in (meta(NOW-121), {"_meta":{**meta()["_meta"],"hasIndexingErrors":True}}):
        f=md.SynFuturesPublicFeed(); f._query=Mock(return_value=m)
        with pytest.raises(FeedIntegrityError,match="health"): f.fetch("BTC-USDC",now_ms=NOW*1000)
        assert f._query.call_count==1


def test_reorg_during_pagination_refuses_all_data():
    f=md.SynFuturesPublicFeed(); f._query=Mock(side_effect=[meta(),page("virtualTrades",[],"0x"+"cd"*32)])
    with pytest.raises(FeedIntegrityError,match="changed"): f.fetch("BTC-USDC",now_ms=NOW*1000)


def test_page_cap_is_not_partial_success(monkeypatch):
    monkeypatch.setattr(md,"PAGE_SIZE",1); monkeypatch.setattr(md,"MAX_PAGES",1)
    row=event(1,1,NOW-600,100)
    f=md.SynFuturesPublicFeed(); f._query=Mock(side_effect=[meta(),page("virtualTrades",[row])])
    with pytest.raises(FeedIntegrityError,match="partial"): f.fetch("BTC-USDC",now_ms=NOW*1000)


def test_sol_xrp_and_usdt_are_not_silently_substituted():
    for s in ("SOL-USDC","XRP-USDC","BTC-USDT"):
        with pytest.raises(FeedShapeError): md.SynFuturesPublicFeed().fetch(s)
