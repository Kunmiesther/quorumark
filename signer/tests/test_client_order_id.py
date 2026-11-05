from app.client_order_id import venue_client_id


def test_passthrough_when_already_venue_safe():
    assert venue_client_id("abc123") == "abc123"


def test_colon_delimited_key_is_made_venue_safe():
    raw = "accum:4a6cec71-0f1f-423f-8979-25edf2e77b7d:ETHUSDT:short:1785899714"
    out = venue_client_id(raw)
    assert out is not None
    assert out.isalnum()
    assert len(out) <= 32


def test_deterministic_so_retries_cannot_duplicate():
    raw = "manual-live-test:user:ETH-USDT:BUY:1"
    assert venue_client_id(raw) == venue_client_id(raw)


def test_distinct_keys_stay_distinct():
    assert venue_client_id("a:1") != venue_client_id("a:2")


def test_none_and_empty():
    assert venue_client_id(None) is None
    assert venue_client_id("") is None
