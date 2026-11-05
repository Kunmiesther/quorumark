from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import MagicMock
import threading
import pytest
import bot_worker as bw
from shared.execution_configuration import configured_leverage
from test_decision_pipeline import _bot, _confirmed, _feed, LIVE_CFG, USER, CONNECTION, NOW_MS

class Feed:
    def __init__(self, value, fail=False):
        self.value, self.fail, self.calls = value, fail, 0
    def fetch(self,*args,**kwargs):
        self.calls += 1
        if self.fail: raise RuntimeError('transient public feed failure')
        return SimpleNamespace(candles=[[self.value]*6]*60)

def test_htf_votes_never_borrow_another_venues_candles():
    bot = _bot()
    apex,aster = Feed(10),Feed(20)
    assert bot._htf_frames(apex,'BTC-USDT',NOW_MS)['1h'][0][0] == 10
    assert bot._htf_frames(aster,'BTC-USDT',NOW_MS)['1h'][0][0] == 20
    bot._htf_frames(apex,'BTC-USDT',NOW_MS)
    assert apex.calls == aster.calls == 3

def test_failed_daily_and_four_hour_reads_retry_next_cycle():
    bot,feed = _bot(),Feed(20,fail=True)
    assert all(value is None for value in bot._htf_frames(feed,'BTC-USDT',NOW_MS).values())
    feed.fail = False
    assert all(value is not None for value in bot._htf_frames(feed,'BTC-USDT',NOW_MS+15000).values())
    assert feed.calls == 6

@pytest.mark.parametrize('value',[None,True,'bad','NaN','Infinity',0,-1,100.5,101])
def test_apex_mandate_cannot_invent_leverage(value):
    bot = _bot()
    cfg = {**LIVE_CFG,'exchange_type':'apex_omni','params':{'dynamic_wallet_sizing':True,'leverage':value}}
    with patch.object(bot,'_update_decision_execution') as record, patch.object(bot,'submit_order_intent') as submit, patch('accumulator_live_size.plan_entry_size') as size:
        bot._execute_decision(cfg=cfg,user_id=USER,connection_id=CONNECTION,symbol='ETH-USDT',normalized='ETHUSDT',
            decision={'decision_id':'test'},strategy='accumulator',chosen=_confirmed(),gate={},feed=_feed(),feed_client=None,now=NOW_MS)
    assert record.call_args.kwargs['reason_code'] in {'LEVERAGE_CHOICE_REQUIRED','LEVERAGE_INVALID'}
    submit.assert_not_called()
    size.assert_not_called()

@pytest.mark.parametrize('value',[1,50,100,'50','100.0'])
def test_explicit_whole_number_leverage_is_shared_by_both_venues(value):
    assert configured_leverage(value,maximum=100) == int(float(value))
    assert configured_leverage(value,maximum=125) == int(float(value))

def test_aster_ceiling_does_not_raise_apex_authority():
    assert configured_leverage(125,maximum=125) == 125
    assert configured_leverage(125,maximum=100) is None

def test_two_venues_evaluate_concurrently_without_real_orders():
    bot=_bot()
    bot.halted=MagicMock(return_value=False)
    barrier=threading.Barrier(2)
    completed=[]
    def observe(cfg,*args):
        barrier.wait(timeout=2)
        completed.append(cfg['exchange_type'])
    bot.observe_signal=observe
    bot._run_config_cycle([
        {'user_id':USER,'connection_id':'apex','exchange_type':'apex_omni'},
        {'user_id':USER,'connection_id':'aster','exchange_type':'aster'},
    ])
    assert sorted(completed)==['apex_omni','aster']

def test_same_venue_ordering_and_guard_failure_are_isolated():
    bot=_bot()
    bot.halted=MagicMock(side_effect=[RuntimeError('bad guard'),False,False])
    observed=[]
    bot.observe_signal=lambda cfg,*args: observed.append(cfg['symbol'])
    bot._run_config_cycle([{'user_id':USER,'connection_id':CONNECTION,'exchange_type':'apex_omni','symbol':symbol}
        for symbol in ['BTC-USDT','ETH-USDT','SOL-USDT']])
    assert observed==['ETH-USDT','SOL-USDT']
