"""Decrypt HMAC-family REST credentials from `public.exchange_credentials`.

Mirrors the format written by `supabase/functions/exchange-credentials`
(TypeScript, Deno):

    ciphertext = "v1:<base64(iv12)>:<base64(ct||authTag)>"
    key        = SHA-256(TURTLE_CREDENTIAL_ENCRYPTION_KEY_utf8)   # AES-256
    aead       = AES-256-GCM

The plaintext is a UTF-8 string (api_key / api_secret / passphrase). This
module NEVER logs the key, IV, or ciphertext body — errors are opaque
codes only. Return values live only in the calling stack frame.
"""
from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def key_fingerprint_prefix() -> str:
    """Return first 8 hex chars of sha256(sha256(key_utf8)). Safe to log.

    Deterministic per key value; identical Railway+Edge values yield the
    same prefix. Reveals nothing about the key.
    """
    secret = os.environ.get("TURTLE_CREDENTIAL_ENCRYPTION_KEY")
    if not secret:
        return "MISSING"
    raw = secret.encode("utf-8")
    if len(raw) < 32:
        return "SHORT"
    inner = hashlib.sha256(raw).digest()
    return hashlib.sha256(inner).hexdigest()[:8]


def selftest_field(packed: str) -> dict:
    """Attempt decrypt without returning plaintext. Metadata only."""
    info: dict = {"ok": False}
    if not isinstance(packed, str) or not packed:
        info["error"] = "BAD_CIPHERTEXT"; info["reason"] = "empty_or_non_string"
        return info
    parts = packed.split(":")
    info["prefix"] = parts[0] if parts else ""
    info["segments"] = len(parts)
    if len(parts) != 3 or parts[0] != "v1":
        info["error"] = "BAD_CIPHERTEXT"; info["reason"] = "format"
        return info
    try:
        iv = base64.b64decode(parts[1]); ct = base64.b64decode(parts[2])
    except Exception as exc:
        info["error"] = "BAD_CIPHERTEXT"; info["reason"] = "b64"
        info["exception_class"] = type(exc).__name__
        return info
    info["iv_len"] = len(iv); info["ct_len"] = len(ct)
    if len(iv) != 12:
        info["error"] = "BAD_CIPHERTEXT"; info["reason"] = "iv_len"; return info
    if len(ct) < 16:
        info["error"] = "BAD_CIPHERTEXT"; info["reason"] = "ct_too_short_for_tag"; return info
    try:
        _aead().decrypt(iv, ct, None)
    except ExchangeCredError as exc:
        info["error"] = str(exc); return info
    except Exception as exc:
        info["error"] = "DECRYPT_FAILED"
        info["exception_class"] = type(exc).__name__
        return info
    info["ok"] = True
    return info



class ExchangeCredError(Exception):
    """Opaque error class. Only carries stable, non-secret codes."""


def _aead() -> AESGCM:
    secret = os.environ.get("TURTLE_CREDENTIAL_ENCRYPTION_KEY")
    if not secret:
        raise ExchangeCredError("MISSING_ENCRYPTION_KEY")
    raw = secret.encode("utf-8")
    if len(raw) < 32:
        # Match the app-side guard: refuse short secrets.
        raise ExchangeCredError("SHORT_ENCRYPTION_KEY")
    key = hashlib.sha256(raw).digest()
    return AESGCM(key)


def decrypt_field(packed: str) -> str:
    if not isinstance(packed, str) or not packed:
        raise ExchangeCredError("BAD_CIPHERTEXT")
    parts = packed.split(":")
    if len(parts) != 3 or parts[0] != "v1":
        raise ExchangeCredError("BAD_CIPHERTEXT")
    try:
        iv = base64.b64decode(parts[1])
        ct = base64.b64decode(parts[2])
    except Exception:
        raise ExchangeCredError("BAD_CIPHERTEXT")
    if len(iv) != 12:
        raise ExchangeCredError("BAD_CIPHERTEXT")
    try:
        pt = _aead().decrypt(iv, ct, None)
    except Exception:
        # Any GCM failure — tag mismatch, key mismatch — collapses to one code.
        raise ExchangeCredError("DECRYPT_FAILED")
    return pt.decode("utf-8")


@dataclass(frozen=True)
class RestCredentials:
    """HMAC REST material for ApeX Omni account reads. Read-only surface.

    `omni_seed` is optional ApeX-generated STARK material. When present, live
    order submission uses it instead of the wallet-signature-derived bundle.
    """
    api_key: str
    api_secret: str
    passphrase: str
    omni_seed: str | None = None

    def scrub(self) -> None:
        # Best-effort: overwrite string references so subsequent frames
        # cannot re-read them by accident. Python cannot guarantee erasure
        # of interned string memory, but breaking the reference is cheap.
        object.__setattr__(self, "api_key", "")
        object.__setattr__(self, "api_secret", "")
        object.__setattr__(self, "passphrase", "")
        object.__setattr__(self, "omni_seed", None)


def decrypt_rest_credentials(row: dict) -> RestCredentials:
    """Decrypt the three REST fields from an `exchange_credentials` row.

    `row` must already have been fetched under a user_id ownership filter
    (see `db.SupabaseDbClient.fetch_rest_credentials_owned`). This
    function does NOT perform any authorization check.
    """
    try:
        api_key = decrypt_field(row["encrypted_api_key"])
        api_secret = decrypt_field(row["encrypted_api_secret"])
        passphrase_ct = row.get("encrypted_passphrase")
        passphrase = decrypt_field(passphrase_ct) if passphrase_ct else ""
        omni_ct = row.get("encrypted_omni_seed")
        omni_seed = decrypt_field(omni_ct) if omni_ct else None
    except KeyError:
        raise ExchangeCredError("CREDENTIAL_ROW_MALFORMED")
    return RestCredentials(api_key=api_key, api_secret=api_secret, passphrase=passphrase, omni_seed=omni_seed)
