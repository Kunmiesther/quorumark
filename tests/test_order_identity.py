import pytest
from order_identity import entry_order_key


RAW = "accum:64697a4f-f52c-43f2-8b80-374a30c97c5e:ETHUSDT:long:1790361000000:1790362800000"


def test_actual_rejected_identity_is_compact_and_repeatable():
    assert len(RAW) == 83
    key = entry_order_key(RAW)
    assert len(key) == 64
    assert key.startswith("tb1:")
    # Shared golden vector with broker/src/__tests__/automationOrder.test.ts.
    assert key == "tb1:6580bc5879a712158c2c789b5e4fcc1699e2a30fc0adc65a98bf1388fdb2"
    assert key == entry_order_key(RAW)
    assert entry_order_key(key) == key


@pytest.mark.parametrize("old,new", [
    ("64697a4f", "54d5451e"), ("ETHUSDT", "BTCUSDT"),
    ("long", "short"), ("1790361000000", "1790361000001"),
    ("1790362800000", "1790362800001"), ("accum", "hunter"),
])
def test_complete_scope_affects_identity(old, new):
    assert entry_order_key(RAW) != entry_order_key(RAW.replace(old, new))


@pytest.mark.parametrize("key", ["existing-order", "x" * 64])
def test_existing_accepted_keys_never_change(key):
    assert entry_order_key(key) == key


@pytest.mark.parametrize("key", [None, "", "short", 123])
def test_invalid_identity_is_not_replaced_with_random_key(key):
    with pytest.raises(ValueError):
        entry_order_key(key)


def test_accumulator_builder_compacts_real_identity_without_changing_signal(monkeypatch):
    from types import SimpleNamespace
    import bot_worker as bw

    zone = SimpleNamespace(lower=2900, upper=2950)
    retest = SimpleNamespace(
        break_event=SimpleNamespace(zone=zone, break_ts=1790361000000),
        retest_ts=1790362800000,
    )
    monkeypatch.setattr(bw.entry_eligibility, "newly_confirmed_entry", lambda *_: retest)
    monkeypatch.setattr(bw, "accumulator_stop_pct", lambda *_: 0.02)
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    result = bot._accum_direction_input(
        direction="long", result={}, candles=[[0, 3000, 3010, 2990, 3000, 10]],
        connection_id="64697a4f-f52c-43f2-8b80-374a30c97c5e", normalized="ETHUSDT",
    )
    assert result.confirmed
    assert result.idempotency_key == entry_order_key(RAW)
    assert result.confirmation_ref == "break:1790361000000|retest:1790362800000"
    assert result.entry_price == 3000


def test_hunter_builder_compacts_identity_without_changing_plan():
    from types import SimpleNamespace
    from bot_worker import RailwayTurtleBot

    plan = SimpleNamespace(fvg_confirm_ts=1790361000000, ratio=2, stop_pct=0.02,
                           fill_px=3000, stop_level=2940, tp_level=3120)
    connection = "64697a4f-f52c-43f2-8b80-374a30c97c5e"
    result = RailwayTurtleBot._plan_direction_input(
        direction="long", plan=plan, kind="hunter",
        connection_id=connection, normalized="ETHUSDT",
    )
    assert result.confirmed
    assert result.idempotency_key == entry_order_key(
        f"hunter:{connection}:ETHUSDT:long:1790361000000")
    assert len(result.idempotency_key) <= 64
    assert result.entry_price == 3000
    assert result.take_profits == [3120]
