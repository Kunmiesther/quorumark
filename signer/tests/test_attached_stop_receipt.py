"""Regression fixtures for the documented ApeX v3 attached-stop response.

No credentials, network or venue writes. A returned attachment receipt and a
child order ID are distinct; missing/mismatched receipts remain fail-closed.
"""
from copy import deepcopy
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from app.apex_sdk_order import SdkOrderClient, _matches_attached_stop
from app.security import sanitize_response


REQUEST = {
    "symbol": "BTC-USDT", "side": "BUY", "size": "0.10",
    "slSide": "SELL", "slSize": "0.10", "slPrice": "57000",
    "slTriggerPrice": "58000", "slClientId": "accepted-sl-client",
    "triggerPriceType": "INDEX",
}
RECEIPT = {
    "id": "entry-1", "symbol": "BTC-USDT", "side": "BUY", "size": "0.1",
    "status": "PENDING", "triggerPriceType": "INDEX",
    "isOpenTpslOrder": True, "isSetOpenSl": True,
    "openSlParam": {
        "side": "SELL", "size": "0.1", "price": "57000.0",
        "triggerPrice": "58000.0", "clientOrderId": "accepted-sl-client",
    },
}


def test_documented_server_receipt_confirms_attachment_without_inventing_child_id():
    assert _matches_attached_stop(RECEIPT, REQUEST) is True
    assert "slOrderId" not in RECEIPT


@pytest.mark.parametrize(("field", "value"), [
    ("isOpenTpslOrder", False), ("isSetOpenSl", "false"),
    ("symbol", "ETH-USDT"), ("side", "SELL"), ("size", "0.2"),
    ("status", "CANCELED"), ("triggerPriceType", "MARK_PRICE"),
    ("openSlParam", None),
])
def test_entry_receipt_mismatches_do_not_confirm_protection(field, value):
    response = deepcopy(RECEIPT)
    response[field] = value
    assert _matches_attached_stop(response, REQUEST) is False


@pytest.mark.parametrize(("field", "value"), [
    ("side", "BUY"), ("size", "0.05"), ("price", "57001"),
    ("triggerPrice", "58001"), ("clientOrderId", "wrong-client"),
    ("triggerPrice", None), ("triggerPrice", "NaN"), ("size", "Infinity"),
])
def test_stop_receipt_mismatches_do_not_confirm_protection(field, value):
    response = deepcopy(RECEIPT)
    response["openSlParam"][field] = value
    assert _matches_attached_stop(response, REQUEST) is False


def test_missing_flags_are_not_inferred_from_the_outgoing_request():
    response = deepcopy(RECEIPT)
    response.pop("isSetOpenSl")
    assert _matches_attached_stop(response, REQUEST) is False


def test_sdk_returns_a_distinct_verified_attachment_receipt():
    client = SdkOrderClient.__new__(SdkOrderClient)
    client._client = MagicMock()
    client._account_fee_rates = MagicMock(return_value=("0.0005", "0.0002"))
    def venue_response(**kwargs):
        response = deepcopy(RECEIPT)
        response["openSlParam"]["clientOrderId"] = kwargs["slClientId"]
        return {"code": 0, "data": response}
    client._client.create_order_v3.side_effect = venue_response
    result = client.create_order({
        "symbol": "BTC-USDT", "side": "BUY", "type": "LIMIT",
        "size": "0.1", "price": "60000", "clientId": "entry-client",
        "attached_sl": {
            "side": "SELL", "size": "0.1", "price": "57000",
            "trigger_price": "58000", "client_id": "stop-client",
            "trigger_price_type": "INDEX",
        },
    })
    assert result["sl_attachment_confirmed"] is True
    assert result["sl_venue_order_id"] is None
    assert result["venue_order_id"] == "entry-1"


def test_attachment_status_survives_response_sanitization_without_secrets():
    assert sanitize_response({
        "status": "submitted", "stop_attachment_confirmed": True,
        "private_key": "must-drop",
    }) == {"status": "submitted", "stop_attachment_confirmed": True}
