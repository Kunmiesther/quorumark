import copy
import pytest
from unittest.mock import Mock
from eth_abi import encode
from eth_utils import keccak
from app.synfutures_owner_receipt import owner_receipt
from app.synfutures_positions import safe_owner_call
from app.synfutures_entry import SynFuturesEntryError
from app import synfutures_reconciliation as r
from signer.tests.test_synfutures_reconciliation import row,fixture
OWNER='0x'+'11'*20;SAFE='0x'+'33'*20;MODULE='0x'+'22'*20

def test_owner_close_requires_exact_atomic_trade_event_and_reviewed_call():
    record=row();rpc,response,final,canonical=fixture(record)
    snapshot={'owner_address':OWNER,'safe_address':SAFE,'module_address':MODULE}
    calldata=response['eth_getTransactionByHash']['input'];hash='0x'+keccak(bytes.fromhex(calldata[2:])).hex()
    result=owner_receipt(snapshot=snapshot,rpc=rpc,symbol='ETH-USDC',phase='close_position',tx_hash=record['tx_hash'],calldata_hash=hash)
    assert result['status']=='confirmed'
    final['number']='0xff'
    assert owner_receipt(snapshot=snapshot,rpc=rpc,symbol='ETH-USDC',phase='close_position',tx_hash=record['tx_hash'],calldata_hash=hash)['status']=='mined'
    response['eth_getTransactionReceipt']['logs']=[]
    with pytest.raises(r.SynFuturesObservationError):owner_receipt(snapshot=snapshot,rpc=rpc,symbol='ETH-USDC',phase='close_position',tx_hash=record['tx_hash'],calldata_hash=hash)

def setup(phase):
    snapshot={'owner_address':OWNER,'safe_address':SAFE,'module_address':MODULE}
    if phase=='enable_module':inner='0x'+(keccak(text='enableModule(address)')[:4]+encode(['address'],[MODULE])).hex();target=SAFE
    else:inner='0x'+(keccak(text='configureSession(address,uint48,uint128,uint16)')[:4]+encode(['address','uint48','uint128','uint16'],[OWNER,1300,1,100])).hex();target=MODULE
    call=safe_owner_call(snapshot,target,inner);block='0x'+'ab'*32;tx_hash='0x'+'cd'*32
    tx={'hash':tx_hash,'from':OWNER,'to':SAFE,'blockHash':block,'blockNumber':'0x100','chainId':'0x2105','value':'0x0','input':call['data']}
    receipt={'transactionHash':tx_hash,'from':OWNER,'to':SAFE,'blockHash':block,'blockNumber':'0x100','status':'0x1'}
    responses={'eth_chainId':'0x2105','eth_getTransactionReceipt':receipt,'eth_getTransactionByHash':tx}
    canonical={'hash':block,'number':'0x100','timestamp':hex(1000)}
    def rpc(method,params):
        if method=='eth_getBlockByNumber':return canonical
        if method=='eth_call':return '0x'+encode(['bool'] if phase=='enable_module' else ['address','uint48','uint128','uint128','uint16'],[True] if phase=='enable_module' else [OWNER,1300,1,0,100]).hex()
        return responses[method]
    return snapshot,tx_hash,'0x'+keccak(bytes.fromhex(call['data'][2:])).hex(),responses,canonical,Mock(side_effect=rpc)

@pytest.mark.parametrize('phase',['enable_module','authorize_owner_exit'])
def test_canonical_safe_effect_and_exact_call_are_required(phase):
    s,h,ch,responses,canonical,rpc=setup(phase)
    assert owner_receipt(snapshot=s,rpc=rpc,symbol='ETH-USDC',phase=phase,tx_hash=h,calldata_hash=ch)['status']=='confirmed'
    with pytest.raises(SynFuturesEntryError):owner_receipt(snapshot=s,rpc=rpc,symbol='ETH-USDC',phase=phase,tx_hash=h,calldata_hash='0x'+'00'*32)
    responses['eth_getTransactionReceipt']['status']='0x0'
    assert owner_receipt(snapshot=s,rpc=rpc,symbol='ETH-USDC',phase=phase,tx_hash=h,calldata_hash=ch)['status']=='reverted'

@pytest.mark.parametrize('field,value',[('from','0x'+'44'*20),('to',MODULE),('value','0x1'),('chainId','0x1'),('blockHash','0x'+'dd'*32)])
def test_foreign_recovery_never_releases_pending_review(field,value):
    s,h,ch,responses,canonical,rpc=setup('enable_module');responses['eth_getTransactionByHash'][field]=value
    with pytest.raises(SynFuturesEntryError):owner_receipt(snapshot=s,rpc=rpc,symbol='ETH-USDC',phase='enable_module',tx_hash=h,calldata_hash=ch)
