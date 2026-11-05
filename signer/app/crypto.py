"""Envelope encryption for ApeX signing material.

- Per-bundle 32-byte data-encryption key (DEK), random.
- DEK encrypts the JSON credential blob with AES-256-GCM.
- DEK is itself wrapped by the master wrapping key (AES-256-GCM) using
  authenticated additional data = f"{user_id}|{wallet}|{env}" so a
  ciphertext cannot be moved between users, wallets, or environments.
- Master wrapping keys are versioned (APEX_MASTER_WRAPPING_KEY_V{N}).
  Rotation writes a new active version; old versions stay decryptable
  until every bundle is re-wrapped and revoked.

Uses `cryptography.hazmat.primitives.ciphers.aead.AESGCM` — audited AEAD.
No hand-rolled crypto.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_utils import to_checksum_address


class CryptoConfigError(Exception):
    pass


def canonicalize_environment(environment: str) -> str:
    """Collapse live-environment aliases to the single AAD value."""
    env = str(environment or "").strip().lower()
    if env in {"mainnet", "production", "live"}:
        return "mainnet"
    if env == "testnet":
        return "testnet"
    raise ValueError("BAD_ENVIRONMENT")


def canonicalize_wallet_address(wallet_address: str) -> str:
    """Use EIP-55 checksum casing everywhere AAD is derived."""
    return to_checksum_address(str(wallet_address or "").strip())


def _wrapping_key(version: int) -> bytes:
    raw = os.environ.get(f"APEX_MASTER_WRAPPING_KEY_V{version}")
    if not raw:
        raise CryptoConfigError(f"MISSING_WRAPPING_KEY_V{version}")
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception:
        raise CryptoConfigError(f"WRAPPING_KEY_V{version}_NOT_BASE64")
    if len(key) != 32:
        raise CryptoConfigError(
            f"WRAPPING_KEY_V{version}_BAD_LENGTH_{len(key)}"
        )
    return key


def wrapping_key_fingerprint_prefix(version: int) -> str:
    """Safe identifier for comparing deployed wrapping keys without leaking them."""
    return hashlib.sha256(_wrapping_key(version)).hexdigest()[:16]


def _active_version() -> int:
    try:
        return int(os.environ.get("APEX_MASTER_WRAPPING_KEY_ACTIVE", "1"))
    except ValueError:
        raise CryptoConfigError("APEX_MASTER_WRAPPING_KEY_ACTIVE_INVALID")


def active_key_version() -> int:
    return _active_version()


@dataclass(frozen=True)
class EnvelopeContext:
    user_id: str
    wallet_address: str
    environment: str

    @classmethod
    def from_row(cls, row: dict) -> "EnvelopeContext":
        """Build AAD context from the persisted credential row only."""
        return cls(
            user_id=str(row["user_id"]),
            wallet_address=canonicalize_wallet_address(str(row["wallet_address"])),
            environment=canonicalize_environment(str(row["environment"])),
        )

    def canonical(self) -> "EnvelopeContext":
        return EnvelopeContext(
            user_id=str(self.user_id),
            wallet_address=canonicalize_wallet_address(self.wallet_address),
            environment=canonicalize_environment(self.environment),
        )

    def aad(self) -> bytes:
        c = self.canonical()
        return f"{c.user_id}|{c.wallet_address}|{c.environment}".encode("utf-8")

    def diagnostic_components(self) -> dict:
        c = self.canonical()
        return {
            "user_id": c.user_id,
            "wallet_address": c.wallet_address,
            "environment": c.environment,
        }


def _legacy_aad_candidates(ctx: EnvelopeContext) -> list[bytes]:
    """AAD variants accepted only for decrypting pre-canonical bundles.

    They do not cross the testnet/mainnet boundary; they only bridge prior
    checksum-vs-lowercase wallet casing and mainnet alias drift
    (mainnet|production|live).
    """
    wallet_values: list[str] = []
    for wallet in (
        str(ctx.wallet_address),
        canonicalize_wallet_address(ctx.wallet_address),
        str(ctx.wallet_address).lower(),
    ):
        if wallet not in wallet_values:
            wallet_values.append(wallet)

    canonical_env = canonicalize_environment(ctx.environment)
    env_values = [str(ctx.environment), canonical_env]
    if canonical_env == "mainnet":
        env_values.extend(["mainnet", "production", "live"])

    out: list[bytes] = []
    for wallet in wallet_values:
        for env in env_values:
            aad = f"{ctx.user_id}|{wallet}|{env}".encode("utf-8")
            if aad not in out:
                out.append(aad)
    return out


def _decode_envelope(packed_b64: str) -> dict:
    return json.loads(base64.b64decode(packed_b64).decode())


def envelope_shape(packed_b64: str) -> dict:
    """Return lengths/metadata only; never returns ciphertext bytes."""
    out = {"outer_b64_len": len(str(packed_b64 or ""))}
    raw = base64.b64decode(packed_b64, validate=True)
    out["outer_decoded_len"] = len(raw)
    packed = json.loads(raw.decode())
    out["json_keys"] = sorted(packed.keys())
    out["v"] = packed.get("v")
    out["kv"] = packed.get("kv")
    for key in ("dek_iv", "dek_ct", "body_iv", "body_ct"):
        val = str(packed.get(key, ""))
        out[f"{key}_b64_len"] = len(val)
        out[f"{key}_decoded_len"] = len(base64.b64decode(val, validate=True))
    return out


def _aad_to_components(aad: bytes) -> dict:
    try:
        user_id, wallet_address, environment = aad.decode("utf-8").split("|", 2)
    except Exception:
        return {"user_id": "<parse_failed>", "wallet_address": "<parse_failed>", "environment": "<parse_failed>"}
    return {"user_id": user_id, "wallet_address": wallet_address, "environment": environment}


def decrypt_selftest(packed_b64: str, ctx: EnvelopeContext) -> dict:
    """Sanitized decrypt diagnostic. Never returns decrypted plaintext."""
    result = {
        "ok": False,
        "aad_components": ctx.diagnostic_components(),
        "active_key_version": None,
        "key_version": None,
        "wrapping_key_fingerprint_prefix": None,
        "envelope_shape": None,
        "candidates": [],
        "exception_type": None,
        "failure_stage": None,
    }
    try:
        result["active_key_version"] = _active_version()
        result["envelope_shape"] = envelope_shape(packed_b64)
        packed = _decode_envelope(packed_b64)
        if packed.get("v") != 1:
            raise CryptoConfigError("UNSUPPORTED_ENVELOPE_VERSION")
        version = int(packed["kv"])
        result["key_version"] = version
        result["wrapping_key_fingerprint_prefix"] = wrapping_key_fingerprint_prefix(version)
        wrap = AESGCM(_wrapping_key(version))
        last_error: Exception | None = None
        for aad in _legacy_aad_candidates(ctx):
            candidate = {**_aad_to_components(aad), "ok": False, "failure_stage": "dek_unwrap", "exception_type": None}
            try:
                dek = wrap.decrypt(
                    base64.b64decode(packed["dek_iv"]),
                    base64.b64decode(packed["dek_ct"]),
                    aad,
                )
                candidate["ok"] = True
                candidate["failure_stage"] = None
                result["candidates"].append(candidate)
                try:
                    body = AESGCM(dek)
                    body.decrypt(
                        base64.b64decode(packed["body_iv"]),
                        base64.b64decode(packed["body_ct"]),
                        aad,
                    )
                    result["ok"] = True
                    result["failure_stage"] = None
                    result["exception_type"] = None
                    del dek
                    return result
                except Exception as exc:
                    result["failure_stage"] = "body_decrypt"
                    result["exception_type"] = type(exc).__name__
                    candidate["ok"] = False
                    candidate["failure_stage"] = "body_decrypt"
                    candidate["exception_type"] = type(exc).__name__
                    last_error = exc
                    del dek
                    break
            except Exception as exc:
                candidate["exception_type"] = type(exc).__name__
                result["candidates"].append(candidate)
                last_error = exc
        if last_error is not None:
            result["exception_type"] = type(last_error).__name__
            result["failure_stage"] = result["failure_stage"] or "dek_unwrap"
        return result
    except Exception as exc:
        result["exception_type"] = type(exc).__name__
        result["failure_stage"] = result["failure_stage"] or "envelope_or_key_setup"
        return result


def encrypt_bundle(plaintext: dict, ctx: EnvelopeContext) -> tuple[str, int]:
    """Encrypt a credential bundle. Returns (packed_ciphertext, key_version)."""
    version = _active_version()
    wrap = AESGCM(_wrapping_key(version))
    dek = AESGCM.generate_key(bit_length=256)
    body = AESGCM(dek)

    body_iv = os.urandom(12)
    dek_iv = os.urandom(12)
    body_ct = body.encrypt(body_iv, json.dumps(plaintext, sort_keys=True).encode(), ctx.aad())
    dek_ct = wrap.encrypt(dek_iv, dek, ctx.aad())

    packed = {
        "v": 1,
        "kv": version,
        "dek_iv": base64.b64encode(dek_iv).decode(),
        "dek_ct": base64.b64encode(dek_ct).decode(),
        "body_iv": base64.b64encode(body_iv).decode(),
        "body_ct": base64.b64encode(body_ct).decode(),
    }
    # Best-effort: overwrite dek reference before returning.
    del dek
    return base64.b64encode(json.dumps(packed).encode()).decode(), version


def decrypt_bundle(packed_b64: str, ctx: EnvelopeContext) -> dict:
    packed = _decode_envelope(packed_b64)
    if packed.get("v") != 1:
        raise CryptoConfigError("UNSUPPORTED_ENVELOPE_VERSION")
    version = int(packed["kv"])
    wrap = AESGCM(_wrapping_key(version))
    dek = None
    last_error: Exception | None = None
    for aad in _legacy_aad_candidates(ctx):
        try:
            dek = wrap.decrypt(
                base64.b64decode(packed["dek_iv"]),
                base64.b64decode(packed["dek_ct"]),
                aad,
            )
            decrypt_aad = aad
            break
        except Exception as exc:
            last_error = exc
    if dek is None:
        raise last_error or CryptoConfigError("DECRYPT_FAILED")
    body = AESGCM(dek)
    pt = body.decrypt(
        base64.b64decode(packed["body_iv"]),
        base64.b64decode(packed["body_ct"]),
        decrypt_aad,
    )
    result = json.loads(pt.decode())
    del dek, pt
    return result
