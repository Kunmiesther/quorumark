from __future__ import annotations

from eth_account import Account
from eth_account.messages import encode_typed_data
import json
import pytest

from app import aster_v3


PRIVATE_KEY = "0x" + "11" * 32
SIGNER = Account.from_key(PRIVATE_KEY).address
USER = "0x" + "22" * 20


def credentials() -> aster_v3.AsterCredentials:
    return aster_v3.AsterCredentials(user=USER, signer=SIGNER, private_key=PRIVATE_KEY)


def test_signed_fields_are_recoverable_and_bind_all_parameters():
    fields = aster_v3.signed_fields(
        credentials(),
        [("symbol", "BTCUSDT"), ("side", "BUY")],
        nonce=1_777_000_000_000_000,
    )
    assert [key for key, _ in fields] == [
        "symbol", "side", "nonce", "user", "signer", "signature",
    ]
    unsigned = fields[:-1]
    signature = dict(fields)["signature"]
    message = aster_v3.urlencode(unsigned)
    recovered = Account.recover_message(
        encode_typed_data(full_message=aster_v3._typed_message(message)),
        signature=signature,
    )
    assert recovered.lower() == SIGNER.lower()


def test_agent_private_key_must_match_agent_address():
    wrong = aster_v3.AsterCredentials(
        user=USER,
        signer="0x" + "33" * 20,
        private_key=PRIVATE_KEY,
    )
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_AGENT_KEY_MISMATCH"):
        wrong.validated()


def test_get_uses_query_and_never_sends_private_key(monkeypatch):
    captured = {}

    class Response:
        ok = True
        status_code = 200

        @staticmethod
        def json():
            return {"totalWalletBalance": "10", "availableBalance": "8", "canTrade": True}

    def fake_request(method, url, **kwargs):
        captured.update({"method": method, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr(aster_v3.requests, "request", fake_request)
    summary = aster_v3.account_summary(credentials())
    assert summary["totalEquity"] == 10
    assert summary["walletBalance"] == 10
    assert summary["availableBalance"] == 8
    assert summary["permissions"]["trade"] is True
    assert captured["data"] is None
    assert captured["url"].endswith("/fapi/v3/accountWithJoinMargin")
    query = dict(captured["params"])
    assert query["user"] == USER
    assert query["signer"] == SIGNER
    assert PRIVATE_KEY not in str(captured)


def test_post_timeout_is_ambiguous(monkeypatch):
    def timeout(*_args, **_kwargs):
        raise aster_v3.requests.Timeout()

    monkeypatch.setattr(aster_v3.requests, "request", timeout)
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.place_order(
            credentials(),
            symbol="BTCUSDT",
            side="BUY",
            order_type="MARKET",
            quantity="0.001",
            client_order_id="tb-test-0001",
        )
    assert error.value.code == "ASTER_EXECUTION_UNKNOWN"
    assert error.value.ambiguous is True


def test_http_503_is_ambiguous(monkeypatch):
    class Response:
        ok = False
        status_code = 503

    monkeypatch.setattr(aster_v3.requests, "request", lambda *_a, **_k: Response())
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.cancel_all(credentials(), symbol="BTCUSDT")
    assert error.value.code == "ASTER_EXECUTION_UNKNOWN"
    assert error.value.ambiguous is True


def test_any_mutating_server_error_is_ambiguous(monkeypatch):
    class Response:
        ok = False
        status_code = 500

    monkeypatch.setattr(aster_v3.requests, "request", lambda *_a, **_k: Response())
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.place_order(
            credentials(), symbol="BTCUSDT", side="BUY", order_type="MARKET",
            quantity="0.001", client_order_id="tb-test-500",
        )
    assert error.value.code == "ASTER_EXECUTION_UNKNOWN"
    assert error.value.ambiguous is True


@pytest.mark.parametrize("status,ok", [(403, False), (200, True)])
def test_deposit_prerequisite_is_explicit(monkeypatch, status, ok):
    class Response:
        status_code = status

        @staticmethod
        def json():
            return {"code": -5050, "msg": "This function can only be used after deposit"}

    Response.ok = ok
    monkeypatch.setattr(aster_v3.requests, "request", lambda *_a, **_k: Response())
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.read_account(credentials())
    assert error.value.code == "ASTER_MAIN_WALLET_DEPOSIT_REQUIRED"
    assert error.value.ambiguous is False


def test_strategy_lookup_uses_current_documented_paths(monkeypatch):
    paths = []

    def fake_request(_method, path, _credentials, _params):
        paths.append(path)
        return {"clientStrategyId": "tb-123"}

    monkeypatch.setattr(aster_v3, "request", fake_request)
    aster_v3.read_strategy_order(credentials(), "tb-123")
    aster_v3.read_strategy_order(credentials(), "tb-123", history=True)
    assert paths == ["/fapi/v3/strategyOpenOrder", "/fapi/v3/strategyHistoryOrder"]


@pytest.mark.parametrize("leverage", [21, 125])
def test_leverage_must_be_confirmed_by_venue_before_order_submission(monkeypatch, leverage):
    captured = {}

    def fake_request(method, path, _creds, params):
        captured.update({"method": method, "path": path, "params": dict(params)})
        return {"symbol": "BTCUSDT", "leverage": leverage}

    monkeypatch.setattr(aster_v3, "request", fake_request)
    assert aster_v3.set_leverage(credentials(), "BTCUSDT", leverage)["leverage"] == leverage
    assert captured == {
        "method": "POST", "path": "/fapi/v3/leverage",
        "params": {"symbol": "BTCUSDT", "leverage": leverage},
    }
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_LEVERAGE_UNCONFIRMED"):
        aster_v3.set_leverage(credentials(), "BTCUSDT", 20)


@pytest.mark.parametrize("leverage", [0, 126, 135, 200, True, 125.5])
def test_invalid_leverage_never_reaches_transport(monkeypatch, leverage):
    def unexpected_request(*_args, **_kwargs):
        pytest.fail("invalid leverage reached the venue")
    monkeypatch.setattr(aster_v3, "request", unexpected_request)
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_INVALID_LEVERAGE"):
        aster_v3.set_leverage(credentials(), "BTCUSDT", leverage)


@pytest.mark.parametrize("reader,body,code", [
    ("read_positions", [{"symbol": "BTCUSDT", "positionAmt": "0"}, None],
     "ASTER_INVALID_POSITIONS_RESPONSE"),
    ("read_open_orders", [{"symbol": "BTCUSDT", "orderId": 1}, None],
     "ASTER_INVALID_OPEN_ORDERS_RESPONSE"),
])
def test_preflight_reads_never_silently_drop_malformed_venue_rows(monkeypatch, reader, body, code):
    monkeypatch.setattr(aster_v3, "request", lambda *_a, **_k: body)
    with pytest.raises(aster_v3.AsterV3Error, match=code):
        getattr(aster_v3, reader)(credentials(), "BTCUSDT")


def test_symbol_rules_require_live_venue_filters(monkeypatch):
    monkeypatch.setattr(aster_v3, "public_request", lambda *_a, **_k: {
        "symbols": [{
            "symbol": "BTCUSDT", "status": "TRADING",
            "filters": [
                {"filterType": "PRICE_FILTER", "tickSize": "0.1"},
                {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "1000"},
                {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "120"},
                {"filterType": "MIN_NOTIONAL", "notional": "5"},
            ],
        }],
    })
    rules = aster_v3.symbol_rules("BTCUSDT")
    assert rules["step_size"] == "0.001"
    assert rules["tick_size"] == "0.1"
    assert rules["min_notional"] == "5"
    with pytest.raises(aster_v3.AsterV3Error, match="ASTER_SYMBOL_NOT_FOUND"):
        aster_v3.symbol_rules("FAKEUSDT")


def test_oto_submits_linked_entry_and_rung_scoped_reduce_only_stop(monkeypatch):
    captured = {}

    def fake_request(method, path, _creds, params):
        captured.update({"method": method, "path": path, "params": dict(params)})
        return {"strategyId": 987, "strategyStatus": "WORKING", "failureCode": 0}

    monkeypatch.setattr(aster_v3, "request", fake_request)
    result = aster_v3.place_oto_entry_with_stop(
        credentials(), symbol="BTCUSDT", side="BUY", quantity="0.001",
        entry_price="75000.0", stop_price="74000.0", client_strategy_id="tb-rung-1",
    )
    assert result["strategyId"] == 987
    assert captured["method"] == "POST"
    assert captured["path"] == "/fapi/v3/placeStrategyOrder"
    assert captured["params"]["strategyType"] == "OTO"
    orders = json.loads(captured["params"]["subOrderList"])
    assert len(orders) == 2
    assert orders[0]["type"] == "LIMIT"
    assert orders[1]["type"] == "STOP_MARKET"
    assert orders[1]["closePosition"] == "false"
    assert orders[1]["quantity"] == "0.001"
    assert orders[1]["reduceOnly"] == "true"
    assert orders[1]["firstDrivenId"] == "1"
    assert orders[1]["firstDrivenOn"] == "PARTIALLY_FILLED_OR_FILLED"


def test_oto_ambiguous_response_must_not_be_retried(monkeypatch):
    monkeypatch.setattr(aster_v3, "request", lambda *_a, **_k: {})
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.place_oto_entry_with_stop(
            credentials(), symbol="BTCUSDT", side="SELL", quantity="0.001",
            entry_price="75000.0", stop_price="76000.0", client_strategy_id="tb-rung-2",
        )
    assert error.value.ambiguous is True


def test_targeted_cancel_never_uses_cancel_all(monkeypatch):
    captured = {}

    def fake_request(method, path, _creds, params):
        captured.update(method=method, path=path, params=dict(params))
        return {"symbol": "BTCUSDT", "clientOrderId": "tb-one-entry", "status": "CANCELED"}

    monkeypatch.setattr(aster_v3, "request", fake_request)
    result = aster_v3.cancel_order(credentials(), symbol="BTCUSDT", client_order_id="tb-one-entry")
    assert result["status"] == "CANCELED"
    assert captured == {
        "method": "DELETE", "path": "/fapi/v3/order",
        "params": {"symbol": "BTCUSDT", "origClientOrderId": "tb-one-entry"},
    }


def test_targeted_cancel_requires_confirmed_identity(monkeypatch):
    monkeypatch.setattr(aster_v3, "request", lambda *_a, **_k: {
        "symbol": "BTCUSDT", "clientOrderId": "another-order", "status": "CANCELED",
    })
    with pytest.raises(aster_v3.AsterV3Error) as error:
        aster_v3.cancel_order(credentials(), symbol="BTCUSDT", client_order_id="tb-one-entry")
    assert error.value.code == "ASTER_CANCEL_UNCONFIRMED"
    assert error.value.ambiguous is True
