import copy
import pytest
from unittest.mock import Mock
from eth_abi import encode
from eth_utils import keccak
from app import synfutures_settlement as st
from app import synfutures_account as native
from app.synfutures_entry import SynFuturesEntryError
from shared.synfutures_math import WAD
SAFE='0x'+'33'*20
INSTRUMENT=native.MARKETS['BTC-USDC']
B0='0x'+'00'*32;B1='0x'+'11'*32;B2='0x'+'22'*32;T1='0x'+'ab'*32;T2='0x'+'cd'*32

def rig():
    def log(name,args,bn,index,tx):
        sig,types=st.EVENTS[name]
        return {'address':INSTRUMENT,'removed':False,'blockNumber':hex(bn),'transactionIndex':'0x0','logIndex':hex(index),
          'transactionHash':tx,'blockHash':B1 if bn==101 else B2,
          'topics':['0x'+keccak(text=sig).hex(),'0x'+format(2**32-1,'064x'),'0x'+SAFE[2:].rjust(64,'0')],
          'data':'0x'+encode(types,args).hex()}
    opening=(25*WAD-1,WAD,100*WAD,0,0);closing=(27*WAD-3,0,0,0,0)
    logs=[log('Trade',[WAD,25*WAD,0,0,100*WAD,1,1,100*WAD],101,0,T1),log('UpdatePosition',[opening],101,1,T1),
          log('Trade',[-WAD,0,0,0,0,1,1,102*WAD],102,0,T2),log('UpdatePosition',[closing],102,1,T2)]
    receipts={T1:{'status':'0x1','blockHash':B1,'logs':logs[:2]},T2:{'status':'0x1','blockHash':B2,'logs':logs[2:]}}
    blocks={100:{'number':'0x64','hash':B0},101:{'number':'0x65','hash':B1},102:{'number':'0x66','hash':B2}}
    def rpc(method,params):
        if method=='eth_getBlockByNumber':return blocks[102 if params[0]=='finalized' else int(params[0],16)]
        if method=='eth_getLogs':return logs
        if method=='eth_getTransactionReceipt':return receipts[params[0]]
        if method=='eth_call':return '0x'+encode([native.POSITION],[(0,0,0,0,0) if params[1]['blockHash']==B0 else closing]).hex()
        raise AssertionError(method)
    c={'symbol':'BTC-USDC','plan':{'start_block':'100','starting_balance':'0'},'actions':[{'kind':'entry','state':'confirmed','tx_hash':T1}]}
    s={'safe_address':SAFE,'positions':{'BTC-USDC':{'signed_size':'0','mark':str(102*WAD)}}}
    return c,s,logs,receipts,blocks,Mock(side_effect=rpc)

def test_actual_balance_includes_fees_funding_and_social_loss():
    c,s,logs,receipts,blocks,rpc=rig();proof=st.settlement(campaign=c,snapshot=s,rpc=rpc)
    assert proof['realized_pnl']==str(2*WAD-3) and proof['entry_price']==str(100*WAD)
    assert proof['maximum_size']==str(WAD) and proof['closing_tx_hash']==T2

@pytest.mark.parametrize('mutation',['removed','reorg','missing_entry','unexpected_event','duplicate','omitted_receipt_event','unknown_finality','not_flat','wrong_baseline'])
def test_unknown_proof_is_never_zero_profit(mutation):
    c,s,logs,receipts,blocks,rpc=rig()
    if mutation=='removed':logs[0]['removed']=True
    elif mutation=='reorg':blocks[101]['hash']=B0
    elif mutation=='missing_entry':c['actions'][0]['tx_hash']=B0
    elif mutation=='unexpected_event':logs[0]['topics'][0]=B0
    elif mutation=='duplicate':logs.append(copy.deepcopy(logs[0]))
    elif mutation=='omitted_receipt_event':receipts[T1]['logs'].append({**logs[0],'logIndex':'0x4'})
    elif mutation=='unknown_finality':blocks[102]['number']='0x63'
    elif mutation=='not_flat':s['positions']['BTC-USDC']['signed_size']='1'
    elif mutation=='wrong_baseline':c['plan']['starting_balance']='1'
    with pytest.raises(SynFuturesEntryError):st.settlement(campaign=c,snapshot=s,rpc=rpc)
