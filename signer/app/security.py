"""HMAC request auth + replay protection for the private signer service.

The edge function signs each request as:
    signature = HMAC_SHA256(SIGNER_SHARED_SECRET,
                            f"{timestamp}\\n{nonce}\\n{path}\\n{raw_body}")

Requests older/newer than SIGNER_ALLOWED_SKEW_SECONDS (default 30) are
rejected. Nonces are cached in-process for 2x the skew window to prevent
replay. This is defence-in-depth on top of Railway private networking —
the signer must ALSO be unreachable from the public internet.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json as _json
import os
import time
from collections import OrderedDict
from typing import Optional
from typing import Awaitable, Callable

from fastapi import HTTPException, Request

_MAX_NONCE_CACHE = 4096
_nonce_cache: "OrderedDict[str, float]" = OrderedDict()


def _skew_seconds() -> int:
    try:
        return int(os.environ.get("SIGNER_ALLOWED_SKEW_SECONDS", "30"))
    except ValueError:
        return 30


def _shared_secret() -> bytes:
    v = os.environ.get("SIGNER_SHARED_SECRET")
    if not v:
        # Fail closed — the service is useless without the shared secret.
        raise HTTPException(status_code=500, detail="SIGNER_NOT_CONFIGURED")
    return v.encode("utf-8")


def _compute(ts: str, nonce: str, path: str, body: bytes) -> str:
    msg = b"\n".join([ts.encode(), nonce.encode(), path.encode(), body])
    return hmac.new(_shared_secret(), msg, hashlib.sha256).hexdigest()


def _remember_nonce(nonce: str, now: float) -> None:
    window = _skew_seconds() * 2
    # Purge expired entries.
    while _nonce_cache:
        oldest_nonce, seen_at = next(iter(_nonce_cache.items()))
        if now - seen_at > window:
            _nonce_cache.popitem(last=False)
        else:
            break
    _nonce_cache[nonce] = now
    # Hard cap to bound memory even under attack.
    while len(_nonce_cache) > _MAX_NONCE_CACHE:
        _nonce_cache.popitem(last=False)


async def enforce_signed_request(request: Request) -> bytes:
    """Verify HMAC + timestamp + nonce. Returns the raw body on success."""
    ts = request.headers.get("x-signer-timestamp", "")
    nonce = request.headers.get("x-signer-nonce", "")
    sig = request.headers.get("x-signer-signature", "")
    if not ts or not nonce or not sig:
        raise HTTPException(status_code=401, detail="MISSING_AUTH_HEADERS")

    try:
        ts_int = int(ts)
    except ValueError:
        raise HTTPException(status_code=401, detail="BAD_TIMESTAMP")

    now = time.time()
    if abs(now - ts_int) > _skew_seconds():
        raise HTTPException(status_code=401, detail="TIMESTAMP_SKEW")

    if nonce in _nonce_cache:
        raise HTTPException(status_code=401, detail="REPLAYED_NONCE")

    body = await request.body()
    expected = _compute(ts, nonce, request.url.path, body)
    if not hmac.compare_digest(expected, sig.strip().lower()):
        # This is broker→signer request authentication, not the owner's wallet
        # signature. Keep the code distinct so UI/operator diagnostics do not
        # confuse a shared-secret/canonical-string mismatch with MetaMask
        # onboarding validation.
        raise HTTPException(status_code=401, detail="INVALID_HMAC_SIGNATURE")

    _remember_nonce(nonce, now)
    return body


SanitizerFn = Callable[[dict], dict]


def sanitize_response(payload: dict) -> dict:
    """Drop any accidentally-included secret material from responses.

    Whitelisted keys only. Anything else is dropped — even if a future
    handler forgets, the response never leaks seeds/keys/passphrases.
    """
    allowed = {
        "status",
        "exchange_order_id",
        "exchange_status",
        "reject_reason",
        "credential_id",
        "credential_fingerprint",
        "apex_account_id",
        "wallet_address",
        "environment",
        "last_verified_at",
        # Read-only account snapshot fields (VERIFY_CREDENTIALS / READ_ACCOUNT).
        # Values are shaped by the handler; the sanitizer only guards the
        # top-level key set.
        "exchange",
        "connection_id",
        "verified",
        "account",
        # Post-build order snapshot: size/notional/protected_price shown in
        # the ProofOfLife panel so the owner sees exactly what was submitted.
        # Contains no secret material — see main.py `built_context`.
        "built",
        # Sanitized venue-rejection facts + deployed build id. Both are
        # produced by `venue_reject` (allowlisted category + allowlisted
        # phrase only — never raw venue text), and both were previously
        # dropped here, which is why every persisted reject carried
        # `signer_revision: null` and could not be tied to a build.
        "venue_reject",
        "signer_revision",
        "protection_venue_ids",
        "protections_attached",
        "stop_attachment_confirmed",
        # Five-rung campaign execution evidence. Each nested row is built
        # exclusively from the signer's own sanitized BuiltOrder snapshot and
        # venue-generated order IDs; no request or credential data is echoed.
        "campaign_rung_count",
        "campaign_margin_usd",
        "wallet_equity_at_plan_usd",
        "hard_stop_price",
        "campaign_orders",
        "reconciliation_required",
        "filled_size",
        "reduce_only",
        # Read-only venue truth for reconciliation (/v1/positions). These are
        # venue-published facts, not secret material; dropping them here is
        # what made the reconciler see an empty snapshot.
        "positions",
        "open_orders",
        # Aster snapshot handlers shape these values without credential data.
        # Dropping them turns a successful read into an incomplete snapshot.
        "total_equity",
        "available_balance",
        "wallet_balance",
        "currency",
        "fills",
        "complete_through_ms",

        # Same-account ApeX capital flow. Each value is explicitly shaped by
        # apex_capital.py and contains ledger totals or a sanitized transfer
        # receipt only. No address, chain, credential, seed, or signature can
        # enter these objects through the typed capital endpoint.
        "balances",
        "receipt",
        "before",

    }
    return {k: v for k, v in payload.items() if k in allowed}


def decode_jwt_sub_unverified(token: str) -> Optional[str]:
    """Return the JWT `sub` claim without verifying the signature.

    F2 (defense-in-depth): the broker already verifies the caller JWT against
    Supabase JWKS (issuer + signature) BEFORE forwarding it as `caller_jwt` in
    the HMAC-covered request body. This local decode exists only to
    cross-check `sub == body.user_id` in the signer's onboarding handler so a
    compromised broker cannot smuggle in a caller_jwt whose sub differs from
    the body-supplied user_id. RLS on `apex_execution_credentials` remains the
    ultimate backstop.

    Returns None on any parse failure — the caller MUST refuse in that case.
    """
    if not isinstance(token, str) or token.count(".") != 2:
        return None
    payload_b64 = token.split(".")[1]
    # base64url decode, tolerant of missing padding.
    pad = "=" * (-len(payload_b64) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload_b64 + pad)
        claims = _json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return None
    sub = claims.get("sub") if isinstance(claims, dict) else None
    return str(sub) if sub else None
