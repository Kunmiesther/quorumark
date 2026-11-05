#!/usr/bin/env python3
"""Owner-operated readiness verification for the Railway signer container.

Intended to be executed inside the running signer container over Railway
SSH. Never run this from an operator laptop, never expose over the public
internet, never pipe its output into chat.

Usage (inside the container, working directory /signer):

    python -m scripts.verify_readiness \\
        --user-id <uuid> --connection-id <uuid>

The script:
    * refuses to run unless every write operation in
      `signer.app.operations.OPERATION_ENABLED` is False;
    * refuses to run unless both `APEX_MAINNET_SIGNER_ENABLED` and
      `APEX_MAINNET_CANARY_ENABLED` are unset or literally "false";
    * calls the local signer at http://127.0.0.1:8080;
    * reads `SIGNER_SHARED_SECRET` from the container environment and
      generates HMAC timestamp/nonce per `app/security.py`;
    * runs /healthz, /v1/verify-credentials, /v1/read-account;
    * prints ONLY sanitized status / verification / account fields; never
      secrets, signatures, encrypted material, or request headers.

Exit codes:
    0 - all three checks succeeded and the credential verified
    1 - preconditions failed (write op enabled, mainnet flag on, missing
        secret, bad args)
    2 - a signer HTTP call failed or returned an unverified result
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

DEFAULT_BASE_URL = "http://127.0.0.1:8080"
HTTP_TIMEOUT_SECONDS = 10

# Fields safe to print. Anything not on this list is dropped, even from
# nested payloads. Aligned with `signer.app.security.sanitize_response`.
_PRINT_ALLOWED = {
    "status",
    "reject_reason",
    "credential_id",
    "credential_fingerprint",
    "apex_account_id",
    "wallet_address",
    "environment",
    "last_verified_at",
    "exchange",
    "connection_id",
    "verified",
    "account",
    # nested account fields
    "equity",
    "available_balance",
    "total_wallet_balance",
    "unrealized_pnl",
    "positions_count",
    "permissions",
    "permission_trade",
    "permission_read",
}

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Write operations that MUST be disabled for readiness verification.
# Kept as a literal list so the check is inspectable even if
# `signer.app.operations` is monkey-patched at runtime.
_WRITE_OPS = (
    "BUILD_ORDER",
    "SIGN_ORDER",
    "CREATE_ORDER",
    "CANCEL_ORDER",
    "CANCEL_ALL_ORDERS",
    "CLOSE_POSITION",
    "CLOSE_ALL_POSITIONS",
)

_MAINNET_FLAGS = (
    "APEX_MAINNET_SIGNER_ENABLED",
    "APEX_MAINNET_CANARY_ENABLED",
)


class PreconditionError(Exception):
    """Raised when the safety preconditions are not satisfied."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class SignerCallError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _sanitize(payload: Any) -> Any:
    """Recursively drop keys not on the allowlist. Non-dict / non-list
    scalars pass through unchanged."""
    if isinstance(payload, dict):
        return {
            k: _sanitize(v)
            for k, v in payload.items()
            if k in _PRINT_ALLOWED
        }
    if isinstance(payload, list):
        return [_sanitize(v) for v in payload]
    return payload


def _load_operations_module():
    # Lazy import so tests can substitute a fake module without triggering
    # the signer's transitive imports at collection time.
    from app import operations  # noqa: WPS433

    return operations


def _check_operation_flags() -> None:
    ops = _load_operations_module()
    enabled = ops.OPERATION_ENABLED
    for name in _WRITE_OPS:
        # Missing entries default to False (safe). An explicit True is a hard stop.
        if enabled.get(name, False):
            raise PreconditionError(
                "WRITE_OPERATION_ENABLED",
                f"Refusing to run: write operation {name} is enabled.",
            )


def _check_mainnet_env_flags(env: Optional[Dict[str, str]] = None) -> None:
    e = env if env is not None else os.environ
    for name in _MAINNET_FLAGS:
        raw = e.get(name, "false")
        if str(raw).strip().lower() != "false":
            raise PreconditionError(
                "MAINNET_FLAG_ENABLED",
                f"Refusing to run: {name} must be false (got {raw!r}).",
            )


def _validate_ids(user_id: str, connection_id: str) -> None:
    if not _UUID_RE.match(user_id):
        raise PreconditionError("BAD_USER_ID", "user-id must be a UUID.")
    if not _UUID_RE.match(connection_id):
        raise PreconditionError("BAD_CONNECTION_ID", "connection-id must be a UUID.")


def _shared_secret(env: Optional[Dict[str, str]] = None) -> bytes:
    e = env if env is not None else os.environ
    v = e.get("SIGNER_SHARED_SECRET", "")
    if not v:
        raise PreconditionError(
            "MISSING_SIGNER_SHARED_SECRET",
            "SIGNER_SHARED_SECRET is not set in the container environment.",
        )
    return v.encode("utf-8")


def _sign_headers(
    path: str, body: bytes, secret: bytes, now: Optional[int] = None
) -> Dict[str, str]:
    ts = str(int(now if now is not None else time.time()))
    nonce = secrets.token_hex(16)
    msg = b"\n".join([ts.encode(), nonce.encode(), path.encode(), body])
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()
    return {
        "x-signer-timestamp": ts,
        "x-signer-nonce": nonce,
        "x-signer-signature": sig,
        "content-type": "application/json",
    }


def _http_call(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
) -> Tuple[int, Dict[str, Any]]:
    req = urllib.request.Request(url=url, method=method, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            raw = resp.read()
            status = resp.getcode()
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp is not None else b""
        status = exc.code
    except urllib.error.URLError as exc:
        raise SignerCallError(
            "SIGNER_UNREACHABLE",
            f"Local signer at {url} is unreachable: {exc.reason}",
        ) from None
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except json.JSONDecodeError:
        parsed = {"status": "error", "reject_reason": "MALFORMED_RESPONSE"}
    if not isinstance(parsed, dict):
        parsed = {"status": "error", "reject_reason": "MALFORMED_RESPONSE"}
    return status, parsed


def _signed_post(
    base_url: str,
    path: str,
    payload: Dict[str, Any],
    secret: bytes,
) -> Tuple[int, Dict[str, Any]]:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    headers = _sign_headers(path, body, secret)
    return _http_call("POST", base_url.rstrip("/") + path, headers, body)


def _healthz(base_url: str) -> Dict[str, Any]:
    status, parsed = _http_call(
        "GET", base_url.rstrip("/") + "/healthz", {"accept": "application/json"}
    )
    if status != 200 or parsed.get("ok") is not True:
        raise SignerCallError("HEALTHZ_FAILED", f"/healthz returned {status}")
    return {"status": "ok"}


def run_verification(
    user_id: str,
    connection_id: str,
    base_url: str = DEFAULT_BASE_URL,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Run all three checks; return a sanitized result dict.

    Raises PreconditionError / SignerCallError. Callers translate to exit codes.
    """
    _check_operation_flags()
    _check_mainnet_env_flags(env)
    _validate_ids(user_id, connection_id)
    secret = _shared_secret(env)

    health = _healthz(base_url)

    body = {"user_id": user_id, "exchange_connection_id": connection_id}

    v_status, v_body = _signed_post(base_url, "/v1/verify-credentials", body, secret)
    if v_status != 200:
        raise SignerCallError(
            "VERIFY_CREDENTIALS_HTTP_ERROR",
            f"/v1/verify-credentials returned {v_status}",
        )
    verify_sanitized = _sanitize(v_body)
    if not verify_sanitized.get("verified"):
        return {
            "healthz": health,
            "verify_credentials": verify_sanitized,
            "read_account": {"status": "skipped", "reject_reason": "NOT_VERIFIED"},
            "overall": "unverified",
        }

    a_status, a_body = _signed_post(base_url, "/v1/read-account", body, secret)
    if a_status != 200:
        raise SignerCallError(
            "READ_ACCOUNT_HTTP_ERROR",
            f"/v1/read-account returned {a_status}",
        )
    account_sanitized = _sanitize(a_body)

    overall = (
        "ready"
        if verify_sanitized.get("verified") and account_sanitized.get("status") == "ok"
        else "not_ready"
    )
    return {
        "healthz": health,
        "verify_credentials": verify_sanitized,
        "read_account": account_sanitized,
        "overall": overall,
    }


def _print_report(result: Dict[str, Any]) -> None:
    # json.dumps with a fixed indent — human-readable, no secrets by
    # construction (already passed through `_sanitize`).
    print(json.dumps(result, indent=2, sort_keys=True))


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_readiness",
        description="Owner-operated signer readiness verification.",
        allow_abbrev=False,
    )
    parser.add_argument("--user-id", required=True, dest="user_id")
    parser.add_argument("--connection-id", required=True, dest="connection_id")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_arg_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        # argparse already wrote a helpful message to stderr.
        return 1

    try:
        result = run_verification(args.user_id, args.connection_id)
    except PreconditionError as exc:
        print(
            json.dumps(
                {"status": "error", "reject_reason": exc.code, "message": exc.message},
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    except SignerCallError as exc:
        print(
            json.dumps(
                {"status": "error", "reject_reason": exc.code, "message": exc.message},
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2

    _print_report(result)
    if result.get("overall") == "ready":
        return 0
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
