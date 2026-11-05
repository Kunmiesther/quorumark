"""The four mandatory safety checks between a LONG/SHORT decision and ApeX.

PURE. No I/O, no credentials, no venue access, no clock read. The caller
gathers the inputs and this module decides, in a fixed order, whether the
decision may become an order intent.

    1. Verified live connection and trading permission
    2. Fresh, valid, usable equity
    3. No conflicting position, order, or in-flight intent for that symbol
    4. ApeX-valid size, price, leverage and margin configuration

RULES
-----
  * The order is fixed and the evaluation SHORT-CIRCUITS. The first failure
    is the recorded reason; later checks are reported as "not evaluated",
    never as passed and never as failed.
  * Every failure carries a stable machine code. There is no generic
    "blocked" outcome and no branch that returns a default.
  * A candidate, a Scout report, an Onyx decision and an AI opinion are NOT
    inputs here and must never become one.

WHAT IS AUTHORITATIVE WHERE
---------------------------
Check 3 covers what the worker can prove on its own: its own durable
in-flight intent ledger, plus the re-entry lockout. The venue-side truth
(an open ApeX position or a resting ApeX order on that symbol) is enforced
by the signer's `preflight()` immediately before signing, against a live
authenticated read, and surfaces as EXISTING_OPEN_POSITION /
EXISTING_OPEN_ORDER on the ApeX result. Duplicating that read in the worker
would add a second venue path and a second answer; there is exactly one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

import live_eligibility


CHECK_CONNECTION = "connection_verified"
CHECK_EQUITY = "equity_usable"
CHECK_EXPOSURE = "no_conflicting_exposure"
CHECK_ORDER_PARAMS = "order_params_valid"

CHECK_ORDER = (CHECK_CONNECTION, CHECK_EQUITY, CHECK_EXPOSURE, CHECK_ORDER_PARAMS)

CHECK_LABELS = {
    CHECK_CONNECTION: "Verified live connection and trading permission",
    CHECK_EQUITY: "Fresh, valid, usable equity",
    CHECK_EXPOSURE: "No conflicting position, order or in-flight intent",
    CHECK_ORDER_PARAMS: "ApeX-valid size, price, leverage and margin",
}


@dataclass(frozen=True)
class CheckResult:
    key: str
    # True = passed, False = failed, None = not evaluated (an earlier check
    # failed). "Not evaluated" is never rendered as a pass or a rejection.
    passed: Optional[bool]
    code: Optional[str]
    detail: Optional[str]


@dataclass(frozen=True)
class SafetyOutcome:
    passed: bool
    checks: tuple
    block_code: Optional[str]
    block_detail: Optional[str]

    def as_dict(self) -> dict:
        return {
            "passed": self.passed,
            "block_code": self.block_code,
            "block_detail": self.block_detail,
            "checks": [
                {
                    "key": c.key,
                    "label": CHECK_LABELS[c.key],
                    "passed": c.passed,
                    "code": c.code,
                    "detail": c.detail,
                }
                for c in self.checks
            ],
        }


def _connection_check(
    cfg: Optional[Mapping[str, Any]], live_trading_enabled: bool
) -> CheckResult:
    if not live_trading_enabled:
        return CheckResult(
            CHECK_CONNECTION, False, "LIVE_TRADING_DISABLED",
            "Worker LIVE_TRADING_ENABLED is off",
        )
    code = live_eligibility.live_execution_block_code(cfg)
    if code is not None:
        return CheckResult(CHECK_CONNECTION, False, code, "Connection is not live-verified")
    return CheckResult(CHECK_CONNECTION, True, None, None)


def _equity_check(equity_usd: Optional[float]) -> CheckResult:
    """Freshness is structural, not a threshold: the caller performs the
    authenticated balance read immediately before this gate, so the figure is
    as fresh as the venue can make it. No invented staleness bound is applied
    on top — that could only ever refuse a trade nothing else objected to."""
    # None is a FAILED READ, never a zero balance. The account may be fully
    # funded; conflating the two would report a funded account as drained.
    if equity_usd is None:
        return CheckResult(
            CHECK_EQUITY, False, "EQUITY_UNAVAILABLE",
            "Authenticated balance read returned no usable figure",
        )
    try:
        value = float(equity_usd)
    except (TypeError, ValueError):
        return CheckResult(CHECK_EQUITY, False, "EQUITY_INVALID", "Balance is not a number")
    if value != value or value in (float("inf"), float("-inf")) or value < 0:
        return CheckResult(CHECK_EQUITY, False, "EQUITY_INVALID", "Balance is not a finite, non-negative number")
    # NO EQUITY MINIMUM IS APPLIED HERE, DELIBERATELY.
    #
    # The ratified sizing rule is §13.2: margin_fraction = 10 / leverage, so
    # at the pilot's 100x an entry commits 10% of the wallet as margin. That
    # is scale-invariant — `accumulator_sizing` notes the whole §13.5 ledger
    # holds at a constant 47% of capital whatever the balance is — so there is
    # no wallet size at which the ratio itself fails.
    #
    # The real floor is the VENUE, and it is already enforced twice on the
    # sizing path: NOTIONAL_BELOW_VENUE_MINIMUM from the live min_notional,
    # and SIZE_BELOW_VENUE_MINIMUM from minOrderSize/stepSize. Both read
    # /api/v3/symbols rather than assuming a number.
    #
    # A previous version of this check refused below 500 USD, mirroring the
    # signer. That was the mistake `accumulator_sizing` warns about by name —
    # "inventing a minimum would be exactly the MAX_LIMIT=1500 error again" —
    # and it refused wallets the venue would have accepted.
    return CheckResult(CHECK_EQUITY, True, None, None)


def _exposure_check(
    *,
    symbol: str,
    direction: str,
    in_flight_symbols: Sequence[str],
    lockout_active: bool,
) -> CheckResult:
    """Symbol-scoped ONLY. Exposure on BTC-USDT must never block ETH-USDT."""
    key = str(symbol or "").strip().upper()
    blocking = {str(s or "").strip().upper() for s in in_flight_symbols}
    if key in blocking:
        return CheckResult(
            CHECK_EXPOSURE, False, "SYMBOL_EXECUTION_IN_FLIGHT",
            f"An intent for {key} has not reached a terminal state",
        )
    if lockout_active:
        return CheckResult(
            CHECK_EXPOSURE, False, "REENTRY_LOCKOUT_ACTIVE",
            f"Re-entry lockout is active for {key} {direction}",
        )
    return CheckResult(CHECK_EXPOSURE, True, None, None)


def _order_params_check(
    sizing_error_code: Optional[str], size: Optional[float], leverage: Optional[int]
) -> CheckResult:
    if sizing_error_code:
        return CheckResult(
            CHECK_ORDER_PARAMS, False, str(sizing_error_code)[:64],
            "Venue-valid order parameters could not be derived",
        )
    if size is None or not (float(size) > 0):
        return CheckResult(
            CHECK_ORDER_PARAMS, False, "SIZE_NOT_POSITIVE", "Derived size is not positive",
        )
    # Leverage is now REQUIRED. Every strategy leg derives it from
    # `pilot_sizing.pilot_leverage` (already clamped to the ratified ceiling,
    # and clamped again by the signer to 1..100). A missing value used to mean
    # "Hunter/Sweep, let the signer decide" — which is how `leverage: null`
    # intents reached the venue. Absent leverage is now a refusal, not a
    # delegation.
    if leverage is None or not (int(leverage) > 0):
        return CheckResult(
            CHECK_ORDER_PARAMS, False, "LEVERAGE_NOT_DERIVED",
            "No venue-valid leverage was derived for this intent",
        )

    return CheckResult(CHECK_ORDER_PARAMS, True, None, None)


def evaluate_safety(
    *,
    cfg: Optional[Mapping[str, Any]],
    live_trading_enabled: bool,
    equity_usd: Optional[float],
    symbol: str,
    direction: str,
    in_flight_symbols: Sequence[str],
    lockout_active: bool,
    sizing_error_code: Optional[str],
    size: Optional[float],
    leverage: Optional[int],
) -> SafetyOutcome:
    """Run the four checks in order and stop at the first failure."""
    results: list[CheckResult] = []
    evaluators = (
        lambda: _connection_check(cfg, live_trading_enabled),
        lambda: _equity_check(equity_usd),
        lambda: _exposure_check(
            symbol=symbol, direction=direction,
            in_flight_symbols=in_flight_symbols, lockout_active=lockout_active,
        ),
        lambda: _order_params_check(sizing_error_code, size, leverage),
    )
    failed_at: Optional[int] = None
    for index, evaluate in enumerate(evaluators):
        if failed_at is not None:
            results.append(CheckResult(CHECK_ORDER[index], None, None, None))
            continue
        result = evaluate()
        results.append(result)
        if result.passed is not True:
            failed_at = index

    if failed_at is None:
        return SafetyOutcome(True, tuple(results), None, None)
    blocker = results[failed_at]
    return SafetyOutcome(False, tuple(results), blocker.code, blocker.detail)
