import pytest
from unittest.mock import Mock
from app import synfutures_execution as ex
from app.synfutures_entry import SynFuturesEntryError
from app.synfutures_submission import SynFuturesSubmissionError,SubmissionLimits
from shared.synfutures_math import WAD

def snapshot():return {'timestamp':1000,'operator_exit_available':True,'operator_address':'operator','safe_address':'safe','module_address':'module',
 'module_revision':'1','module_nonce':'1','session_valid_until':2000,'slippage_bps':100,'live_entry_allowed':True,
 'positions':{'BTC-USDC':{'signed_size':str(WAD),'mark':str(100*WAD)}}}

def campaign():return {'id':'campaign','symbol':'BTC-USDC','side':'BUY','plan':{'margin_per_rung':str(25*WAD),'leverage':33,'triggers':[str(100*WAD)]},
 'actions':[{'kind':'entry','state':'confirmed','signed_size':str(WAD)}]}

def test_private_automation_defaults_disarmed_and_binding_scoped(monkeypatch):
    monkeypatch.delenv('SYNFUTURES_SIGNER_AUTOMATION_ENABLED',raising=False);assert ex.entry_enabled() is False
    with pytest.raises(SynFuturesEntryError,match='CONFIGURATION_REQUIRED'):ex.operator_account(user_id='user',connection_id='connection',snapshot=snapshot())
    monkeypatch.setenv('TURTLEBOT_SYNFUTURES_OPERATOR_BINDINGS','{"connection":{"user_id":"other"}}')
    with pytest.raises(SynFuturesEntryError,match='SCOPE_MISMATCH'):ex.operator_account(user_id='user',connection_id='connection',snapshot=snapshot())

@pytest.mark.parametrize('reason,failed',[('SYNFUTURES_SIMULATION_UNCONFIRMED',True),('SYNFUTURES_RESERVATION_UNCONFIRMED',False)])
def test_only_known_prebroadcast_failure_can_release_a_preparation(monkeypatch,reason,failed):
    db=Mock();db.synfutures_campaign_operation.return_value={'intent_id':'intent'}
    monkeypatch.setattr(ex,'operator_account',lambda **kw:(Mock(address='operator'),SubmissionLimits(1,1,1)))
    monkeypatch.setattr(ex.time,'time',lambda:1000)
    monkeypatch.setattr(ex,'submit_module_transaction',Mock(side_effect=SynFuturesSubmissionError(reason)))
    rpc=Mock(return_value='0x1')
    with pytest.raises(SynFuturesSubmissionError):ex.dispatch_action(db=db,rpc=rpc,snapshot=snapshot(),campaign=campaign(),token='token',
        action={'kind':'exit','reason':'SYNFUTURES_HARD_STOP'},user_id='user',connection_id='connection')
    ops=[c.kwargs['operation'] for c in db.synfutures_campaign_operation.call_args_list]
    assert ('SYNFUTURES_ACTION_FAIL' in ops)==failed

def test_failed_exit_history_is_retained_and_retry_remains_reduce_only(monkeypatch):
    db=Mock();db.synfutures_campaign_operation.return_value={'intent_id':'new-exit'}
    monkeypatch.setattr(ex,'operator_account',lambda **kw:(Mock(address='operator'),SubmissionLimits(1,1,1)))
    monkeypatch.setattr(ex.time,'time',lambda:1000);submit=Mock(return_value={'status':'submitted'})
    monkeypatch.setattr(ex,'submit_module_transaction',submit);c=campaign();c['actions'].append({'kind':'exit','state':'reverted'})
    ex.dispatch_action(db=db,rpc=Mock(return_value='0x1'),snapshot=snapshot(),campaign=c,token='token',
        action={'kind':'exit','reason':'SYNFUTURES_HARD_STOP'},user_id='user',connection_id='connection')
    row=submit.call_args.kwargs['row'];assert row['reduce_only'] is True and row['margin']=='0' and row['signed_size']==str(-WAD)
    assert len(c['actions'])==2

def test_unresolved_exit_never_retries(monkeypatch):
    monkeypatch.setattr(ex,'operator_account',lambda **kw:(Mock(address='operator'),SubmissionLimits(1,1,1)))
    c=campaign();c['actions'].append({'kind':'exit','state':'unknown'})
    with pytest.raises(SynFuturesEntryError,match='ALREADY_DISPATCHED'):ex.dispatch_action(db=Mock(),rpc=Mock(),snapshot=snapshot(),campaign=c,token='token',action={'kind':'exit','reason':'SYNFUTURES_HARD_STOP'},user_id='user',connection_id='connection')
