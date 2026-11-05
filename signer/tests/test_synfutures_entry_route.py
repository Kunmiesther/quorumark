"""Private routing must not inherit ApeX exemptions or caller authority flags."""
import hashlib
import hmac
import json
import time
import uuid
from unittest.mock import Mock
from fastapi.testclient import TestClient
from app import main, synfutures_account


def body(**patch):
    return {"user_id":"00000000-0000-4000-8000-000000000001",
            "exchange_connection_id":"00000000-0000-4000-8000-000000000002",
            "client_order_id":"native-campaign", "venue":"synfutures", "symbol":"BTC-USDC",
            "side":"BUY", "order_type":"MARKET", "leverage":33,"margin_usdc":"100",
            "purpose":"AUTOMATED_ENTRY",**patch}


def post(client, data):
    raw=json.dumps(data,separators=(",",":")).encode(); ts=str(int(time.time())); nonce=uuid.uuid4().hex
    signed=b"\n".join([ts.encode(),nonce.encode(),b"/v1/orders",raw])
    sig=hmac.new(b"test-only-synfutures-secret",signed,hashlib.sha256).hexdigest()
    return client.post("/v1/orders",content=raw,headers={"content-type":"application/json",
        "x-signer-timestamp":ts,"x-signer-nonce":nonce,"x-signer-signature":sig})


def test_hmac_is_required_before_any_account_read(monkeypatch):
    db=Mock(); monkeypatch.setattr(main,"_DB",db)
    r=TestClient(main.app).post("/v1/orders",json=body())
    assert r.status_code==401; db.synfutures_account_context.assert_not_called()


def test_native_request_uses_owned_context_not_apex_credentials(monkeypatch):
    monkeypatch.setenv("SIGNER_SHARED_SECRET","test-only-synfutures-secret")
    monkeypatch.setenv("APEX_MAINNET_SIGNER_ENABLED","false")
    monkeypatch.setenv("APEX_MAINNET_CANARY_ENABLED","false")
    db=Mock(); db.synfutures_account_context.return_value={"chain_id":8453,"live_entry_allowed":False}
    monkeypatch.setattr(main,"_DB",db)
    rpc=Mock(); monkeypatch.setattr(synfutures_account,"BaseAccountRpc",lambda:rpc)
    r=post(TestClient(main.app),body())
    assert r.status_code==200 and r.json()["reject_reason"]=="SYNFUTURES_LIVE_PERMISSION_REQUIRED"
    db.find_active_credential_for_connection.assert_not_called()
    db.insert_order_intent.assert_not_called(); rpc.assert_not_called()


def test_cex_fields_and_coerced_leverage_cannot_enter_native_route(monkeypatch):
    monkeypatch.setenv("SIGNER_SHARED_SECRET","test-only-synfutures-secret")
    db=Mock(); monkeypatch.setattr(main,"_DB",db)
    client=TestClient(main.app)
    for patch in ({"leverage":True},{"leverage":33.0},{"size":0.1},{"price":123},
                  {"campaign_rung_count":5},{"purpose":"proof_of_life"},{"reduce_only":True},
                  {"verified_account":True},{"protective_exit_ready":True},{"safe_address":"0x123"}):
        r=post(client,body(**patch)); assert r.status_code==400
    db.synfutures_account_context.assert_not_called()
