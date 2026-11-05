"""ACCUMULATOR_MAINNET_PILOT_V0 sizing. Ground truth = §13.5's worked examples."""
from __future__ import annotations

from decimal import Decimal

import pytest

from accumulator_sizing import (
    CAPITAL_MAX_USD, PILOT_SCOPE, SizingError, compute_cycle_sizing,
    evaluate_resize, resolve_cycle_capital, verify_leverage_supported,
)

MIN_NOTIONAL = 10   # supplied by caller from /api/v3/symbols; NOT invented here
# NOTE: the argument is AVAILABLE EQUITY, not the baseline. The external $100
# buffer comes off the top, so $600 equity -> $500 baseline. Tests written
# before the funding rule passed 500 and meant "baseline"; that now means a
# $400 baseline. Renamed to make the distinction impossible to misread.
EQ_FOR_500_BASELINE = 600
EQ_FOR_300_BASELINE = 400
S500 = lambda: compute_cycle_sizing(EQ_FOR_500_BASELINE, 100, "BTC-USDT", MIN_NOTIONAL)


# --- §13.5 worked examples, exactly as written ----------------------------
def test_500_baseline_100x_reproduces_spec_235():
    """$600 equity - $100 buffer = $500 baseline -> §13.5's $235 ledger."""
    s = S500()
    assert s.equity_floor_usd == Decimal("100")
    assert s.operational_reserve_usd == Decimal("50")
    assert s.initial_margin_usd == Decimal("50")
    assert s.max_slippage_usd == Decimal("25")
    assert s.max_fees_usd == Decimal("10")
    assert s.total_required_cycle_equity_usd == Decimal("235")
    assert s.position_notional_usd == Decimal("5000")


def test_300_baseline_100x_reproduces_spec_141():
    s = compute_cycle_sizing(EQ_FOR_300_BASELINE, 100, "BTC-USDT", MIN_NOTIONAL)
    assert [s.equity_floor_usd, s.operational_reserve_usd, s.initial_margin_usd,
            s.max_slippage_usd, s.max_fees_usd] == [Decimal(x) for x in ("60","30","30","15","6")]
    assert s.total_required_cycle_equity_usd == Decimal("141")
    assert s.position_notional_usd == Decimal("3000")


# --- §13.2 corrected formula ----------------------------------------------
def test_margin_fraction_is_10_over_leverage_not_20():
    """0.17.1 corrected 20 -> 10. `v1 ## sizing` still says 20/leverage and is
    SUPERSEDED; 20 would double every position."""
    assert S500().margin_fraction == Decimal("10") / Decimal("100") == Decimal("0.1")


def test_notional_is_capital_times_ten_at_every_leverage():
    """§13.2: leverage changes margin committed, never size."""
    for lev in (50, 100):
        s = compute_cycle_sizing(EQ_FOR_500_BASELINE, lev, "BTC-USDT" if lev == 100 else "SOL-USDT", MIN_NOTIONAL)
        assert s.position_notional_usd == Decimal("5000")


def test_notional_is_never_the_superseded_k20_value():
    assert S500().position_notional_usd != Decimal("10000")


# --- OWNER RULING: constant-margin resize ---------------------------------
def test_resize_margin_equals_initial_margin():
    s = S500()
    assert s.resize_margin_usd == s.initial_margin_usd == Decimal("50")


def test_resize_is_not_an_equal_split_of_remaining_capital():
    """$350 usable / equal split would be a different number every rung."""
    s = S500()
    usable = s.cycle_capital_usd - s.equity_floor_usd - s.operational_reserve_usd
    assert usable == Decimal("350")
    assert s.resize_margin_usd == Decimal("50")   # constant, not 350/n


def test_scope_is_pilot_not_global():
    assert S500().scope == PILOT_SCOPE == "ACCUMULATOR_MAINNET_PILOT_V0"


# --- cycle capital --------------------------------------------------------
@pytest.mark.parametrize("eq,expect", [
    (600, "500"), (1000, "500"), (10_000, "500"),   # cap binds after the buffer
    (500, "400"), (350, "250"), (150, "50"),        # buffer binds
])
def test_cycle_capital_subtracts_buffer_then_caps(eq, expect):
    """deployable = min(max(equity - 100, 0), 500)"""
    assert resolve_cycle_capital(eq) == Decimal(expect)


def test_cap_is_the_v1_ratified_ceiling():
    assert CAPITAL_MAX_USD == Decimal("500")


# --- fail closed ----------------------------------------------------------
def test_balance_unavailable_fails_closed():
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(None, 100, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "BALANCE_UNAVAILABLE"


@pytest.mark.parametrize("eq", [0, "0", -1, "-0.01"])
def test_zero_or_negative_balance_fails_closed(eq):
    """A zero balance is not a small cycle. It is no cycle."""
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(eq, 100, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "BALANCE_ZERO_OR_NEGATIVE"


def test_unreadable_balance_fails_closed():
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing("abc", 100, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "BALANCE_UNREADABLE"


def test_leverage_supported_on_btc_at_100x():
    verify_leverage_supported("BTC-USDT", Decimal("100"))   # displayMaxLeverage=100


@pytest.mark.parametrize("lev", [101, 200, 300, 500, 1000])
def test_leverage_above_venue_max_fails_closed(lev):
    """§13.2: 200x/300x/400x/500x/1000x DO NOT EXIST on ApeX."""
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(EQ_FOR_500_BASELINE, lev, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "LEVERAGE_UNSUPPORTED_BY_VENUE"


def test_100x_unsupported_on_alt_symbols():
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(EQ_FOR_500_BASELINE, 100, "SOL-USDT", MIN_NOTIONAL)   # venue max 50
    assert e.value.code == "LEVERAGE_UNSUPPORTED_BY_VENUE"


def test_unknown_symbol_fails_closed():
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(EQ_FOR_500_BASELINE, 100, "DOGE-USDT", MIN_NOTIONAL)
    assert e.value.code == "SYMBOL_LEVERAGE_UNKNOWN"


def test_sufficiency_ledger_is_structurally_always_pass():
    """CORRECTED. total = cap x 0.47 always ($235/$500, $141/$300), because
    every component is a fraction of the baseline (§13.5.1 scale-invariance).
    `total > cap` can NEVER fire. An earlier version of this test asserted it
    could — it was wrong about the spec, not about the code."""
    for eq in (600, 400, 150):
        s = compute_cycle_sizing(eq, 100, "BTC-USDT", 1)
        ratio = s.total_required_cycle_equity_usd / s.cycle_capital_usd
        assert ratio == Decimal("0.47")


def test_real_floor_is_the_venue_minimum_not_the_ratio():
    """A $10 baseline 'passes' the ledger while sizing a $100 notional ApeX
    would reject. The binding constraint is venue minimum order size."""
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(150, 100, "BTC-USDT", min_notional_usd=5000)
    assert e.value.code == "NOTIONAL_BELOW_VENUE_MINIMUM"


def test_missing_venue_minimum_fails_closed():
    """Never assume an order is placeable. Inventing a minimum would repeat
    the MAX_LIMIT=1500 error."""
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(EQ_FOR_500_BASELINE, 100, "BTC-USDT", min_notional_usd=None)
    assert e.value.code == "VENUE_MIN_NOTIONAL_UNAVAILABLE"


def test_no_clamping_on_failure():
    """Never returns a smaller size. A clamped position is one the guards did
    not sanction."""
    with pytest.raises(SizingError):
        compute_cycle_sizing(150, 100, "BTC-USDT", min_notional_usd=5000)


def test_errors_carry_no_balance_material():
    try:
        compute_cycle_sizing("12345.67", 100, "DOGE-USDT", MIN_NOTIONAL)
    except SizingError as e:
        assert "12345" not in str(e)


def test_decimal_not_float():
    s = S500()
    for v in (s.initial_margin_usd, s.equity_floor_usd, s.total_required_cycle_equity_usd):
        assert isinstance(v, Decimal)


# --- §13.6 resize veto ----------------------------------------------------
OK = dict(current_equity_usd=600, existing_exposure_notional_usd=5000,
          existing_margin_committed_usd=50, fee_rate_bps_per_side=5,
          has_newly_eligible_entry=True, liquidation_buffer_ok=True)


def test_resize_permitted_when_all_guards_hold():
    d = evaluate_resize(sizing=S500(), **OK)
    assert d.permitted is True and d.reason_code == "PERMITTED"
    assert d.proposed_margin_usd == Decimal("50")


def test_resize_requires_a_newly_eligible_entry():
    """Without a NEW confirmation a resize would rebuild rungs from history —
    exactly what entry_eligibility prevents."""
    d = evaluate_resize(sizing=S500(), **{**OK, "has_newly_eligible_entry": False})
    assert d.permitted is False and d.reason_code == "NO_NEWLY_ELIGIBLE_ENTRY"


def test_resize_refused_without_authenticated_fee_rate():
    """§13.5: do not claim the cycle passes without the actual fee rate."""
    d = evaluate_resize(sizing=S500(), **{**OK, "fee_rate_bps_per_side": None})
    assert d.permitted is False and d.reason_code == "FEE_RATE_UNAVAILABLE"


def test_resize_refused_on_liquidation_buffer_failure():
    d = evaluate_resize(sizing=S500(), **{**OK, "liquidation_buffer_ok": False})
    assert d.permitted is False and d.reason_code == "LIQUIDATION_BUFFER_FAIL"


def test_resize_refused_when_floor_or_reserve_would_break():
    d = evaluate_resize(sizing=S500(), **{**OK, "current_equity_usd": 260})
    assert d.permitted is False
    assert d.reason_code in ("INSUFFICIENT_POST_RESIZE_EQUITY", "FLOOR_OR_RESERVE_BREACH",
                             "WOULD_CONSUME_EXTERNAL_BUFFER")


def test_resize_refused_when_margin_would_exceed_capital():
    d = evaluate_resize(sizing=S500(), **{**OK, "existing_margin_committed_usd": 480})
    assert d.permitted is False and d.reason_code == "MARGIN_EXCEEDS_ACCOUNT_CAPITAL"


@pytest.mark.parametrize("eq", [0, -5])
def test_resize_refused_on_zero_equity(eq):
    d = evaluate_resize(sizing=S500(), **{**OK, "current_equity_usd": eq})
    assert d.permitted is False and d.reason_code == "BALANCE_ZERO_OR_NEGATIVE"


def test_resizing_terminates_by_guard_not_by_a_count_constant():
    """No predefined rung ceiling. Guards stop it; unused capital stays unused."""
    s = S500()
    committed = Decimal("50")
    rungs = 1
    while True:
        d = evaluate_resize(sizing=s, **{**OK, "existing_margin_committed_usd": committed,
                                          "current_equity_usd": 600})
        if not d.permitted:
            break
        committed += d.proposed_margin_usd
        rungs += 1
        if rungs > 50:
            pytest.fail("resizing did not terminate — guards are not binding")
    assert 2 <= rungs <= 10          # terminated by a guard, not a constant
    assert committed < s.cycle_capital_usd   # capital left unused, as ruled


# ==========================================================================
# PILOT FUNDING RULE (owner, 2026-07-17)
#   deployable_cycle_capital = min(max(available_equity - 100, 0), 500)
# ==========================================================================
from accumulator_sizing import EXTERNAL_WALLET_BUFFER_USD, WALLET_TARGET_USD


def test_funding_constants():
    assert WALLET_TARGET_USD == Decimal("600")
    assert EXTERNAL_WALLET_BUFFER_USD == Decimal("100")
    assert CAPITAL_MAX_USD == Decimal("500")


@pytest.mark.parametrize("bal,base,floor,res,margin,notional,total", [
    (300,  "200", "40",  "20", "20", "2000",  "94"),
    (500,  "400", "80",  "40", "40", "4000", "188"),
    (600,  "500", "100", "50", "50", "5000", "235"),   # the funded target
    (1000, "500", "100", "50", "50", "5000", "235"),   # cap binds
    (5000, "500", "100", "50", "50", "5000", "235"),
])
def test_balance_table(bal, base, floor, res, margin, notional, total):
    s = compute_cycle_sizing(bal, 100, "BTC-USDT", MIN_NOTIONAL)
    assert s.cycle_capital_usd == Decimal(base)
    assert s.equity_floor_usd == Decimal(floor)
    assert s.operational_reserve_usd == Decimal(res)
    assert s.initial_margin_usd == Decimal(margin)
    assert s.resize_margin_usd == Decimal(margin)      # constant-margin
    assert s.position_notional_usd == Decimal(notional)
    assert s.total_required_cycle_equity_usd == Decimal(total)


def test_zero_balance_fails_closed():
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(0, 100, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "BALANCE_ZERO_OR_NEGATIVE"


@pytest.mark.parametrize("bal", [100, "100", "99.99", 50, 1])
def test_equity_at_or_below_buffer_fails_closed(bal):
    """At exactly $100, deployable is $0. Returning 0 would let every fraction
    compute cleanly to zero and look like a valid plan."""
    with pytest.raises(SizingError) as e:
        compute_cycle_sizing(bal, 100, "BTC-USDT", MIN_NOTIONAL)
    assert e.value.code == "EQUITY_AT_OR_BELOW_EXTERNAL_BUFFER"


def test_baseline_shrinks_between_buffer_and_target():
    """$100 < equity < $600 -> reduced baseline, everything recomputed FROM it."""
    for bal in (150, 200, 350, 450, 599):
        s = compute_cycle_sizing(bal, 100, "BTC-USDT", 1)
        assert s.cycle_capital_usd == Decimal(str(bal)) - Decimal("100")
        assert s.equity_floor_usd == s.cycle_capital_usd * Decimal("0.20")
        assert s.operational_reserve_usd == s.cycle_capital_usd * Decimal("0.10")
        assert s.initial_margin_usd == s.cycle_capital_usd * Decimal("0.10")
        assert s.position_notional_usd == s.cycle_capital_usd * Decimal("10")


# --- the external buffer is not strategy capital --------------------------
def test_buffer_never_increases_the_baseline():
    """Baseline can never exceed equity minus the buffer."""
    for bal in (150, 300, 600, 10_000):
        s = compute_cycle_sizing(bal, 100, "BTC-USDT", 1)
        assert s.cycle_capital_usd <= Decimal(str(bal)) - EXTERNAL_WALLET_BUFFER_USD
        assert s.cycle_capital_usd <= CAPITAL_MAX_USD


def test_buffer_never_increases_rung_sizing():
    s600 = compute_cycle_sizing(600, 100, "BTC-USDT", MIN_NOTIONAL)
    s700 = compute_cycle_sizing(700, 100, "BTC-USDT", MIN_NOTIONAL)
    assert s600.resize_margin_usd == s700.resize_margin_usd == Decimal("50")
    assert s600.position_notional_usd == s700.position_notional_usd == Decimal("5000")


def test_buffer_is_reported_and_distinct_from_the_internal_floor():
    """At $600 both are $100 — a COINCIDENCE. They are different pools."""
    s = compute_cycle_sizing(600, 100, "BTC-USDT", MIN_NOTIONAL)
    assert s.external_wallet_buffer_usd == Decimal("100")
    assert s.equity_floor_usd == Decimal("100")
    # ...and they diverge everywhere else, which proves they are not the same thing.
    s500 = compute_cycle_sizing(500, 100, "BTC-USDT", MIN_NOTIONAL)
    assert s500.external_wallet_buffer_usd == Decimal("100")
    assert s500.equity_floor_usd == Decimal("80")
    assert s500.external_wallet_buffer_usd != s500.equity_floor_usd


def test_resize_never_consumes_the_external_buffer():
    s = compute_cycle_sizing(600, 100, "BTC-USDT", MIN_NOTIONAL)
    d = evaluate_resize(sizing=s, current_equity_usd=260,
                        existing_exposure_notional_usd=5000,
                        existing_margin_committed_usd=50,
                        fee_rate_bps_per_side=5,
                        has_newly_eligible_entry=True, liquidation_buffer_ok=True)
    assert d.permitted is False
    assert d.reason_code in ("WOULD_CONSUME_EXTERNAL_BUFFER",
                             "INSUFFICIENT_POST_RESIZE_EQUITY")


def test_buffer_survives_a_full_resize_run():
    """Resize until the guards stop it; the buffer must still be intact."""
    s = compute_cycle_sizing(600, 100, "BTC-USDT", MIN_NOTIONAL)
    committed = Decimal("50")
    for _ in range(50):
        d = evaluate_resize(sizing=s, current_equity_usd=600,
                            existing_exposure_notional_usd=5000,
                            existing_margin_committed_usd=committed,
                            fee_rate_bps_per_side=5,
                            has_newly_eligible_entry=True, liquidation_buffer_ok=True)
        if not d.permitted:
            break
        committed += d.proposed_margin_usd
    assert committed <= s.cycle_capital_usd          # never reached into the buffer
    assert Decimal("600") - committed >= EXTERNAL_WALLET_BUFFER_USD


# ==========================================================================
# VERIFIED ApeX BTC-USDT contract — captured live 2026-07-17 (owner probe).
# THERE IS NO MINIMUM-NOTIONAL FIELD. ApeX bounds QUANTITY.
# ==========================================================================
from accumulator_sizing import CONTRACT_FIELDS, size_quantity

BTC_USDT_CONTRACT = {
    "symbol": "BTC-USDT",
    "minOrderSize": "0.0010",
    "stepSize": "0.001",
    "tickSize": "0.1",
    "maxOrderSize": "50",
    "maxPositionSize": "225",
    "maxPositionValue": "15000000",
}
PX = Decimal("100000")


def test_captured_contract_fixture_has_no_minimum_notional_field():
    """The probe's central finding: minOrderSize is a QUANTITY. The earlier
    guess list (minOrderValue/minNotional/...) was wrong in KIND."""
    for guessed in ("minOrderValue", "minNotional", "minOrderNotional", "minValue"):
        assert guessed not in BTC_USDT_CONTRACT


def test_guessed_aliases_are_gone_from_the_code():
    import market_data, accumulator_sizing, inspect
    src = inspect.getsource(market_data) + inspect.getsource(accumulator_sizing)
    for guessed in ('"minOrderValue"', '"minNotional"', '"minOrderNotional"', '"minValue"'):
        assert guessed not in src, f"guessed alias {guessed} still present"


def test_verified_fields_are_the_pinned_set():
    assert set(CONTRACT_FIELDS) == {"minOrderSize", "stepSize", "tickSize",
                                    "maxOrderSize", "maxPositionSize", "maxPositionValue"}


def test_rung_notional_sizes_to_legal_quantity():
    q = size_quantity(proposed_notional_usd=5000, price=PX, contract_cfg=BTC_USDT_CONTRACT)
    assert q.quantity == Decimal("0.05")
    assert q.notional_usd == Decimal("5000.00")
    assert q.quantity >= Decimal("0.0010")


def test_quantity_rounds_DOWN_to_step_never_up():
    """Rounding up would spend money the guards never authorized."""
    q = size_quantity(proposed_notional_usd=5000, price=99999, contract_cfg=BTC_USDT_CONTRACT)
    assert q.quantity <= q.rounded_down_from
    assert q.notional_usd <= Decimal("5000")
    assert (q.quantity / Decimal("0.001")) % 1 == 0     # exact step multiple


def test_rounding_down_never_exceeds_the_capital_cap():
    for px in (33333, 61111, 99999, 123457):
        q = size_quantity(proposed_notional_usd=5000, price=px, contract_cfg=BTC_USDT_CONTRACT)
        assert q.notional_usd <= Decimal("5000")


def test_below_min_order_size_fails_closed():
    """$50 notional at $100k = 0.0005 BTC < 0.0010 minOrderSize."""
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=50, price=PX, contract_cfg=BTC_USDT_CONTRACT)
    assert e.value.code == "QUANTITY_BELOW_MIN_ORDER_SIZE"


def test_above_max_order_size_fails_closed():
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=6_000_000, price=PX, contract_cfg=BTC_USDT_CONTRACT)
    assert e.value.code == "QUANTITY_ABOVE_MAX_ORDER_SIZE"


def test_total_position_above_max_position_size_fails_closed():
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=5000, price=PX,
                      contract_cfg=BTC_USDT_CONTRACT, existing_position_qty=Decimal("225"))
    assert e.value.code in ("POSITION_ABOVE_MAX_POSITION_SIZE",
                            "POSITION_ABOVE_MAX_POSITION_VALUE")


def test_total_position_above_max_position_value_fails_closed():
    cfg = {**BTC_USDT_CONTRACT, "maxPositionSize": "225", "maxPositionValue": "1000"}
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=5000, price=PX, contract_cfg=cfg)
    assert e.value.code == "POSITION_ABOVE_MAX_POSITION_VALUE"


def test_min_notional_is_DERIVED_for_display_only():
    q = size_quantity(proposed_notional_usd=5000, price=PX, contract_cfg=BTC_USDT_CONTRACT)
    assert q.min_notional_display_usd == Decimal("0.0010") * PX == Decimal("100")


@pytest.mark.parametrize("field", CONTRACT_FIELDS)
def test_missing_contract_field_fails_closed(field):
    cfg = {k: v for k, v in BTC_USDT_CONTRACT.items() if k != field}
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=5000, price=PX, contract_cfg=cfg)
    assert e.value.code == f"CONTRACT_FIELD_MISSING_{field}"


@pytest.mark.parametrize("field", CONTRACT_FIELDS)
def test_non_positive_contract_field_fails_closed(field):
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=5000, price=PX,
                      contract_cfg={**BTC_USDT_CONTRACT, field: "0"})
    assert e.value.code == f"CONTRACT_FIELD_INVALID_{field}"


def test_no_contract_config_fails_closed():
    with pytest.raises(SizingError) as e:
        size_quantity(proposed_notional_usd=5000, price=PX, contract_cfg=None)
    assert e.value.code == "CONTRACT_CONFIG_UNAVAILABLE"


@pytest.mark.parametrize("px", [0, -1, "abc", None])
def test_invalid_price_fails_closed(px):
    with pytest.raises(SizingError):
        size_quantity(proposed_notional_usd=5000, price=px, contract_cfg=BTC_USDT_CONTRACT)


def test_no_defaults_on_any_failure():
    """Never returns a clamped or default quantity."""
    with pytest.raises(SizingError):
        size_quantity(proposed_notional_usd=1, price=PX, contract_cfg=BTC_USDT_CONTRACT)
