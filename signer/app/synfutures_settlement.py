"""Finalized native cash-delta accounting. Unknown evidence never becomes $0 PNL.

Instrument Trade.amount and Adjust.net are external margin movements. Native
position balance already includes execution fees, funding and social losses.
Subtract external movements from the verified flat-position balance change.
"""
from eth_abi import decode,encode
from eth_utils import keccak
from .synfutures_entry import require
from .synfutures_positions import contract_call
from .synfutures_reconciliation import HASH,quantity
from . import synfutures_account as native
from shared.synfutures_math import WAD

EVENTS={
 'Trade':('Trade(uint32,address,int256,uint256,int256,uint256,uint256,uint16,uint160,uint256)',
          ['int256','uint256','int256','uint256','uint256','uint16','uint160','uint256']),
 'Adjust':('Adjust(uint32,address,int256)',['int256']),
 'UpdatePosition':('UpdatePosition(uint32,address,(int256,int256,uint256,uint256,int256))',[native.POSITION])}
TOPICS={'0x'+keccak(text=sig).hex():(name,types) for name,(sig,types) in EVENTS.items()}
CODE='SYNFUTURES_REALIZED_PNL_UNCONFIRMED'

def settlement(*,campaign,snapshot,rpc):
    plan=campaign['plan'];instrument=native.MARKETS[campaign['symbol']];safe=snapshot['safe_address']
    require(int(snapshot['positions'][campaign['symbol']]['signed_size'])==0,CODE)
    start=int(plan['start_block']);finalized=rpc('eth_getBlockByNumber',['finalized',False]);end=quantity(finalized['number'])
    require(end>=start and end-start<=200_000 and HASH.fullmatch(finalized['hash']),CODE)
    topic_safe='0x'+safe[2:].rjust(64,'0');topic_expiry='0x'+format(2**32-1,'064x')
    logs=[]
    # Query ALL events scoped to this native position. LP/liquidation/fill/etc.
    # require separate accounting and must fail closed rather than disappear.
    for left in range(start+1,end+1,2000):
        page=rpc('eth_getLogs',[{'address':instrument,'fromBlock':hex(left),'toBlock':hex(min(end,left+1999)),
                              'topics':[None,topic_expiry,topic_safe]}])
        require(isinstance(page,list) and len(page)<10_000 and len(logs)+len(page)<=10000,CODE);logs+=page
    logs.sort(key=lambda l:(quantity(l['blockNumber']),quantity(l['transactionIndex']),quantity(l['logIndex'])))
    require(logs,CODE)
    seen=set();cash=0;last=None;last_open=None;maximum_size=0;trade_hashes=set();by_tx={};blocks={}
    for log in logs:
        require(isinstance(log,dict) and log.get('removed') is False and log['address'].lower()==instrument
            and len(log['topics'])==3 and log['topics'][1].lower()==topic_expiry and log['topics'][2].lower()==topic_safe
            and log['topics'][0].lower() in TOPICS and HASH.fullmatch(log['transactionHash']) and HASH.fullmatch(log['blockHash']),CODE)
        bn=quantity(log['blockNumber']);index=quantity(log['logIndex']);ident=(log['transactionHash'].lower(),index)
        require(start<bn<=end and ident not in seen,CODE);seen.add(ident)
        if bn not in blocks:blocks[bn]=rpc('eth_getBlockByNumber',[hex(bn),False])
        require(blocks[bn]['hash'].lower()==log['blockHash'].lower(),CODE)
        name,types=TOPICS[log['topics'][0].lower()];raw=bytes.fromhex(log['data'][2:]);args=decode(types,raw)
        require(encode(types,args)==raw,CODE)
        by_tx.setdefault(log['transactionHash'].lower(),[]).append((name,args,log))
        if name=='Trade':cash+=args[1];trade_hashes.add(log['transactionHash'].lower())
        elif name=='Adjust':cash+=args[0]
        else:
            last=(args[0],log)
            if args[0][1]:
                last_open=args[0];maximum_size=max(maximum_size,abs(args[0][1]))
    require(last_open and last and last[0][1]==0 and last[0][2]==0,CODE)
    for tx_hash,events in by_tx.items():
        receipt=rpc('eth_getTransactionReceipt',[tx_hash]);require(receipt and quantity(receipt['status'])==1,CODE)
        expected={quantity(l['logIndex']):l for l in receipt['logs'] if l['address'].lower()==instrument
                  and len(l.get('topics',[]))==3 and l['topics'][1].lower()==topic_expiry and l['topics'][2].lower()==topic_safe}
        require(set(expected)=={quantity(l['logIndex']) for _,_,l in events},CODE)
        for _,_,l in events:
            r=expected[quantity(l['logIndex'])];require(r['data'].lower()==l['data'].lower() and r['topics']==l['topics']
                and r['blockHash'].lower()==l['blockHash'].lower() and receipt['blockHash'].lower()==l['blockHash'].lower(),CODE)
        require(sum(name=='UpdatePosition' for name,_,_ in events)>=1 and any(name in ('Trade','Adjust') for name,_,_ in events),CODE)
    confirmed=[a for a in campaign['actions'] if a['kind']=='entry' and a['state']=='confirmed']
    require(confirmed and all(a['tx_hash'].lower() in trade_hashes for a in confirmed),CODE)
    at={'blockHash':finalized['hash'],'requireCanonical':True}
    final=contract_call(rpc,at,native.OBSERVER,'getPosition(address,uint32,address)',
        ['address','uint32','address'],[instrument,2**32-1,safe],[native.POSITION])[0]
    require(final==last[0],CODE)
    baseline_block=rpc('eth_getBlockByNumber',[hex(start),False])
    baseline=contract_call(rpc,{'blockHash':baseline_block['hash'],'requireCanonical':True},native.OBSERVER,
        'getPosition(address,uint32,address)',['address','uint32','address'],[instrument,2**32-1,safe],[native.POSITION])[0]
    require(baseline[1]==0 and baseline[0]==int(plan['starting_balance']),CODE)
    require(rpc('eth_getBlockByNumber',[hex(end),False])['hash']==finalized['hash'],CODE)
    return {'entry_price':str(last_open[2]*WAD//abs(last_open[1])),'maximum_size':str(maximum_size),
            'mark':snapshot['positions'][campaign['symbol']]['mark'],'realized_pnl':str(final[0]-baseline[0]-cash),'receipt_block':str(quantity(last[1]['blockNumber'])),
            'receipt_block_hash':last[1]['blockHash'].lower(),'closing_tx_hash':last[1]['transactionHash'].lower()}
