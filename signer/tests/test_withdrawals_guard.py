"""Non-custodial guarantee: no withdrawal / transfer / payout path exists.

If this test fails, DO NOT relax it — investigate what code introduced
withdrawal-shaped authority. The `WITHDRAWALS_ENABLED` flag stays OFF
until a separate, security-reviewed project turns it on.
"""
from __future__ import annotations

import pathlib

from app.operations import ALLOWED_OPERATIONS
from app.withdrawals import WITHDRAWALS_ENABLED, is_withdrawal_operation


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SIGNER_APP = REPO_ROOT / "signer" / "app"
BROKER_SRC = REPO_ROOT / "broker" / "src"


def test_flag_is_off():
    assert WITHDRAWALS_ENABLED is False


def test_no_withdrawal_operation_in_allowlist():
    for op in ALLOWED_OPERATIONS:
        assert not is_withdrawal_operation(op), (
            f"operation {op!r} matches withdrawal-shaped verb — non-custodial "
            "guarantee requires ALLOWED_OPERATIONS to stay trade-only."
        )


def test_no_withdraw_route_in_signer_or_broker():
    """No FastAPI/Fastify route path contains a withdrawal verb."""
    import re
    verbs = re.compile(r"/(withdraw|payout|cashout|transfer)", re.IGNORECASE)
    for base in (SIGNER_APP, BROKER_SRC):
        for py in base.rglob("*.py"):
            src = py.read_text(encoding="utf-8", errors="replace")
            assert not verbs.search(src), f"withdrawal-shaped route in {py}"
        for ts in base.rglob("*.ts"):
            src = ts.read_text(encoding="utf-8", errors="replace")
            # allow the constant name and comments referring to the ban
            for line in src.splitlines():
                if verbs.search(line):
                    lo = line.lower()
                    ok = (
                        "forbidden" in lo
                        or "never" in lo
                        or "non-custodial" in lo
                        or "withdrawals_enabled" in lo
                        or "// " in line or "* " in line
                        or "withdraw: false" in lo
                        or "no withdraw" in lo
                    )
                    assert ok, f"withdrawal-shaped token in {ts}: {line.strip()!r}"


def test_helper_matches_verbs():
    for v in ("WITHDRAW_FUNDS", "PayoutNow", "cashout"):
        assert is_withdrawal_operation(v) is True
    for v in ("CREATE_ORDER", "READ_ACCOUNT", "SIGN_ORDER", "MOVE_FUNDING_TO_PERPS"):
        assert is_withdrawal_operation(v) is False
