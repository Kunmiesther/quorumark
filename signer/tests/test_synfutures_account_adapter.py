from unittest.mock import Mock
import pytest
from eth_abi import decode, encode
from eth_utils import keccak
from app import synfutures_account as adapter
from app.synfutures_entry import SynFuturesEntryError
from shared.synfutures_math import WAD

SAFE="0x"+"11"*20; MODULE="0x"+"22"*20; OWNER="0x"+"33"*20; OPERATOR="0x"+"44"*20
HASH="0x"+"ab"*32; NOW=1800000000


def rig(monkeypatch):
    code="0x6000"; codehash="0x"+keccak(bytes.fromhex(code[2:])).hex()
    monkeypatch.setattr(adapter,"SINGLETON_HASH",codehash)
    db=Mock()
    db.synfutures_account_context.return_value=dict(chain_id=8453,safe_address=SAFE,module_address=MODULE,
        owner_address=OWNER,safe_proxy_code_hash=codehash,module_code_hash=codehash,live_entry_allowed=True)
    db.is_execution_halted.return_value=False; db.list_synfutures_transactions.return_value=[]
    routes={}
    def route(signature,outputs,result):
        routes[keccak(text=signature)[:4].hex()]=(outputs,result)
    route("getOwners()",["address[]"],[[OWNER]])
    route("getThreshold()",["uint256"],[1])
    route("safe()",["address"],[SAFE])
    route("isModuleEnabled(address)",["bool"],[True])
    route("session()",["address","uint48","uint128","uint128","uint16"],[OPERATOR,NOW+3600,100*WAD,0,50])
    route("marketLimits(address)",["uint128","uint128","uint128","uint16"],[2*WAD,4000*WAD,100*WAD,33])
    route("getSetting(address)",[adapter.SETTING],[("BTC-USDC",adapter.CONFIG,adapter.GATE,"0x"+"55"*20,
        adapter.USDC,6,300,150,(10*WAD,10,10,0,0,0))])
    route("config()",["address"],[adapter.CONFIG])
    route("reserveOf(address,address)",["uint256"],[100*10**6])
    route("getPosition(address,uint32,address)",[adapter.POSITION],[(0,0,0,0,0)])
    def rpc(method,params):
        if method=="eth_chainId": return "0x2105"
        if method=="eth_getBlockByNumber": return {"number":"0x7b","hash":HASH,"timestamp":hex(NOW)}
        if method=="eth_getCode": return code
        if method=="eth_getStorageAt": return "0x"+"00"*12+adapter.SINGLETON[2:]
        if method=="eth_call":
            assert params[1]=={"blockHash":HASH,"requireCanonical":True}
            data=params[0]["data"]
            if data[2:10]==keccak(text="inquireByNotional(address,uint32,uint256,bool)")[:4].hex():
                _,_,notional,long=decode(["address","uint32","uint256","bool"],bytes.fromhex(data[10:]))
                size=notional*WAD//(3200*WAD)*(1 if long else -1)
                return "0x"+encode(["int256",adapter.QUOTE],[size,(3200*WAD,0,0,3200*WAD,notional,WAD,98*WAD,0,0)]).hex()
            outputs,result=routes[data[2:10]]
            return "0x"+encode(outputs,result).hex()
        raise AssertionError("Unexpected RPC mutation: "+method)
    return db,Mock(side_effect=rpc),routes


def request():
    return dict(user_id="user",connection_id="connection",symbol="BTC-USDC",margin_usdc="100",leverage=33,long=True,now=NOW)


def test_fee_adjusted_quote_and_block_pinned_owner_adapter(monkeypatch):
    db,rpc,_=rig(monkeypatch)
    plan=adapter.preflight_entry(db=db,rpc=rpc,**request())
    assert plan["entry_notional"]==str(3267*WAD)
    assert plan["margin"]==str(100*WAD)
    assert plan["observed_block"]=="123"
    db.insert_order_intent.assert_not_called()


def test_working_preflight_still_requires_protection(monkeypatch):
    db,rpc,_=rig(monkeypatch)
    result=adapter.evaluate_entry_request(db=db,rpc=rpc,**request())
    assert result["status"]=="rejected" and result["reject_reason"]=="SYNFUTURES_PROTECTIVE_EXIT_REQUIRED"
    db.insert_order_intent.assert_not_called(); db.reserve_synfutures_transaction.assert_not_called()


def test_saved_read_only_connection_is_not_execution_authority(monkeypatch):
    db,rpc,_=rig(monkeypatch); db.synfutures_account_context.return_value["live_entry_allowed"]=False
    with pytest.raises(SynFuturesEntryError,match="LIVE_PERMISSION_REQUIRED"):
        adapter.preflight_entry(db=db,rpc=rpc,**request())
    rpc.assert_not_called()


def test_session_and_uncertain_journal_prevent_new_entry(monkeypatch):
    db,rpc,routes=rig(monkeypatch)
    db.list_synfutures_transactions.return_value=[{"state":"unknown"}]
    with pytest.raises(SynFuturesEntryError,match="IN_FLIGHT"): adapter.preflight_entry(db=db,rpc=rpc,**request())
    db,rpc,routes=rig(monkeypatch)
    routes[keccak(text="session()")[:4].hex()][1][1]=NOW
    with pytest.raises(SynFuturesEntryError,match="SESSION_REQUIRED"): adapter.preflight_entry(db=db,rpc=rpc,**request())
