"""The four mandatory safety checks."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import safety_checks as sc

LIVE_CFG = {
    "mode": "live",
    "status": "verified",
    "permissions_verified": True,
    "permission_trade": True,
}


def _evaluate(**overrides):
    base = dict(
        cfg=LIVE_CFG,
        live_trading_enabled=True,
        equity_usd=1000.0,
        symbol="ETH-USDT",
        direction="long",
        in_flight_symbols=[],
        lockout_active=False,
        sizing_error_code=None,
        size=0.05,
        leverage=100,
    )
    base.update(overrides)
    return sc.evaluate_safety(**base)


def test_all_four_pass_on_a_healthy_live_connection():
    out = _evaluate()
    assert out.passed is True
    assert out.block_code is None
    assert [c.key for c in out.checks] == list(sc.CHECK_ORDER)
    assert all(c.passed is True for c in out.checks)


def test_an_unverified_connection_blocks_at_check_one():
    out = _evaluate(cfg=dict(LIVE_CFG, status="pending"))
    assert out.passed is False
    assert out.block_code == "CONNECTION_NOT_VERIFIED"


def test_live_trading_disabled_is_named_rather_than_silent():
    out = _evaluate(live_trading_enabled=False)
    assert out.block_code == "LIVE_TRADING_DISABLED"


def test_missing_equity_is_EQUITY_UNAVAILABLE_never_zero():
    """A failed balance read is NOT a drained account. Conflating them would
    report a fully funded account as empty."""
    out = _evaluate(equity_usd=None)
    assert out.block_code == "EQUITY_UNAVAILABLE"
    assert out.block_code != "EQUITY_BELOW_MIN"


def test_a_small_wallet_is_not_refused_here():
    """There is NO equity minimum. Sizing is 10% of the wallet as margin
    (accumulator_sizing §13.2: margin_fraction = 10 / leverage), which is
    scale-invariant — a small wallet simply takes a small position.

    This check previously refused below 500 USD, mirroring the signer, and
    that was wrong: it refused wallets the venue would have accepted, and
    `accumulator_sizing` warns against exactly that invented minimum."""
    for equity in (1.0, 25.0, 100.0, 499.0):
        assert _evaluate(equity_usd=equity).passed is True


def test_zero_equity_is_not_refused_by_this_check_either():
    """Zero is a real, readable balance, not a failed read. Nothing is
    invented here — the venue minimums on the sizing path (min_notional,
    minOrderSize/stepSize) are what refuse an unplaceable order, against
    live /api/v3/symbols data rather than an assumed number."""
    assert _evaluate(equity_usd=0.0).passed is True


def test_a_nonsense_balance_is_invalid_not_a_number_to_trade_on():
    assert _evaluate(equity_usd=float("nan")).block_code == "EQUITY_INVALID"
    assert _evaluate(equity_usd=-5.0).block_code == "EQUITY_INVALID"
    assert _evaluate(equity_usd="lots").block_code == "EQUITY_INVALID"


def test_no_invented_staleness_bound_can_refuse_a_read_that_succeeded():
    """Freshness is structural — the caller reads the balance immediately
    before the gate. A threshold on top could only refuse a trade that
    nothing else objected to."""
    import inspect
    assert "equity_age_ms" not in inspect.signature(sc.evaluate_safety).parameters
    assert not hasattr(sc, "MAX_EQUITY_AGE_MS")


def test_existing_exposure_blocks_only_the_matching_symbol():
    """BTC exposure must never block an ETH trade. This is the isolation the
    whole per-symbol design rests on."""
    blocked = _evaluate(symbol="BTC-USDT", in_flight_symbols=["BTC-USDT"])
    assert blocked.block_code == "SYMBOL_EXECUTION_IN_FLIGHT"

    allowed = _evaluate(symbol="ETH-USDT", in_flight_symbols=["BTC-USDT"])
    assert allowed.passed is True


def test_symbol_matching_ignores_case_and_padding():
    out = _evaluate(symbol="eth-usdt", in_flight_symbols=[" ETH-USDT "])
    assert out.block_code == "SYMBOL_EXECUTION_IN_FLIGHT"


def test_reentry_lockout_is_reported_as_itself():
    out = _evaluate(lockout_active=True)
    assert out.block_code == "REENTRY_LOCKOUT_ACTIVE"


def test_a_sizing_refusal_surfaces_the_venue_code_verbatim():
    out = _evaluate(sizing_error_code="VENUE_CONTRACT_UNAVAILABLE", size=None, leverage=None)
    assert out.block_code == "VENUE_CONTRACT_UNAVAILABLE"


def test_absent_or_non_positive_leverage_is_a_refusal():
    """Every strategy leg now derives leverage from the ratified sizer. A
    missing value is missing evidence, not a delegation to the signer — the
    `leverage: null` intents that reached the venue came from treating it as
    one."""
    assert _evaluate(size=0.05, leverage=None).passed is False
    assert _evaluate(size=0.05, leverage=None).block_code == "LEVERAGE_NOT_DERIVED"
    assert _evaluate(size=0.05, leverage=0).passed is False
    assert _evaluate(size=0.05, leverage=100).passed is True



def test_checks_short_circuit_and_later_ones_are_not_evaluated():
    """A check after a failure is 'not evaluated' — never a pass and never a
    second, competing rejection."""
    out = _evaluate(cfg=dict(LIVE_CFG, mode="paper"))
    assert out.passed is False
    assert out.checks[0].passed is False
    assert [c.passed for c in out.checks[1:]] == [None, None, None]
    assert all(c.code is None for c in out.checks[1:])


def test_check_order_is_the_owner_specified_order():
    assert sc.CHECK_ORDER == (
        sc.CHECK_CONNECTION,
        sc.CHECK_EQUITY,
        sc.CHECK_EXPOSURE,
        sc.CHECK_ORDER_PARAMS,
    )


def test_serialization_keeps_the_not_evaluated_distinction():
    payload = _evaluate(equity_usd=None).as_dict()
    assert payload["passed"] is False
    assert payload["block_code"] == "EQUITY_UNAVAILABLE"
    assert payload["checks"][2]["passed"] is None
    assert all("label" in c for c in payload["checks"])


def test_the_worker_defines_no_equity_minimum_of_its_own():
    """The worker must not carry an equity floor.

    The signer's `MIN_EQUITY_USD = Decimal("500")` has been removed too, so
    no wallet-size minimum exists on either side. What remains at the signing
    boundary is the ratified reserve floor (`allocation_reserve_floor_usd`,
    EQUITY_BELOW_FLOOR) and the venue minimums on the sizing path. This test
    asserts the worker adds no floor of its own on top of those."""
    assert not hasattr(sc, "MIN_EQUITY_USD")
    src = _executable_source("safety_checks.py")
    assert "EQUITY_BELOW_MIN" not in src


def _executable_source(path: str) -> str:
    """Source with docstrings and comments removed, so prose explaining what
    is deliberately absent does not read as a use of it."""
    import ast
    tree = ast.parse(open(path).read())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if (node.body and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                node.body.pop(0)
    return ast.unparse(tree).lower()


def test_no_candidate_scout_onyx_or_ai_input_exists():
    """These may never become execution prerequisites. A grep over the
    executable source is a blunt instrument, and that is exactly why it is
    the right guard here."""
    src = _executable_source("safety_checks.py")
    for forbidden in ("candidate", "scout", "onyx", "committee", "openai", "gemini", "claude"):
        assert forbidden not in src
