"""Read-only canonical proof for an explicitly owner-signed recovery step."""
from eth_abi import decode, encode
from eth_utils import keccak
from .synfutures_positions import contract_call, ZERO
from .synfutures_entry import require
from .synfutures_reconciliation import quantity, HASH, observe_transaction
from . import synfutures_account as native

SAFE_SIG='execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'
SAFE_TYPES=['address','uint256','bytes','uint8','uint256','uint256','uint256','address','address','bytes']
def unpack(data, signature, types):
    require(isinstance(data,str) and data[:10].lower()=='0x'+keccak(text=signature)[:4].hex(),'SYNFUTURES_RECOVERY_RECEIPT_UNCONFIRMED')
    raw=bytes.fromhex(data[10:]);args=decode(types,raw)
    require(encode(types,args)==raw,'SYNFUTURES_RECOVERY_RECEIPT_UNCONFIRMED')
    return args

def owner_receipt(*,snapshot,rpc,symbol,phase,tx_hash,calldata_hash):
    code='SYNFUTURES_RECOVERY_RECEIPT_UNCONFIRMED'
    require(symbol in native.MARKETS and phase in ('enable_module','authorize_owner_exit','close_position') and HASH.fullmatch(tx_hash),code)
    require(quantity(rpc('eth_chainId',[]))==8453,code)
    receipt=rpc('eth_getTransactionReceipt',[tx_hash])
    if receipt is None:return {'status':'unknown','phase':phase,'reconciliation_required':True}
    tx=rpc('eth_getTransactionByHash',[tx_hash]);require(isinstance(tx,dict) and isinstance(receipt,dict),code)
    require(HASH.fullmatch(calldata_hash) and '0x'+keccak(bytes.fromhex(tx.get('input','')[2:])).hex()==calldata_hash,code)
    block=quantity(receipt.get('blockNumber'));canonical=rpc('eth_getBlockByNumber',[hex(block),False])
    require(canonical['hash'].lower()==receipt.get('blockHash','').lower() and tx.get('blockHash','').lower()==canonical['hash'].lower()
        and quantity(canonical['number'])==block and quantity(tx['blockNumber'])==block and tx.get('hash','').lower()==tx_hash.lower()
        and receipt.get('transactionHash','').lower()==tx_hash.lower() and quantity(tx['chainId'])==8453 and quantity(tx['value'])==0
        and tx.get('from','').lower()==snapshot['owner_address'] and receipt.get('from','').lower()==snapshot['owner_address'],code)
    target=snapshot['module_address'] if phase=='close_position' else snapshot['safe_address']
    require(tx.get('to','').lower()==target and receipt.get('to','').lower()==target,code)
    if phase=='close_position':
        args=unpack(tx['input'],'executeTrade((uint256,uint256,address,int128,uint128,int24,uint32,bool))',
            ['(uint256,uint256,address,int128,uint128,int24,uint32,bool)'])[0]
        rev,nonce,instrument,size,margin,tick,deadline,reduce=args
        require(instrument.lower()==native.MARKETS[symbol] and margin==0 and reduce and size!=0,code)
        row={'chain_id':8453,'operator_address':snapshot['owner_address'],'module_address':snapshot['module_address'],
            'safe_address':snapshot['safe_address'],'instrument_address':instrument.lower(),'operator_nonce':str(quantity(tx['nonce'])),
            'module_revision':str(rev),'module_nonce':str(nonce),'signed_size':str(size),'margin':'0','reduce_only':True,'tx_hash':tx_hash}
        proof=observe_transaction(row,rpc,include_provisional=True)
        return {'status':proof['state'],'phase':phase,'reconciliation_required':proof['state'] not in ('mined','confirmed','reverted')}
    to,value,data,operation,sg,bg,gp,token,refund,signatures=unpack(tx['input'],SAFE_SIG,SAFE_TYPES)
    signature=bytes.fromhex(snapshot['owner_address'][2:].rjust(64,'0'))+bytes(32)+b'\x01'
    require(value==0 and operation==0 and sg==bg==gp==0 and token==refund==ZERO and signatures==signature,code)
    at={'blockHash':canonical['hash'],'requireCanonical':True}
    if phase=='enable_module':
        args=unpack('0x'+data.hex(),'enableModule(address)',['address'])
        require(to==snapshot['safe_address'] and args[0]==snapshot['module_address'],code)
    else:
        owner,until,budget,bps=unpack('0x'+data.hex(),'configureSession(address,uint48,uint128,uint16)',
            ['address','uint48','uint128','uint16'])
        # Recovery sessions can be delayed in the mempool; reject a session
        # extending more than five minutes past the block that executed it.
        require(to==snapshot['module_address'] and owner==snapshot['owner_address'] and budget==1 and 1<=bps<=1000
            and quantity(canonical['timestamp'])<until<=quantity(canonical['timestamp'])+300,code)
    finalized=rpc('eth_getBlockByNumber',['finalized',False]);is_final=quantity(finalized['number'])>=block
    if quantity(receipt['status'])==0:return {'status':'reverted' if is_final else 'unknown','phase':phase,'reconciliation_required':not is_final}
    require(quantity(receipt['status'])==1,code)
    if phase=='enable_module':
        require(contract_call(rpc,at,snapshot['safe_address'],'isModuleEnabled(address)',['address'],[snapshot['module_address']],['bool'])[0] is True,code)
    else:
        session=contract_call(rpc,at,snapshot['module_address'],'session()',outputs=['address','uint48','uint128','uint128','uint16'])
        require(session==(owner,until,budget,0,bps),code)
    return {'status':'confirmed' if is_final else 'mined','phase':phase,'reconciliation_required':False}
