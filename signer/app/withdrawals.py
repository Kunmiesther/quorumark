"""Non-custodial guarantee: WITHDRAWALS are OUT OF SCOPE.

Turtle Bot is a NON-CUSTODIAL trading bot. The authority granted by the
onboarding wallet signature and by the REST API keys the user stores here
is TRADE-ONLY. There is no code path in broker / signer / worker that can
initiate an external withdrawal, external payout, or cashout. Internal ApeX
Funding ↔ Perps allocation is allowed because the assets remain inside the
same user-owned ApeX account and can only return to that account's Funding
ledger.

This module exists as a single, greppable constant that any future
withdrawal code MUST check. Flipping this flag on is a SEPARATE,
security-reviewed project that also requires:

  * user-visible re-consent (a second signature, not the same onboarding
    signature),
  * a new REST-credential scope that explicitly asserts withdrawal
    permission (currently we require withdrawal permission to be OFF at
    the venue level — see `apex_omni_rest.AccountSnapshot.permission_withdraw`
    and the `withdrawals_disabled` attestation on `exchange_connections`),
  * an operation entry in `app.operations.ALLOWED_OPERATIONS` gated by its
    own env flag.

Until all three exist, `WITHDRAWALS_ENABLED` STAYS FALSE.
"""
from __future__ import annotations

# NON-NEGOTIABLE. Do not flip without a security review + owner sign-off.
WITHDRAWALS_ENABLED: bool = False


def is_withdrawal_operation(op: str) -> bool:
    """Case-insensitive substring match against the forbidden verbs.

    Intended for defensive assertions in tests and for any future code that
    is tempted to add a "withdraw"-shaped operation. Symbol strings are
    NEVER passed to this helper — operations only.
    """
    if not isinstance(op, str):
        return False
    lo = op.lower()
    return any(v in lo for v in ("withdraw", "payout", "cashout"))
