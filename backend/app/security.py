from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
from typing import Any

from fastapi import Header, HTTPException


def _b64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _verified_session(token: str) -> dict[str, Any]:
    parts = token.split(".")
    secret = os.getenv("QUORUMARK_SESSION_SECRET", "").encode()
    if len(parts) != 3 or not secret:
        raise HTTPException(status_code=401, detail="Invalid application session")
    signing_input = f"{parts[0]}.{parts[1]}".encode()
    expected = base64.urlsafe_b64encode(hmac.new(secret, signing_input, hashlib.sha256).digest()).rstrip(b"=")
    if not hmac.compare_digest(expected, parts[2].encode()):
        raise HTTPException(status_code=401, detail="Invalid application session")
    try:
        claims = json.loads(_b64(parts[1]))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid application session") from exc
    if claims.get("aud") != "quorumark" or not claims.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid application session")
    try:
        expires_at = int(claims.get("exp", 0))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid application session") from exc
    if expires_at <= int(time.time()):
        raise HTTPException(status_code=401, detail="Expired application session")
    return claims


def require_verified_identity(
    authorization: str | None = Header(default=None),
    identity: str | None = Header(default=None, alias="x-quorumark-identity"),
) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return str(_verified_session(authorization[7:].strip())["sub"])
    if (os.getenv("QUORUMARK_PYTHON_ENVIRONMENT", "local").lower() == "local"
            and os.getenv("QUORUMARK_LOCAL_IDENTITY_TEST_MODE") == "true"
            and (os.getenv("PYTEST_CURRENT_TEST") or "pytest" in sys.modules)):
        value = (identity or "").strip()
        if value and len(value) <= 160:
            return value
    raise HTTPException(status_code=401, detail="Verified application session required")
