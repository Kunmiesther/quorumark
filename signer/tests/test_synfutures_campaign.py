import copy
import pytest
from app.synfutures_campaign import build_campaign,next_action
from app.synfutures_entry import SynFuturesEntryError
from shared.synfutures_math import WAD

def rig(long=True):
    plan=build_campaign(symbol='BTC-USDC',long=long,margin_usdc='125',leverage=33,reference_mark=100*WAD,take_profit_bps=100)
    c={'symbol':'BTC-USDC','side':'BUY' if long else 'SELL','module_revision':'1','status':'active','plan':plan}
    s={'timestamp':100,'session_valid_until':1000,'module_revision':'1','operator_exit_available':True,
       'positions':{'BTC-USDC':{'signed_size':'0','mark':str(100*WAD),'entry_notional':'0'}}}
    return c,s,[]
def decide(c,s,a,paused=False):return next_action(campaign=c,snapshot=s,actions=a,entry_halted=paused)
def fill(c,s,a,rung,state='confirmed'):
    size=WAD if c['side']=='BUY' else -WAD
    a.append({'kind':'entry','rung':rung,'state':state,'signed_size':str(size)})
    s['positions']['BTC-USDC']['signed_size']=str(sum(int(x['signed_size']) for x in a))
    s['positions']['BTC-USDC']['entry_notional']=str(len(a)*100*WAD)

@pytest.mark.parametrize('long',[True,False])
def test_waits_against_signal_and_advances_only_verified_fills(long):
    c,s,a=rig(long);assert decide(c,s,a)['kind']=='wait'
    assert c['plan']['margin_total']==str(125*WAD) and c['plan']['margin_per_rung']==str(25*WAD)
    for rung in range(1,6):
        s['positions']['BTC-USDC']['mark']=c['plan']['triggers'][rung-1]
        assert decide(c,s,a)=={'kind':'entry','rung':rung,'reason':'SYNFUTURES_PULLBACK_TRIGGER'}
        fill(c,s,a,rung)
    s['positions']['BTC-USDC']['mark']=str((102 if long else 98)*WAD)
    assert decide(c,s,a)['reason']=='SYNFUTURES_TAKE_PROFIT'

@pytest.mark.parametrize('long',[True,False])
def test_provisional_entry_allows_protection_but_no_new_rung(long):
    c,s,a=rig(long);fill(c,s,a,1,'mined');s['positions']['BTC-USDC']['mark']=c['plan']['triggers'][1]
    assert decide(c,s,a)['reason']=='SYNFUTURES_AWAITING_CANONICAL_FINALITY'
    s['positions']['BTC-USDC']['mark']=c['plan']['stop_price']
    assert decide(c,s,a)['kind']=='exit'
    assert decide(c,s,a,True)['kind']=='exit'

@pytest.mark.parametrize('state',['unknown','signing','prepared','broadcast','reconciliation_required'])
def test_uncertainty_never_replays_or_claims_flat(state):
    c,s,a=rig();a.append({'state':state,'kind':'entry'})
    assert decide(c,s,a,True)['kind']=='wait'

def test_revision_expiry_and_foreign_exposure_require_recovery():
    c,s,a=rig();fill(c,s,a,1)
    s['module_revision']='2';assert decide(c,s,a)['kind']=='recovery'
    s['module_revision']='1';s['operator_exit_available']=False;assert decide(c,s,a)['kind']=='recovery'
    s['operator_exit_available']=True;s['positions']['BTC-USDC']['signed_size']=str(2*WAD);assert decide(c,s,a)['kind']=='recovery'

def test_owner_flat_proceeds_only_to_finalized_accounting():
    c,s,a=rig();fill(c,s,a,1);s['positions']['BTC-USDC']['signed_size']='0'
    assert decide(c,s,a)['kind']=='close'
    a[0]['state']='mined';assert decide(c,s,a)['kind']=='recovery'

def test_failed_exit_can_retry_protection_without_entries():
    c,s,a=rig();fill(c,s,a,1);a.append({'kind':'exit','state':'failed'})
    assert decide(c,s,a)['kind']=='exit'

def test_no_implicit_tp_or_margin_rounding():
    c,_,_=rig()
    for tp in (None,0,True,10000):
        with pytest.raises(SynFuturesEntryError):build_campaign(symbol='BTC-USDC',long=True,margin_usdc='125',leverage=33,reference_mark=WAD,take_profit_bps=tp)
    with pytest.raises(SynFuturesEntryError):build_campaign(symbol='BTC-USDC',long=True,margin_usdc='0.000000000000000001',leverage=33,reference_mark=WAD,take_profit_bps=100)
