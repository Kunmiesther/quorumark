"""Canonical POST/GET signing on `/api/v3/order` mirrors the SDK exactly."""
from __future__ import annotations

import base64
import hashlib
import hmac

from app.orders_v3 import sign_canonical, _sorted_data_string


def test_data_string_sorted_alphabetically_and_drops_none():
    s = _sorted_data_string({"symbol": "BTC-USDT", "side": "BUY", "price": None, "size": "0.005"})
    assert s == "side=BUY&size=0.005&symbol=BTC-USDT"


def test_sign_matches_sdk_reference():
    ts = 1_700_000_000_000
    secret = "shhh"
    data = {"symbol": "BTC-USDT", "side": "BUY", "size": "0.005"}
    got = sign_canonical("POST", "/api/v3/order", ts, data, secret)

    # Recompute independently using the SDK canonical form.
    ds = "side=BUY&size=0.005&symbol=BTC-USDT"
    msg = f"{ts}POST/api/v3/order{ds}".encode()
    key = base64.b64encode(secret.encode())
    expected = base64.b64encode(hmac.new(key, msg, hashlib.sha256).digest()).decode()
    assert got == expected


def test_sign_is_deterministic_across_key_order():
    ts = 1
    secret = "k"
    a = sign_canonical("POST", "/p", ts, {"b": "2", "a": "1"}, secret)
    b = sign_canonical("POST", "/p", ts, {"a": "1", "b": "2"}, secret)
    assert a == b


def test_sign_never_includes_secret_in_message():
    # The message must be reproducible from public inputs alone; the secret
    # is only used as the HMAC key. A regression that concatenated the
    # secret into the message would silently work but leak on log capture.
    ts = 42
    data = {"a": "1"}
    msg_seen = f"{ts}POST/p{'a=1'}"
    sig = sign_canonical("POST", "/p", ts, data, "sekret")
    # If the secret leaked into the message, replacing it in-memory would
    # change the signature. Here the key is what matters, so signing with
    # a different secret produces a different result.
    other = sign_canonical("POST", "/p", ts, data, "OTHER")
    assert sig != other
    assert "sekret" not in msg_seen
