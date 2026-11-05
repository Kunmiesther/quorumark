from unittest.mock import Mock
import pytest
from eth_abi import encode, decode
from eth_utils import keccak
from app.synfutures_positions import read_positions, owner_recovery, limit_tick
from app.synfutures_entry import SynFuturesEntryError
from app import synfutures_account as native
from shared.synfutures_math import WAD, price_at_tick
from signer.tests.test_synfutures_account_adapter import rig, NOW, OWNER, SAFE


def positioned(monkeypatch, size=10**16):
    db,rpc,routes=rig(monkeypatch)
    routes[keccak(text='revision()')[:4].hex()]=(['uint256'],[9])
    routes[keccak(text='nextNonce()')[:4].hex()]=(['uint256'],[5])
    routes[keccak(text='getPosition(address,uint32,address)')[:4].hex()]=([native.POSITION],[(100*WAD,size,200*WAD,0,0)])
    routes[keccak(text='inquire(uint32,int256)')[:4].hex()]=([native.QUOTE],[(20_000*WAD,0,0,20_000*WAD,abs(size)*20_000,WAD,0,0,0)])
    return db,rpc,routes


def snapshot(db,rpc):
    return read_positions(db=db,rpc=rpc,user_id='user',connection_id='connection',now=NOW)


def test_monitor_survives_paused_entries_and_expired_operator(monkeypatch):
    db,rpc,routes=positioned(monkeypatch,-10**16)
    db.synfutures_account_context.return_value['live_entry_allowed']=False
    routes[keccak(text='session()')[:4].hex()][1][1]=NOW
    value=snapshot(db,rpc)
    assert value['positions']['BTC-USDC']['signed_size']=='-10000000000000000'
    assert value['operator_exit_available'] is False and value['live_entry_allowed'] is False
    assert value['module_revision']=='9' and value['module_nonce']=='5'
    db.is_execution_halted.assert_not_called()
    assert all(c.args[0]!='eth_sendRawTransaction' for c in rpc.call_args_list)


def test_unreadable_position_is_not_flat(monkeypatch):
    db,rpc,routes=positioned(monkeypatch)
    del routes[keccak(text='getPosition(address,uint32,address)')[:4].hex()]
    with pytest.raises(KeyError):snapshot(db,rpc)


def test_monitor_rejects_changed_owner(monkeypatch):
    db,rpc,routes=positioned(monkeypatch)
    routes[keccak(text='getOwners()')[:4].hex()][1][0]=['0x'+'99'*20]
    with pytest.raises(SynFuturesEntryError,match='OWNER_CHANGED'):snapshot(db,rpc)


def recovery_rpc():return Mock(return_value='0x'+encode(['bool'],[True]).hex())


def test_owner_recovery_replaces_expired_session_with_owner_only(monkeypatch):
    db,rpc,routes=positioned(monkeypatch)
    routes[keccak(text='session()')[:4].hex()][1][1]=NOW
    value=snapshot(db,rpc); simulate=recovery_rpc()
    result=owner_recovery(snapshot=value,rpc=simulate,symbol='BTC-USDC',slippage_bps=50)
    assert result['phase']=='authorize_owner_exit' and result['owner_confirmation_required'] is True
    call=result['call']; assert call['from']==OWNER and call['to']==SAFE and call['value']=='0x0'
    decoded=decode(['address','uint256','bytes','uint8','uint256','uint256','uint256','address','address','bytes'],bytes.fromhex(call['data'][10:]))
    assert decoded[0]==value['module_address'] and decoded[2][:4]==keccak(text='configureSession(address,uint48,uint128,uint16)')[:4]
    assert decoded[3]==0 and decoded[9]==bytes.fromhex(OWNER[2:].rjust(64,'0'))+bytes(32)+b'\x01'
    assert simulate.call_args.args[0]=='eth_call'


@pytest.mark.parametrize('size',[10**16,-10**16])
def test_revoked_owner_recovery_is_exact_zero_margin_reduction(monkeypatch,size):
    db,rpc,routes=positioned(monkeypatch,size)
    routes[keccak(text='session()')[:4].hex()][1][0]=OWNER
    value=snapshot(db,rpc)
    result=owner_recovery(snapshot=value,rpc=Mock(return_value='0x'),symbol='BTC-USDC',slippage_bps=50)
    assert result['phase']=='close_position'
    call=result['call']; assert call['from']==OWNER and call['to']==value['module_address']
    args=decode(['(uint256,uint256,address,int128,uint128,int24,uint32,bool)'],bytes.fromhex(call['data'][10:]))[0]
    assert args[3]==-size and args[4]==0 and args[7] is True and args[6]==NOW+120



def test_recovery_simulation_false_never_returns_call(monkeypatch):
    db,rpc,_=positioned(monkeypatch)
    with pytest.raises(SynFuturesEntryError,match='SIMULATION_UNCONFIRMED'):
        owner_recovery(snapshot=snapshot(db,rpc),rpc=Mock(return_value='0x'+encode(['bool'],[False]).hex()),symbol='BTC-USDC',slippage_bps=50)


def test_tick_bounds_preserve_adverse_limit():
    for mark in [20_000*WAD,3200*WAD]:
        assert price_at_tick(limit_tick(mark,True,50))<=mark*10050//10000
        assert price_at_tick(limit_tick(mark,False,50))>=mark*9950//10000
