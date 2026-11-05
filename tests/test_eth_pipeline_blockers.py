"""ETH-USDT pipeline blockers — equity resolution and live participation.

Pins the three defects observed live on 2026-07-31:
  1. A funding refusal on a funded account, caused by coercing an absent
     balance field to 0 instead of distinguishing an unreadable read. (The
     code was EQUITY_BELOW_MIN at the time; that wallet-size minimum has
     since been removed and a drained account now fails the ratified reserve
     floor instead.)
  2. Three candidate identities for ONE completed ETH 5m candle, caused by
     running the live legs for every `active_bot_config` row including
     paper-mode and unverified connections.

No network, no credentials, no orders.
"""
import os
import sys
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "signer"))

import live_eligibility
from app.execution import PipelineError, preflight, resolve_preflight_equity

VERIFIED_CONN = "4a6cec71-0f1f-423f-8979-25edf2e77b7d"


def _base_preflight(**over):
    kwargs = dict(
        kill_switch_halted=False,
        equity_usd=Decimal("600"),
        open_orders_for_symbol=[],
        open_positions_for_symbol=[],
    )
    kwargs.update(over)
    return kwargs


# --- Equity resolution --------------------------------------------------

def test_available_balance_is_preferred_over_total_equity():
    assert resolve_preflight_equity("612.40", "980.00") == Decimal("612.40")


def test_total_equity_is_used_only_when_available_is_absent():
    assert resolve_preflight_equity(None, "980.00") == Decimal("980.00")
    assert resolve_preflight_equity("", "980.00") == Decimal("980.00")


def test_unreadable_pair_is_none_never_zero():
    """The exact ETH defect: a missing read must NOT look like an empty account."""
    assert resolve_preflight_equity(None, None) is None
    assert resolve_preflight_equity("", "") is None
    assert resolve_preflight_equity("n/a", None) is None


def test_zero_balance_is_still_a_real_zero():
    assert resolve_preflight_equity("0", None) == Decimal("0")


def test_preflight_reports_unavailable_not_below_min():
    with pytest.raises(PipelineError) as e:
        preflight(**_base_preflight(equity_usd=None))
    assert e.value.code == "EQUITY_UNAVAILABLE"


def test_preflight_rejects_negative_equity_as_invalid():
    with pytest.raises(PipelineError) as e:
        preflight(**_base_preflight(equity_usd=Decimal("-1")))
    assert e.value.code == "EQUITY_INVALID"


def test_preflight_still_blocks_a_genuinely_drained_account():
    # Now EQUITY_BELOW_FLOOR, not EQUITY_BELOW_MIN: the wallet-size minimum is
    # gone and the ratified reserve floor is what a drained account fails.
    with pytest.raises(PipelineError) as e:
        preflight(**_base_preflight(equity_usd=Decimal("12")))
    assert e.value.code == "EQUITY_BELOW_FLOOR"


def test_kill_switch_outranks_unreadable_equity():
    with pytest.raises(PipelineError) as e:
        preflight(**_base_preflight(equity_usd=None, kill_switch_halted=True))
    assert e.value.code == "KILL_SWITCH_ACTIVE"


def test_funded_account_passes():
    preflight(**_base_preflight(equity_usd=Decimal("612.40")))


# --- Live participation gate -------------------------------------------

def _cfg(**over):
    cfg = {
        "user_id": "0b7b1651-b3a5-4370-b89f-0deeaba4ea3f",
        "connection_id": VERIFIED_CONN,
        "symbol": "ETH-USDT",
        "mode": "live",
        "status": "verified",
        "permissions_verified": True,
        "permission_trade": True,
    }
    cfg.update(over)
    return cfg


def test_verified_live_connection_is_eligible():
    assert live_eligibility.live_execution_eligible(_cfg())
    assert live_eligibility.live_execution_block_code(_cfg()) is None


@pytest.mark.parametrize("over,code", [
    ({"mode": "paper"}, "CONFIG_NOT_LIVE_MODE"),
    ({"status": "disconnected"}, "CONNECTION_NOT_VERIFIED"),
    ({"status": "pending_verification"}, "CONNECTION_NOT_VERIFIED"),
    ({"permissions_verified": False}, "PERMISSIONS_NOT_VERIFIED"),
    ({"permission_trade": False}, "TRADE_PERMISSION_MISSING"),
])
def test_ineligible_rows_are_blocked_with_a_stable_code(over, code):
    cfg = _cfg(**over)
    assert live_eligibility.live_execution_block_code(cfg) == code
    assert not live_eligibility.live_execution_eligible(cfg)


def test_missing_or_malformed_config_fails_closed():
    assert live_eligibility.live_execution_block_code(None) == "CONFIG_MISSING"
    assert not live_eligibility.live_execution_eligible({})


def test_only_one_of_the_three_live_eth_rows_participates():
    """The observed fan-out: one verified live row plus two that must not run."""
    rows = [
        _cfg(),
        _cfg(connection_id="e95c60f7-0000-0000-0000-000000000000",
             mode="paper", status="disconnected"),
        _cfg(connection_id="f48b7ba8-0000-0000-0000-000000000000",
             mode="paper", status="pending_verification"),
    ]
    eligible = [r for r in rows if live_eligibility.live_execution_eligible(r)]
    assert [r["connection_id"] for r in eligible] == [VERIFIED_CONN]
