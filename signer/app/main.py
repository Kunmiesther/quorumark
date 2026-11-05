"""Private venue signer service — ApeX Omni plus isolated Aster path.

NOT production ready. See signer/README.md for the pre-enable checklist.

Every route:
  - requires HMAC + timestamp + nonce via `enforce_signed_request`;
  - validates a strict pydantic schema;
  - returns only `sanitize_response()` output;
  - never logs request bodies, headers, or crypto material.
"""
from __future__ import annotations

import decimal
import json
import asyncio
import logging
import os

from eth_account.messages import encode_defunct
from eth_account import Account
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .apex_message import build_onboarding_message
from .apex_signing import SigningError, derive_zk_credentials, public_from_seed, sign_order as zk_sign_order
from . import apex_omni_rest, aster_v3, aster_lifecycle
from .aster_campaign import AsterPlanError
from .aster_executor import AsterExecutionError, submit_aster_campaign
from .aster_exit import AsterExitError, close_position as close_aster_position
from .apex_omni_rest import RestError
from .crypto import (
    CryptoConfigError,
    EnvelopeContext,
    active_key_version,
    canonicalize_environment,
    canonicalize_wallet_address,
    decrypt_bundle,
    decrypt_selftest,
    wrapping_key_fingerprint_prefix,
)
from .exchange_creds import ExchangeCredError, decrypt_rest_credentials, key_fingerprint_prefix as rest_key_fingerprint_prefix, selftest_field as rest_selftest_field
from .idempotency import IdempotencyCache, IdempotencyConflict, request_fingerprint
from .operations import is_enabled
from .order_store import DRY_RUN_REASON, OrderStore, StoreError
from .security import enforce_signed_request, sanitize_response


# Silence access logs. Structured audit is a separate stream that MUST
# never include bodies or headers.
logging.getLogger("uvicorn.access").disabled = True
log = logging.getLogger("signer")
log.setLevel(logging.INFO)


def _signer_enabled() -> bool:
    return os.environ.get("APEX_MAINNET_SIGNER_ENABLED", "false").lower() == "true"


def _canary_enabled() -> bool:
    # Emitting a mainnet order requires an independent operator-controlled
    # compliance approval. A user declaration can never set this flag.
    return (
        os.environ.get("APEX_MAINNET_COMPLIANCE_APPROVED", "false").lower() == "true"
        and os.environ.get("APEX_MAINNET_CANARY_ENABLED", "false").lower() == "true"
    )


def _aster_automation_enabled() -> bool:
    """Independent venue switch; ApeX flags never authorize Aster orders."""
    return os.environ.get("ASTER_MAINNET_AUTOMATION_ENABLED", "false").lower() == "true"


def _capital_moves_enabled() -> bool:
    """Independent owner flag for same-account Funding ↔ Perps allocation."""
    return (
        _signer_enabled()
        and os.environ.get("APEX_MAINNET_CAPITAL_ENABLED", "false").lower() == "true"
    )


app = FastAPI(title="apex-omni-signer", docs_url=None, redoc_url=None, openapi_url=None)

# Refuse-only pre-check. A MISS never authorizes signing; the durable check
# against order_intents always runs. See app/idempotency.py.
_IDEM = IdempotencyCache()

# Injected in tests. Built lazily so import never requires live credentials.
_DB = None
_CREDS = None


def _db():
    """Service-role-equivalent DB for /v1/orders (credential lookup, halted
    check, audit inserts).

    Default backend routes every service-role call through the signed
    `worker-ingest` edge function — the Railway signer cannot read
    SUPABASE_SERVICE_ROLE_KEY on Lovable Cloud. Legacy direct-service-role
    behaviour stays available for local tests via
    `SIGNER_USE_LEGACY_SERVICE_ROLE_DB=true`.
    """
    global _DB
    if _DB is None:
        if os.environ.get("SIGNER_USE_LEGACY_SERVICE_ROLE_DB", "").lower() == "true":
            from .db import SupabaseDbClient
            _DB = SupabaseDbClient()
        else:
            from .db import WorkerIngestBackedDbClient
            _DB = WorkerIngestBackedDbClient()
    return _DB


def _caller_db(caller_jwt: str):
    """Caller-scoped DB client for /v1/onboard writes. RLS enforces
    auth.uid() = user_id — no service-role key required on the signer host.

    Tests may pre-set `main._DB = <fake>` to bypass the real client; the
    injected fake satisfies the onboarding protocol
    (find_active_credential_for_scope / revoke_credential / insert_credential
    / insert_credential_audit).

    Production backends (WorkerIngestBackedDbClient, SupabaseDbClient) do NOT
    satisfy that protocol — the worker-ingest backend intentionally raises
    NotImplementedError on the onboarding methods because service-role writes
    to apex_execution_credentials are not exposed through the edge function.
    If `_db()` has already memoized one of those, ignore it here and build a
    real caller-scoped client so /v1/onboard keeps working alongside /v1/orders.
    """
    from .db import WorkerIngestBackedDbClient, SupabaseDbClient
    if _DB is not None and not isinstance(_DB, (WorkerIngestBackedDbClient, SupabaseDbClient)):
        return _DB
    from .db_caller import CallerScopedDbClient
    return CallerScopedDbClient(caller_jwt=caller_jwt)



def _creds_reader():
    """Credential reader for /v1/verify-credentials and /v1/read-account.

    Backed by the signed `worker-ingest` edge function — no service-role key
    required on the signer host. Tests may set `main._CREDS = <fake>`."""
    global _CREDS
    if _CREDS is None:
        from .db import WorkerIngestBackedCredsReader
        _CREDS = WorkerIngestBackedCredsReader()
    return _CREDS


@app.get("/healthz")
async def healthz() -> dict:
    # Deliberately minimal — no version, no build info, no env leak.
    # `live_test_mode` is a boolean policy flag (not a secret) and is the only
    # way to confirm from outside that the deployed container is running the
    # owner's no-SL/no-TP test phase.
    return {"ok": True, "live_test_mode": live_test_mode_enabled(),
            "aster_automation_enabled": _aster_automation_enabled() and is_enabled("CREATE_ORDER"),
            "apex_automation_enabled": _signer_enabled() and _canary_enabled() and is_enabled("CREATE_ORDER")}


@app.post("/v1/last-rejects")
async def last_rejects(request: Request) -> JSONResponse:
    """Owner diagnostic: the last few venue/SDK rejects, REDACTED.

    HMAC-authenticated exactly like every other /v1 route. Returns only
    `code` + identifier-stripped, bounded text (see
    `venue_reject.redact_venue_text`) so an unclassified `code=3` can be
    diagnosed without shipping raw venue bodies to the ledger. In-memory
    only; nothing here is persisted.
    """
    await enforce_signed_request(request)
    from .venue_reject import recent_raw_rejects, signer_revision
    return JSONResponse({
        "signer_revision": signer_revision(),
        "live_test_mode": live_test_mode_enabled(),
        "rejects": recent_raw_rejects(),
    })



class OnboardBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    wallet_address: str = Field(pattern=r"^0x[a-fA-F0-9]{40}$")
    environment: str = Field(pattern=r"^(mainnet|testnet)$")
    signature: str = Field(min_length=10, max_length=200)
    # Caller's Supabase JWT — forwarded by the broker inside the HMAC-covered
    # body. The signer uses it to write apex_execution_credentials rows as
    # the caller (RLS enforced), removing the need for SUPABASE_SERVICE_ROLE_KEY
    # on the signer host for the onboarding path.
    caller_jwt: str = Field(min_length=20, max_length=4096)


class DecryptSelfTestBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    environment: str = Field(pattern=r"^(mainnet|testnet|production|live)$")


@app.post("/v1/onboard")
async def onboard(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = OnboardBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")

    # F2 (defense-in-depth): decode the caller JWT and cross-check that its
    # `sub` matches the body's `user_id` BEFORE the caller-scoped INSERT.
    # The broker already verifies the JWT against Supabase JWKS + issuer, and
    # the caller_jwt is HMAC-covered by SIGNER_SHARED_SECRET on this hop, so a
    # non-verifying local decode is sufficient here — RLS on
    # `apex_execution_credentials` remains the belt behind these suspenders.
    from .security import decode_jwt_sub_unverified
    jwt_sub = decode_jwt_sub_unverified(body.caller_jwt)
    if not jwt_sub or jwt_sub != body.user_id:
        raise HTTPException(status_code=403, detail="IDENTITY_MISMATCH")

    # Recover the signer address from the canonical ApeX onboarding message.
    # `environment` MUST be threaded through: the header is the first line of
    # the signed bytes ("ApeX Omni Mainnet" vs "ApeX Omni Testnet"), so a
    # testnet onboarding validated against the mainnet message recovers a
    # DIFFERENT address and derives a DIFFERENT zk key. Omitting it silently
    # defaulted every environment to mainnet.
    canonical_wallet = canonicalize_wallet_address(body.wallet_address)
    canonical_environment = canonicalize_environment(body.environment)
    message = build_onboarding_message(canonical_wallet, canonical_environment)
    # Normalize signature shape before recovery so we can emit concrete
    # error subcodes instead of an opaque INVALID_SIGNATURE. Some wallets
    # strip the 0x prefix or upper-case; some smart wallets return
    # EIP-1271 blobs that aren't 65-byte ECDSA sigs at all (unsupported
    # for ApeX onboarding — the zk seed derivation requires the raw
    # personal_sign output).
    raw_sig = (body.signature or "").strip()
    hex_sig = raw_sig[2:] if raw_sig.lower().startswith("0x") else raw_sig
    if len(hex_sig) != 130:
        raise HTTPException(
            status_code=400,
            detail=f"INVALID_SIGNATURE_LENGTH_{len(hex_sig)}",
        )
    try:
        int(hex_sig, 16)
    except ValueError:
        raise HTTPException(status_code=400, detail="INVALID_SIGNATURE_HEX")
    normalized_sig = "0x" + hex_sig
    try:
        recovered = Account.recover_message(
            encode_defunct(text=message), signature=normalized_sig
        )
    except Exception:
        raise HTTPException(status_code=400, detail="INVALID_SIGNATURE")
    if recovered.lower() != canonical_wallet.lower():
        # Truncated address tails only — not secrets, but enough to see
        # whether the wallet signed with a different account or against
        # the wrong environment header.
        raise HTTPException(
            status_code=400,
            detail=(
                "SIGNATURE_ADDRESS_MISMATCH:"
                f"recovered_ends_{recovered.lower()[-6:]}_"
                f"expected_ends_{canonical_wallet.lower()[-6:]}"
            ),
        )
    body = body.model_copy(update={
        "signature": normalized_sig,
        "wallet_address": canonical_wallet,
        "environment": canonical_environment,
    })

    # === Derive zkLink STARK material and persist an encrypted bundle. ==
    # `seeds` is the wallet's EIP-191 signature (see apex_signing.py). It
    # is PRIVATE — it lives only in this stack frame, gets envelope-
    # encrypted immediately, and is scrubbed before we return. It is never
    # logged, never returned, never placed in a dict that reaches
    # `sanitize_response`.
    try:
        zk = derive_zk_credentials(body.signature)
    except SigningError as e:
        raise HTTPException(status_code=400, detail=e.code)

    ctx = EnvelopeContext(user_id=body.user_id, wallet_address=body.wallet_address, environment=body.environment)
    try:
        from .crypto import encrypt_bundle
        packed, key_version = encrypt_bundle(
            {"seeds": zk.seeds, "l2_key": zk.l2_key, "pub_key_hash": zk.pub_key_hash},
            ctx,
        )
        log.info(
            "credential_encrypt_aad user_id=%s wallet_address=%s environment=%s key_version=%s active_key_version=%s wrapping_key_fingerprint_prefix=%s",
            ctx.diagnostic_components()["user_id"],
            ctx.diagnostic_components()["wallet_address"],
            ctx.diagnostic_components()["environment"],
            key_version,
            active_key_version(),
            wrapping_key_fingerprint_prefix(key_version),
        )
    except CryptoConfigError as ce:
        # Surface the specific config subcode (MISSING_WRAPPING_KEY_V1,
        # WRAPPING_KEY_V1_NOT_BASE64, WRAPPING_KEY_V1_BAD_LENGTH_N,
        # APEX_MASTER_WRAPPING_KEY_ACTIVE_INVALID) so the owner can fix it.
        raise HTTPException(status_code=500, detail=f"ENCRYPTION_UNCONFIGURED:{ce}")
    except Exception as e:
        log.exception("encrypt_bundle_failed")
        raise HTTPException(
            status_code=500, detail=f"ENCRYPTION_FAILED:{type(e).__name__}"
        )
    finally:
        # Scrub before any DB call: an exception between here and insert
        # must not leave seeds resident.
        zk_seeds = zk.seeds  # kept only as the source for `packed`; already encrypted
        del zk_seeds

    fingerprint = zk.fingerprint()

    # Idempotency: revoke-and-replace. The unique partial index
    # apex_execution_credentials_one_active enforces one active bundle per
    # (user, wallet, connection, environment) — inserting without first
    # revoking would raise a 23505. We prefer revoke-and-replace over
    # refuse-and-return because re-onboarding is legitimate (owner rotates
    # wallets, recovers from a lost session, re-signs after key rotation).
    # Onboarding writes go through a caller-scoped Supabase client (RLS
    # enforces auth.uid() = user_id on apex_execution_credentials and
    # apex_credential_audit). No service-role key needed on the signer host.
    try:
        db = _caller_db(body.caller_jwt)
    except CryptoConfigError as ce:
        raise HTTPException(status_code=500, detail=f"DB_UNCONFIGURED:{ce}")
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"DB_UNCONFIGURED:{type(e).__name__}:{str(e)[:120]}",
        )
    try:
        existing = db.find_active_credential_for_scope(
            user_id=body.user_id,
            exchange_connection_id=body.exchange_connection_id,
            environment=body.environment,
            wallet_address=body.wallet_address,
        )
    except Exception as e:
        log.exception("credential_lookup_failed")
        raise HTTPException(
            status_code=500,
            detail=f"CREDENTIAL_LOOKUP_FAILED:{type(e).__name__}:{str(e)[:120]}",
        )
    if existing:
        try:
            db.revoke_credential(existing["id"])
            db.insert_credential_audit({
                "credential_id": existing["id"],
                "user_id": body.user_id,
                "event": "revoked",
                "detail": {
                    "environment": body.environment,
                    "credential_fingerprint": existing.get("credential_fingerprint"),
                    "encryption_key_version": existing.get("encryption_key_version"),
                    "reason": "reonboarded",
                },
            })
        except Exception as e:
            log.exception("credential_revoke_failed")
            raise HTTPException(
                status_code=500,
                detail=f"CREDENTIAL_REVOKE_FAILED:{type(e).__name__}:{str(e)[:120]}",
            )

    try:
        inserted = db.insert_credential({
            "user_id": body.user_id,
            "exchange_connection_id": body.exchange_connection_id,
            "environment": body.environment,
            "wallet_address": body.wallet_address,
            "encrypted_credentials": packed,
            "encryption_key_version": key_version,
            "credential_fingerprint": fingerprint,
            "active": True,
        })
    except Exception as e:
        log.exception("credential_persist_failed")
        raise HTTPException(
            status_code=500,
            detail=f"CREDENTIAL_PERSIST_FAILED:{type(e).__name__}:{str(e)[:120]}",
        )


    credential_id = inserted.get("id") if isinstance(inserted, dict) else None
    try:
        db.insert_credential_audit({
            "credential_id": credential_id,
            "user_id": body.user_id,
            "event": "created",
            "detail": {
                "environment": body.environment,
                "credential_fingerprint": fingerprint,
                "encryption_key_version": key_version,
                "replaced_prior": bool(existing),
            },
        })
    except Exception:
        # Audit failure is non-fatal for the caller — the credential is
        # already stored — but must be visible in host logs.
        log.warning("credential_audit_insert_failed")

    # Scrub the derived object entirely before returning.
    zk = None  # noqa: F841
    del zk
    packed = None  # noqa: F841
    del packed

    return JSONResponse(sanitize_response({
        "status": "onboarded",
        "credential_id": credential_id,
        "credential_fingerprint": fingerprint,
        "environment": body.environment,
    }), status_code=200)


@app.post("/v1/decrypt-selftest")
async def decrypt_selftest_endpoint(request: Request) -> JSONResponse:
    """Read-only owner/HMAC-gated decrypt diagnostic.

    Returns only metadata, AAD components, key fingerprints, envelope lengths,
    and exception class names. It never returns decrypted plaintext, seeds, raw
    ciphertext, nonces, tags, or key material.
    """
    body_bytes = await enforce_signed_request(request)
    try:
        body = DecryptSelfTestBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    env = canonicalize_environment(body.environment)
    cred = _db().find_active_credential_for_connection(
        user_id=body.user_id,
        exchange_connection_id=body.exchange_connection_id,
        environment=env,
    )
    if not cred:
        return JSONResponse({
            "status": "missing_credential",
            "credential_lookup": {
                "user_id": body.user_id,
                "exchange_connection_id": body.exchange_connection_id,
                "environment": env,
            },
        }, status_code=404)

    ctx = EnvelopeContext.from_row(cred)
    diag = decrypt_selftest(cred["encrypted_credentials"], ctx)
    return JSONResponse({
        "status": "ok" if diag.get("ok") else "failed",
        "credential": {
            "id": cred.get("id"),
            "fingerprint": cred.get("credential_fingerprint"),
            "wallet_address": cred.get("wallet_address"),
            "environment": cred.get("environment"),
            "encryption_key_version": cred.get("encryption_key_version"),
            "active": cred.get("active"),
            "revoked_at": cred.get("revoked_at"),
        },
        "diagnostic": diag,
    }, status_code=200)


@app.post("/v1/rest-decrypt-selftest")
async def rest_decrypt_selftest_endpoint(request: Request) -> JSONResponse:
    """Read-only REST-credential decrypt diagnostic.

    Tests the `exchange_credentials` (HMAC REST) path — the actual source
    of `DECRYPT_FAILED` on `/v1/orders`. Never returns plaintext, IV, or
    ciphertext bytes; only lengths, prefixes, exception class names, and
    a safe fingerprint of the wrapping key.
    """
    body_bytes = await enforce_signed_request(request)
    try:
        body = ConnectionReadBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    row = _creds_reader().fetch_rest_credentials_owned(
        body.user_id, body.exchange_connection_id
    )
    if not row:
        return JSONResponse({
            "status": "missing_credential",
            "key_fingerprint": rest_key_fingerprint_prefix(),
            "lookup": {
                "user_id": body.user_id,
                "exchange_connection_id": body.exchange_connection_id,
            },
        }, status_code=404)

    fields = {}
    all_ok = True
    for name in ("encrypted_api_key", "encrypted_api_secret", "encrypted_passphrase"):
        ct = row.get(name)
        if ct is None:
            fields[name] = {"present": False}
            continue
        diag = rest_selftest_field(ct)
        fields[name] = {"present": True, **diag}
        if not diag.get("ok"):
            all_ok = False

    return JSONResponse({
        "status": "ok" if all_ok else "failed",
        "key_fingerprint": rest_key_fingerprint_prefix(),
        "row": {
            "id": row.get("id"),
            "exchange": row.get("exchange"),
            "encryption_version": row.get("encryption_version"),
        },
        "fields": fields,
    }, status_code=200)



class RegisterAccountBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    environment: str = Field(pattern=r"^(mainnet|testnet|production|live)$")
    caller_jwt: str = Field(min_length=20, max_length=4096)
    chain_id: int | None = None


@app.post("/v1/register-account")
async def register_account_endpoint(request: Request) -> JSONResponse:
    """Register a fresh ApeX account for the caller's wallet and mint REST
    API credentials.

    Requires an existing active STARK bundle in `apex_execution_credentials`
    for this (user, connection, environment) — i.e. onboarding must already
    have run. Uses the decrypted seeds to sign ApeX's onboarding challenge
    (`/api/v3/generate-nonce` + `/api/v3/new-onboarding`) and returns the
    freshly minted `apiKey.{key,secret,passphrase}` INSIDE the HMAC-signed
    response body. The edge function is responsible for encrypting under
    `TURTLE_CREDENTIAL_ENCRYPTION_KEY` and writing `exchange_credentials`.

    Idempotent on ApeX's side: re-registering an already-registered wallet
    returns the same account with existing apiKey material.
    """
    body_bytes = await enforce_signed_request(request)
    try:
        body = RegisterAccountBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")

    from .security import decode_jwt_sub_unverified
    jwt_sub = decode_jwt_sub_unverified(body.caller_jwt)
    if not jwt_sub or jwt_sub != body.user_id:
        raise HTTPException(status_code=403, detail="IDENTITY_MISMATCH")

    env = canonicalize_environment(body.environment)
    cred = _db().find_active_credential_for_connection(
        user_id=body.user_id,
        exchange_connection_id=body.exchange_connection_id,
        environment=env,
    )
    if not cred:
        raise HTTPException(status_code=404, detail="STARK_CREDENTIAL_MISSING")

    try:
        bundle = decrypt_bundle(cred["encrypted_credentials"], EnvelopeContext.from_row(cred))
    except (CryptoConfigError, Exception):
        raise HTTPException(status_code=500, detail="DECRYPT_FAILED")

    try:
        seeds = bundle["seeds"]
        l2_key = bundle.get("l2_key") or bundle.get("l2Key")
    except (KeyError, TypeError):
        raise HTTPException(status_code=500, detail="CREDENTIAL_BUNDLE_MALFORMED")
    if not isinstance(seeds, str) or not isinstance(l2_key, str):
        raise HTTPException(status_code=500, detail="CREDENTIAL_BUNDLE_MALFORMED")

    wallet = canonicalize_wallet_address(cred.get("wallet_address") or "")
    if not wallet:
        raise HTTPException(status_code=500, detail="WALLET_ADDRESS_MISSING")

    from .apex_register import register_account as _register, RegisterError
    try:
        acct = _register(
            environment=env,
            l2_key=l2_key,
            seeds_hex=seeds,
            ethereum_address=wallet,
            chain_id=body.chain_id,
        )
    except RegisterError as e:
        # Surface the stable subcode so the edge/UI can render a helpful
        # message. Never carries response bodies.
        raise HTTPException(status_code=502, detail=e.code)
    finally:
        # Best-effort scrub. `bundle` will be GC'd; wipe the reference.
        bundle = None  # noqa: F841
        del bundle
        seeds = None  # noqa: F841
        del seeds

    log.info(
        "register_account_success user_id=%s connection_id=%s environment=%s meta=%s",
        body.user_id, body.exchange_connection_id, env, acct.sanitized(),
    )

    # The response body is HMAC-covered on the return leg by TLS + the
    # signer's origin auth. Edge caller must NEVER forward these fields
    # to the browser.
    return JSONResponse({
        "status": "registered",
        "connection_id": body.exchange_connection_id,
        "environment": env,
        "api_key": acct.api_key,
        "api_secret": acct.api_secret,
        "passphrase": acct.passphrase,
        "account_id": acct.account_id,
    }, status_code=200)



class SignOrderBody(BaseModel):
    credential_id: str
    client_order_id: str
    symbol: str
    side: str = Field(pattern=r"^(BUY|SELL)$")
    order_type: str = Field(pattern=r"^(MARKET|LIMIT)$")
    size: str
    price: str
    reduce_only: bool = False
    is_live: bool = False
    # ApeX Omni STARK params — required for real zkLink signing (dry-run and live).
    account_id: int
    sub_account_id: int
    slot_id: int
    nonce: int
    l2_pair_id: int
    decimals: int
    taker_fee_rate: str
    maker_fee_rate: str



@app.post("/v1/sign-order")
async def sign_order(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = SignOrderBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if body.is_live and not _canary_enabled():
        raise HTTPException(status_code=403, detail="CANARY_DISABLED")
    # OPERATION_ENABLED is the sole authority (app/operations.py). Even with
    # both env flags on, a disabled operation is refused here.
    if not is_enabled("SIGN_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    payload = body.model_dump()
    fp = request_fingerprint(payload)
    try:
        # Cheap refusal only. Never an authorization to sign.
        _IDEM.check(body.client_order_id, fp)
    except IdempotencyConflict:
        raise HTTPException(status_code=409, detail="IDEMPOTENCY_CONFLICT")

    store = OrderStore(_db())

    # Credential FIRST: it is the only source of user_id, and it must be
    # ACTIVE and NON-REVOKED — enforced in the query, not by an `if` here.
    cred = _db().fetch_active_credential(body.credential_id)
    if not cred:
        raise HTTPException(status_code=403, detail="CREDENTIAL_REVOKED_OR_MISSING")

    # Durable authority: the intent must exist and be signable.
    try:
        intent = store.load_signable_intent(cred["user_id"], body.client_order_id)
    except StoreError as e:
        raise HTTPException(status_code=409, detail=e.code)

    # The intent and the credential must belong to the same environment.
    # Cross-wiring would sign a mainnet order with testnet material.
    if intent.environment != cred["environment"]:
        store.audit(intent, "rejected", reject_reason="ENVIRONMENT_MISMATCH")
        raise HTTPException(status_code=409, detail="ENVIRONMENT_MISMATCH")

    try:
        bundle = decrypt_bundle(cred["encrypted_credentials"], EnvelopeContext.from_row(cred))
    except (CryptoConfigError, Exception):
        # Never surface crypto internals — they can echo key material.
        store.audit(intent, "rejected", reject_reason="DECRYPT_FAILED")
        raise HTTPException(status_code=500, detail="DECRYPT_FAILED")

    store.mark_signing(intent)
    try:
        seeds = bundle["seeds"]
    except (KeyError, TypeError):
        raise HTTPException(status_code=500, detail="CREDENTIAL_BUNDLE_MALFORMED")

    # is_live=false: run the REAL zkLink signing function, DISCARD the
    # signature, submit nothing. Terminal dry run. Owner ruling 2026-07-17.
    if not body.is_live:
        try:
            signed = zk_sign_order(
                seeds=seeds,
                account_id=body.account_id,
                sub_account_id=body.sub_account_id,
                slot_id=body.slot_id,
                nonce=body.nonce,
                l2_pair_id=body.l2_pair_id,
                size=body.size,
                price=body.price,
                decimals=body.decimals,
                is_buy=(body.side == "BUY"),
                taker_fee_rate=body.taker_fee_rate,
                maker_fee_rate=body.maker_fee_rate,
                client_order_id=body.client_order_id,
            )
        except SigningError as e:
            store.audit(intent, "rejected", reject_reason=e.code)
            raise HTTPException(status_code=500, detail=e.code)
        finally:
            # Seeds are private to this stack frame — never place in a dict,
            # never log, never persist. Best-effort scrub before we return.
            seeds = None  # noqa: F841
            del seeds
        # Discard the signature. It NEVER leaves this frame. Not returned,
        # not audited, not logged. `signed.signature` is proof the real
        # signer ran; scrubbing it is proof nothing was transmitted.
        assert signed.signature  # real signature produced
        signed = None  # noqa: F841
        del signed

        store.mark_dry_run(intent)
        _IDEM.record(body.client_order_id, fp, "dry_run")
        return JSONResponse(sanitize_response({
            "status": "signed_not_submitted",
            "reject_reason": DRY_RUN_REASON,
        }), status_code=200)


    # Unreachable while CANARY is off and SIGN_ORDER is disabled. Submission
    # is deliberately NOT implemented here.
    raise HTTPException(status_code=403, detail="CANARY_DISABLED")


class RevokeBody(BaseModel):
    credential_id: str


@app.post("/v1/revoke")
async def revoke(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = RevokeBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    cred = _db().fetch_active_credential(body.credential_id)
    if not cred:
        # Already revoked or absent. Idempotent: revoking twice is not an error.
        return JSONResponse(sanitize_response({"status": "already_revoked"}), status_code=200)

    ok = _db().revoke_credential(body.credential_id)
    if not ok:
        raise HTTPException(status_code=409, detail="REVOKE_CONFLICT")

    # Metadata only. `event` is CHECK-constrained to the allowed literals.
    _db().insert_credential_audit({
        "credential_id": body.credential_id,
        "user_id": cred["user_id"],
        "event": "revoked",
        "detail": {
            "environment": cred["environment"],
            "credential_fingerprint": cred["credential_fingerprint"],
            "encryption_key_version": cred["encryption_key_version"],
            "reason": "owner_requested",
        },
    })
    return JSONResponse(sanitize_response({
        "status": "revoked",
        "credential_id": body.credential_id,
        "credential_fingerprint": cred["credential_fingerprint"],
    }), status_code=200)


# ---------------------------------------------------------------------------
# Read-only endpoints — VERIFY_CREDENTIALS and READ_ACCOUNT
# ---------------------------------------------------------------------------
#
# These endpoints NEVER submit an order, NEVER touch STARK / zkLink material,
# and NEVER return decrypted secrets. They operate exclusively on
# `public.exchange_credentials` — the HMAC REST material — decrypted through
# `app.exchange_creds.decrypt_field`, held only in the current stack frame,
# and scrubbed before the handler returns.
#
# Preconditions enforced in-order:
#   1. HMAC request signature + timestamp + nonce (`enforce_signed_request`).
#   2. Operation flag ON (`operations.is_enabled(...)`). Sole authority.
#   3. Ownership: the `exchange_connection_id` in the body must belong to
#      the caller's `user_id` — enforced in the DB query, not by an `if`.
#   4. Connection status not disconnected/disabled (same query).
#   5. Upstream call goes out with a hard 8-second timeout.
#
# Response fields are shaped explicitly and pass through `sanitize_response`.

class ConnectionReadBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)


def _fetch_owned_rest_row(body: ConnectionReadBody) -> dict:
    row = _creds_reader().fetch_rest_credentials_owned(body.user_id, body.exchange_connection_id)
    if not row:
        # Same code for "not owned" and "not found" — do not leak existence.
        raise HTTPException(status_code=404, detail="CONNECTION_NOT_FOUND")
    if row.get("exchange") not in ("apex_omni", "apex_omni_testnet", "aster"):
        raise HTTPException(status_code=400, detail="UNSUPPORTED_EXCHANGE")
    return row


def _decrypt_or_400(row: dict):
    try:
        return decrypt_rest_credentials(row)
    except ExchangeCredError:
        # Never surface the underlying code — could echo config detail.
        raise HTTPException(status_code=500, detail="DECRYPT_FAILED")


def _aster_credentials(creds) -> aster_v3.AsterCredentials:
    """Map the encrypted generic credential columns to Aster's agent model.

    api_key=master wallet, api_secret=agent private key,
    passphrase=approved agent wallet.  The values never leave the signer.
    """
    return aster_v3.AsterCredentials(
        user=creds.api_key,
        private_key=creds.api_secret,
        signer=creds.passphrase,
    ).validated()


@app.post("/v1/verify-credentials")
async def verify_credentials(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ConnectionReadBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not is_enabled("VERIFY_CREDENTIALS"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    row = _fetch_owned_rest_row(body)
    creds = _decrypt_or_400(row)
    try:
        try:
            if row["exchange"] == "aster":
                summary = aster_v3.account_summary(_aster_credentials(creds))
                if summary["permissions"]["trade"] is not True:
                    raise aster_v3.AsterV3Error("ASTER_TRADING_NOT_ALLOWED")
            else:
                apex_omni_rest.verify_credentials(
                    environment=row["environment"],
                    api_key=creds.api_key,
                    api_secret=creds.api_secret,
                    passphrase=creds.passphrase,
                )
        except (RestError, aster_v3.AsterV3Error) as e:
            # Stable codes only — never a response body or header.
            return JSONResponse(sanitize_response({
                "status": "unverified",
                "reject_reason": e.args[0] if e.args else "UPSTREAM_ERROR",
                "connection_id": body.exchange_connection_id,
                "environment": row["environment"],
                "exchange": row["exchange"],
                "verified": False,
            }), status_code=200)

        # Best-effort touch; failure does not change the return. Routed via
        # the credential reader (no-op on the worker-ingest backend — audit
        # is source of truth).
        try:
            _creds_reader().touch_connection_verified(body.exchange_connection_id, body.user_id)
        except Exception:
            pass
        return JSONResponse(sanitize_response({
            "status": "verified",
            "connection_id": body.exchange_connection_id,
            "environment": row["environment"],
            "exchange": row["exchange"],
            "verified": True,
        }), status_code=200)
    finally:
        creds.scrub()


@app.post("/v1/read-account")
async def read_account(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ConnectionReadBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not is_enabled("READ_ACCOUNT"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    row = _fetch_owned_rest_row(body)
    creds = _decrypt_or_400(row)
    try:
        try:
            snap = (
                aster_v3.account_summary(_aster_credentials(creds))
                if row["exchange"] == "aster"
                else apex_omni_rest.read_account(
                    environment=row["environment"],
                    api_key=creds.api_key,
                    api_secret=creds.api_secret,
                    passphrase=creds.passphrase,
                )
            )
        except (RestError, aster_v3.AsterV3Error) as e:
            return JSONResponse(sanitize_response({
                "status": "error",
                "reject_reason": e.args[0] if e.args else "UPSTREAM_ERROR",
                "connection_id": body.exchange_connection_id,
                "environment": row["environment"],
                "exchange": row["exchange"],
            }), status_code=200)
        return JSONResponse(sanitize_response({
            "status": "ok",
            "connection_id": body.exchange_connection_id,
            "environment": row["environment"],
            "exchange": row["exchange"],
            "account": snap if row["exchange"] == "aster" else snap.as_sanitized(),
        }), status_code=200)
    finally:
        creds.scrub()


class SynFuturesReconcileBody(BaseModel):
    model_config = {"extra": "forbid"}
    user_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    exchange_connection_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")


@app.post("/v1/synfutures/reconcile-orders")
async def synfutures_reconcile_endpoint(request: Request) -> JSONResponse:
    from .synfutures_reconciliation import BaseReadRpc, SynFuturesObservationError, reconcile_connection
    raw = await enforce_signed_request(request)
    try:
        body = SynFuturesReconcileBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not is_enabled("RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    def read():
        # The signed ledger proxy checks connection ownership and venue. No
        # exchange credential/key is needed or decrypted for on-chain recovery.
        return reconcile_connection(db=_db(), rpc=BaseReadRpc(), user_id=body.user_id,
                                    connection_id=body.exchange_connection_id)
    try:
        result = await asyncio.to_thread(read)
    except SynFuturesObservationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    except Exception:
        raise HTTPException(status_code=503, detail="SYNFUTURES_RECONCILIATION_UNAVAILABLE") from None
    return JSONResponse(sanitize_response({"status": result["status"], "exchange": "synfutures",
        "environment": "mainnet", "connection_id": body.exchange_connection_id,
        "reconciliation_required": result["reconciliation_required"]}))


class SynFuturesProtectBody(SynFuturesReconcileBody):
    entries_paused: bool = Field(default=True, strict=True)


class SynFuturesRecoveryBody(SynFuturesReconcileBody):
    symbol: str = Field(pattern=r"^(BTC|ETH)-USDC$")
    slippage_bps: int = Field(strict=True, ge=1, le=1000)


@app.post("/v1/synfutures/protect")
async def synfutures_protect_endpoint(request: Request) -> JSONResponse:
    from .synfutures_account import BaseAccountRpc
    from .synfutures_execution import monitor_connection
    from .synfutures_entry import SynFuturesEntryError
    raw = await enforce_signed_request(request)
    try:
        body = SynFuturesProtectBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    try:
        result = await asyncio.to_thread(monitor_connection, db=_db(), rpc=BaseAccountRpc(),
            user_id=body.user_id, connection_id=body.exchange_connection_id, entries_paused=body.entries_paused)
    except SynFuturesEntryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    except Exception:
        raise HTTPException(status_code=503, detail="SYNFUTURES_MONITOR_UNAVAILABLE") from None
    return JSONResponse(sanitize_response(result))


@app.post("/v1/synfutures/positions")
async def synfutures_positions_endpoint(request: Request) -> JSONResponse:
    from .synfutures_account import BaseAccountRpc
    from .synfutures_positions import read_positions
    from .synfutures_entry import SynFuturesEntryError
    raw = await enforce_signed_request(request)
    try:
        body = SynFuturesReconcileBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    try:
        snapshot = await asyncio.to_thread(read_positions, db=_db(), rpc=BaseAccountRpc(),
            user_id=body.user_id, connection_id=body.exchange_connection_id)
    except SynFuturesEntryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    except Exception:
        raise HTTPException(status_code=503, detail="SYNFUTURES_POSITION_READ_UNAVAILABLE") from None
    # Dedicated public-data DTO. Contains no operator configuration or key.
    return JSONResponse({"status":"snapshot","snapshot":snapshot})


@app.post("/v1/synfutures/owner-recovery")
async def synfutures_owner_recovery_endpoint(request: Request) -> JSONResponse:
    from .synfutures_account import BaseAccountRpc
    from .synfutures_positions import read_positions, owner_recovery
    from .synfutures_entry import SynFuturesEntryError
    raw = await enforce_signed_request(request)
    try:
        body = SynFuturesRecoveryBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    def build():
        rpc = BaseAccountRpc()
        snapshot = read_positions(db=_db(),rpc=rpc,user_id=body.user_id,connection_id=body.exchange_connection_id)
        return owner_recovery(snapshot=snapshot,rpc=rpc,symbol=body.symbol,slippage_bps=body.slippage_bps)
    try:
        recovery = await asyncio.to_thread(build)
    except SynFuturesEntryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except Exception:
        raise HTTPException(status_code=503, detail="SYNFUTURES_RECOVERY_UNAVAILABLE") from None
    # Build/simulate only. The connected verified owner must review and sign.
    return JSONResponse({"status":"owner_review_required","recovery":recovery})


class SynFuturesOwnerReceiptBody(SynFuturesReconcileBody):
    symbol: str = Field(pattern=r"^(BTC|ETH)-USDC$")
    phase: str = Field(pattern=r"^(enable_module|authorize_owner_exit|close_position)$")
    tx_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$")
    calldata_hash: str = Field(pattern=r"^0x[0-9a-f]{64}$")


@app.post("/v1/synfutures/owner-recovery-status")
async def synfutures_owner_receipt_endpoint(request: Request) -> JSONResponse:
    from .synfutures_account import BaseAccountRpc
    from .synfutures_positions import read_positions
    from .synfutures_owner_receipt import owner_receipt
    raw = await enforce_signed_request(request)
    try:
        body = SynFuturesOwnerReceiptBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    def read():
        rpc=BaseAccountRpc()
        snapshot=read_positions(db=_db(),rpc=rpc,user_id=body.user_id,connection_id=body.exchange_connection_id)
        return owner_receipt(snapshot=snapshot,rpc=rpc,symbol=body.symbol,phase=body.phase,tx_hash=body.tx_hash.lower(),calldata_hash=body.calldata_hash)
    try:
        result=await asyncio.to_thread(read)
    except Exception:
        raise HTTPException(status_code=503, detail="SYNFUTURES_RECOVERY_RECEIPT_UNCONFIRMED") from None
    return JSONResponse(result)


class AsterSnapshotBody(BaseModel):
    model_config = {"extra": "forbid"}
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    since_ts_ms: int | None = Field(default=None, ge=0, strict=True)


@app.post("/v1/aster/equity")
@app.post("/v1/aster/positions")
@app.post("/v1/aster/fills")
@app.post("/v1/aster/reconcile-orders")
async def aster_snapshot_endpoint(request: Request) -> JSONResponse:
    from . import aster_snapshot
    raw = await enforce_signed_request(request)
    try:
        body = AsterSnapshotBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not is_enabled("RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    action = request.url.path.rsplit("/", 1)[-1]

    def read():
        row = _fetch_owned_rest_row(ConnectionReadBody(
            user_id=body.user_id, exchange_connection_id=body.exchange_connection_id,
        ))
        if row.get("exchange") != "aster" or row.get("environment") not in ("mainnet", "production"):
            raise HTTPException(status_code=409, detail="ASTER_CONNECTION_MISMATCH")
        creds = _decrypt_or_400(row)
        try:
            credentials = _aster_credentials(creds)
            if action == "reconcile-orders":
                from .aster_reconciliation import reconcile_connection
                result = reconcile_connection(db=_db(), credentials=credentials,
                    user_id=body.user_id, connection_id=body.exchange_connection_id)
                data = {"reconciliation_required": result["reconciliation_required"]}
            elif action == "fills":
                data = aster_snapshot.fills(credentials, since_ts_ms=body.since_ts_ms)
            elif action == "positions":
                data = aster_snapshot.positions(credentials)
            else:
                data = aster_snapshot.equity(credentials)
            return {"status": "ok", "exchange": "aster", "environment": "mainnet",
                    "connection_id": body.exchange_connection_id, **data}
        except aster_v3.AsterV3Error as exc:
            raise HTTPException(status_code=502, detail=exc.code) from exc
        finally:
            creds.scrub()

    return JSONResponse(sanitize_response(await asyncio.to_thread(read)))


class CapitalBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    operation: str = Field(
        pattern=r"^(READ_CAPITAL|MOVE_FUNDING_TO_PERPS|MOVE_PERPS_TO_FUNDING)$"
    )
    amount: str | None = Field(default=None, max_length=32)
    asset: str = Field(default="USDT", pattern=r"^USDT$")
    idempotency_key: str = Field(min_length=8, max_length=64)


def _capital_amount(value: str | None) -> decimal.Decimal:
    try:
        amount = decimal.Decimal(str(value or ""))
    except (decimal.InvalidOperation, ValueError):
        raise HTTPException(status_code=400, detail="INVALID_AMOUNT")
    if not amount.is_finite() or amount <= 0:
        raise HTTPException(status_code=400, detail="INVALID_AMOUNT")
    return amount


@app.post("/v1/capital")
async def capital(request: Request) -> JSONResponse:
    """Read or allocate capital inside one caller-owned ApeX account.

    This endpoint cannot accept an address or chain and never invokes an
    external withdrawal method. The only mutations are Funding → Perps and
    Perps → Funding on the same ApeX account.
    """
    body_bytes = await enforce_signed_request(request)
    try:
        body = CapitalBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not is_enabled(body.operation):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    if body.operation != "READ_CAPITAL" and not _capital_moves_enabled():
        raise HTTPException(status_code=403, detail="CAPITAL_MOVES_DISABLED")

    rest_row = _fetch_owned_rest_row(
        ConnectionReadBody(
            user_id=body.user_id,
            exchange_connection_id=body.exchange_connection_id,
        )
    )
    rest_creds = _decrypt_or_400(rest_row)
    zk_row = _db().find_active_credential_for_connection(
        user_id=body.user_id,
        exchange_connection_id=body.exchange_connection_id,
        environment=canonicalize_environment(rest_row["environment"]),
    )
    if not zk_row:
        rest_creds.scrub()
        raise HTTPException(status_code=404, detail="STARK_CREDENTIAL_MISSING")

    try:
        bundle = decrypt_bundle(
            zk_row["encrypted_credentials"], EnvelopeContext.from_row(zk_row)
        )
        seeds = bundle["seeds"]
        l2_key = bundle.get("l2_key") or bundle.get("l2Key")
        if not isinstance(seeds, str) or not isinstance(l2_key, str):
            raise HTTPException(status_code=500, detail="CREDENTIAL_BUNDLE_MALFORMED")

        from .apex_capital import ApexCapitalClient

        client = ApexCapitalClient(
            canonicalize_environment(rest_row["environment"]),
            rest_creds,
            zk_seeds=seeds,
            zk_l2_key=l2_key,
        )
        balances = client.read_balances()
        if body.operation == "READ_CAPITAL":
            return JSONResponse(
                sanitize_response(
                    {
                        "status": "ok",
                        "connection_id": body.exchange_connection_id,
                        "balances": balances,
                    }
                )
            )

        amount = _capital_amount(body.amount)
        source = "funding" if body.operation == "MOVE_FUNDING_TO_PERPS" else "perps"
        available = decimal.Decimal(balances[source]["available"])
        if amount > available:
            raise HTTPException(status_code=409, detail="INSUFFICIENT_SOURCE_BALANCE")

        fingerprint = request_fingerprint(
            {
                "credential_id": body.exchange_connection_id,
                "symbol": body.asset,
                "side": body.operation,
                "order_type": "internal_capital_transfer",
                "size": format(amount, "f"),
                "price": None,
                "reduce_only": None,
            }
        )
        try:
            prior = _IDEM.check(body.idempotency_key, fingerprint)
        except IdempotencyConflict:
            raise HTTPException(status_code=409, detail="IDEMPOTENCY_CONFLICT")
        if prior is not None:
            return JSONResponse(
                sanitize_response(
                    {
                        "status": "duplicate_suppressed",
                        "connection_id": body.exchange_connection_id,
                        "before": balances,
                    }
                )
            )

        if body.operation == "MOVE_FUNDING_TO_PERPS":
            receipt = client.move_funding_to_perps(format(amount, "f"), body.asset)
        else:
            receipt = client.move_perps_to_funding(format(amount, "f"), body.asset)
        _IDEM.record(body.idempotency_key, fingerprint, "submitted")
        return JSONResponse(
            sanitize_response(
                {
                    "status": "submitted",
                    "connection_id": body.exchange_connection_id,
                    "receipt": receipt,
                    "before": balances,
                }
            )
        )
    except HTTPException:
        raise
    except (CryptoConfigError, KeyError, TypeError):
        raise HTTPException(status_code=500, detail="DECRYPT_FAILED")
    except (RestError, OrderRestError) as exc:
        raise HTTPException(status_code=502, detail=exc.args[0] if exc.args else "UPSTREAM_ERROR")
    finally:
        rest_creds.scrub()
        bundle = None  # noqa: F841


# ---------------------------------------------------------------------------
# Execution endpoints — BUILD_ORDER / CREATE_ORDER / CANCEL_ORDER /
#                       CLOSE_POSITION / RECONCILE
# ---------------------------------------------------------------------------
# All five are gated by:
#   1. HMAC signed request
#   2. APEX_MAINNET_SIGNER_ENABLED (build/sign/cancel/reconcile)
#   3. APEX_MAINNET_CANARY_ENABLED (create/close — anything that emits)
#   4. `operations.is_enabled(...)` — sole authority per operations.py
# Every operation stays OFF in `OPERATION_ENABLED` until the owner flips it.
# The submission code lives HERE, not in `sign_order`, so the tests that
# assert `sign_order` contains no transmission path still pass.

from decimal import Decimal, InvalidOperation
from .builder import (
    BuildError, BuildInput, build_order, build_wallet_campaign_plan,
    round_price_to_tick, round_size_to_step,
)
from .execution import (
    ExecutionRequest, PipelineError, Protection, ReconcileReport,
    create_campaign_pipeline, create_order_pipeline, preflight, reconcile, resolve_account_equity,
    resolve_preflight_equity,
)
from .test_mode import entry_without_protections, live_test_mode_enabled


from . import orders_v3
from .orders_v3 import OrderRestError, RestCreds
from .apex_sdk_order import SdkOrderClient


def _required_margin(built) -> Decimal | None:
    """This order's own margin requirement, or None when unreadable.

    Free collateral must cover it on top of the reserve floor; a locked-up
    account must reject with INSUFFICIENT_FREE_COLLATERAL, not a funding code.
    """
    try:
        value = Decimal(str(getattr(built, "margin_usd", "") or ""))
    except (InvalidOperation, ValueError):
        return None
    return value if value.is_finite() and value >= 0 else None


class BuildOrderBody(BaseModel):
    symbol: str
    side: str = Field(pattern=r"^(BUY|SELL)$")
    mark_price: str
    leverage: int
    capital_baseline_usd: str
    tick_size: str
    step_size: str
    decimals: int
    l2_pair_id: int
    taker_fee_rate: str
    maker_fee_rate: str
    slippage_bps: int = 50


@app.post("/v1/build-order")
async def build_order_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = BuildOrderBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not is_enabled("BUILD_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    try:
        built = build_order(BuildInput(**body.model_dump()))
    except BuildError as e:
        raise HTTPException(status_code=400, detail=e.code)
    return JSONResponse(sanitize_response({"status": "built", "order": {
        "symbol": built.symbol, "side": built.side, "type": built.order_type,
        "size": built.size, "protected_price": built.protected_price,
        "mark_price": built.mark_price, "notional_usd": built.notional_usd,
        "margin_usd": built.margin_usd, "leverage": built.leverage,
        "slippage_bps": built.slippage_bps,
    }}), status_code=200)


# --- Manual Deploy Formation — owner-only ladder planner -------------------
#
# Owner ruling (manual DCA path): this endpoint PLANS a full DCA ladder
# with per-rung margin division, LIMIT rung prices tick-rounded on the safe
# side, and a single hard stop `hard_stop_beyond_last_rung_pct` beyond the
# deepest rung. It is a planner / preview only — it does NOT submit orders
# to the venue. Atomic submission with fail-closed unwind of filled rungs
# on stop-attach failure is NOT wired in this pass and is honestly reported
# as such. Callers MUST NOT treat a successful plan as a confirmation of
# execution.
#
# The endpoint is gated by APEX_MANUAL_DEPLOY_ENABLED (separate from the
# automated worker signer flag) so it cannot be reached until the owner
# explicitly enables it. It is HMAC-authenticated like every other route.

from .builder import (
    build_ladder_plan as _build_ladder_plan,
    build_exit_ladder_plan as _build_exit_ladder_plan,
)


def _manual_deploy_enabled() -> bool:
    return os.environ.get("APEX_MANUAL_DEPLOY_ENABLED", "false").lower() == "true"


class ManualDeployPlanBody(BaseModel):
    symbol: str
    side: str = Field(pattern=r"^(BUY|SELL)$")
    mark_price: str
    leverage: int
    tick_size: str
    step_size: str
    decimals: int
    l2_pair_id: int
    taker_fee_rate: str
    maker_fee_rate: str
    rungs: int | None = None
    slippage_bps: int = 50


@app.post("/v1/manual-deploy-plan")
async def manual_deploy_plan_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ManualDeployPlanBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _manual_deploy_enabled():
        raise HTTPException(status_code=403, detail="MANUAL_DEPLOY_DISABLED")
    try:
        plan = _build_ladder_plan(**body.model_dump(exclude_none=True))
    except Exception as e:
        code = getattr(e, "code", "PLAN_FAILED")
        raise HTTPException(status_code=400, detail=code)
    return JSONResponse(sanitize_response({
        "status": "planned",
        "purpose": "manual_deploy",
        "submitted": False,
        "plan": {
            "symbol": plan.symbol, "side": plan.side, "leverage": plan.leverage,
            "total_margin_usd": plan.total_margin_usd,
            "total_notional_usd": plan.total_notional_usd,
            "hard_stop_price": plan.hard_stop_price,
            "hard_stop_side": plan.hard_stop_side,
            "rungs": [{
                "index": r.index, "limit_price": r.limit_price,
                "size": r.size, "margin_usd": r.margin_usd,
                "notional_usd": r.notional_usd,
            } for r in plan.rungs],
        },
    }), status_code=200)


# ---------------------------------------------------------------------------
# Manual EXIT ladder preview — owner ruling #17 ("Rung Down"). PREVIEW ONLY:
# returns the planned scale-out rungs so the confirmation modal shows ACTUAL
# post-rounding sizes/prices. Atomic submission + persistence + verify are
# wired in the next batch alongside the frontend trigger. Gated behind the
# same APEX_MANUAL_DEPLOY_ENABLED flag as the deploy planner because it is
# the same owner-armed surface.
# ---------------------------------------------------------------------------

class ManualExitPlanBody(BaseModel):
    symbol: str
    position_side: str = Field(pattern=r"^(BUY|SELL)$")
    mark_price: str
    open_size: str
    close_size: str
    leverage: int
    tick_size: str
    step_size: str
    rungs: int | None = None
    direction: str = Field(default="ASCENDING", pattern=r"^(ASCENDING|DESCENDING)$")
    # Ruling #18 addition 1 — explicit price-range mode. When BOTH set,
    # rungs distribute evenly and inclusively from start_price..end_price.
    start_price: str | None = None
    end_price: str | None = None



@app.post("/v1/manual-exit-plan")
async def manual_exit_plan_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ManualExitPlanBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _manual_deploy_enabled():
        raise HTTPException(status_code=403, detail="MANUAL_DEPLOY_DISABLED")
    try:
        plan = _build_exit_ladder_plan(**body.model_dump(exclude_none=True))
    except Exception as e:
        code = getattr(e, "code", "PLAN_FAILED")
        raise HTTPException(status_code=400, detail=code)
    # Invariant echo: every rung reduce_only. Belt-and-braces — the builder
    # already asserts this, but re-check here so a future refactor of the
    # dataclass can't quietly drop the flag on the wire.
    if not all(r.reduce_only is True for r in plan.rungs):
        raise HTTPException(status_code=500, detail="REDUCE_ONLY_VIOLATED")
    return JSONResponse(sanitize_response({
        "status": "planned",
        "purpose": "manual_exit",
        "submitted": False,
        "plan": {
            "symbol": plan.symbol,
            "position_side": plan.position_side,
            "exit_side": plan.exit_side,
            "leverage": plan.leverage,
            "direction": plan.direction,
            "open_size": plan.open_size,
            "close_size": plan.close_size,
            "actual_close_size": plan.actual_close_size,
            "remaining_size": plan.remaining_size,
            "rungs": [{
                "index": r.index,
                "limit_price": r.limit_price,
                "size": r.size,
                "notional_usd": r.notional_usd,
                "reduce_only": r.reduce_only,
            } for r in plan.rungs],
        },
    }), status_code=200)



class ProtectionBody(BaseModel):
    kind: str = Field(pattern=r"^(STOP|TP1|TP2|TP3)$")
    trigger_price: str
    size: str
    order_type: str = Field(pattern=r"^(STOP_MARKET|TAKE_PROFIT_MARKET|STOP_LIMIT|TAKE_PROFIT_LIMIT)$")


class CreateOrderBody(BaseModel):
    credential_id: str
    exchange_connection_id: str
    client_order_id: str
    built: BuildOrderBody
    protections: list[ProtectionBody]
    # STARK material — same fields SIGN_ORDER already validated.
    account_id: int
    sub_account_id: int
    slot_id: int
    nonce: int


def _rest_creds_for(user_id: str, connection_id: str) -> RestCreds:
    row = _creds_reader().fetch_rest_credentials_owned(user_id, connection_id)
    if not row:
        raise HTTPException(status_code=404, detail="CONNECTION_NOT_FOUND")
    if row.get("exchange") not in ("apex_omni", "apex_omni_testnet"):
        raise HTTPException(status_code=400, detail="UNSUPPORTED_EXCHANGE")
    try:
        creds = decrypt_rest_credentials(row)
    except ExchangeCredError:
        raise HTTPException(status_code=500, detail="DECRYPT_FAILED")
    return row, creds  # type: ignore[return-value]


@app.post("/v1/create-order")
async def create_order_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = CreateOrderBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not _canary_enabled():
        raise HTTPException(status_code=403, detail="CANARY_DISABLED")
    if not is_enabled("CREATE_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    store = OrderStore(_db())

    cred = _db().fetch_active_credential(body.credential_id)
    if not cred:
        raise HTTPException(status_code=403, detail="CREDENTIAL_REVOKED_OR_MISSING")
    try:
        intent = store.load_signable_intent(cred["user_id"], body.client_order_id)
    except StoreError as e:
        raise HTTPException(status_code=409, detail=e.code)
    if intent.environment != cred["environment"]:
        store.audit(intent, "rejected", reject_reason="ENVIRONMENT_MISMATCH")
        raise HTTPException(status_code=409, detail="ENVIRONMENT_MISMATCH")

    # Build (re-validates every constant server-side; caller CANNOT override).
    try:
        built = build_order(BuildInput(**body.built.model_dump()))
    except BuildError as e:
        store.audit(intent, "rejected", reject_reason=e.code)
        raise HTTPException(status_code=400, detail=e.code)

    # F3 (single source of truth): REST creds are looked up under the
    # credential's owner. `CreateOrderBody` deliberately has NO `user_id`
    # field — a compromised broker HMAC cannot pair one user's REST creds
    # with another user's STARK material.
    row, rest_creds = _rest_creds_for(cred["user_id"], body.exchange_connection_id)
    try:
        try:
            positions = orders_v3.get_positions(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                passphrase=rest_creds.passphrase,
            ))
            open_orders = orders_v3.get_open_orders(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                passphrase=rest_creds.passphrase,
            ), symbol=built.symbol)
            account = apex_omni_rest.read_account(
                environment=row["environment"], api_key=rest_creds.api_key,
                api_secret=rest_creds.api_secret, passphrase=rest_creds.passphrase,
            )
        except (OrderRestError, RestError) as e:
            store.audit(intent, "rejected", reject_reason=f"PREFLIGHT_FAILED:{e.args[0] if e.args else 'UNKNOWN'}")
            raise HTTPException(status_code=502, detail="PREFLIGHT_FAILED")

        halted = bool(_db().is_execution_halted(cred["user_id"], body.exchange_connection_id))
        try:
            preflight(
                equity_usd=resolve_preflight_equity(
                    account.available_balance, account.total_equity
                ),
                total_equity_usd=resolve_account_equity(
                    account.available_balance, account.total_equity
                ),
                required_margin_usd=_required_margin(built),
                open_orders_for_symbol=[o for o in open_orders if str(o.get("symbol")) == built.symbol],
                open_positions_for_symbol=[p for p in positions if str(p.get("symbol")) == built.symbol],
                kill_switch_halted=halted,
            )

        except PipelineError as e:
            store.audit(intent, "rejected", reject_reason=e.code)
            raise HTTPException(status_code=409, detail=e.code)

        # Decrypt STARK bundle and build the SDK-backed order client. If the
        # owner supplied ApeX's Omni Key seed, it is authoritative; otherwise
        # fall back to the wallet-derived onboarding bundle.
        try:
            bundle = decrypt_bundle(cred["encrypted_credentials"], EnvelopeContext.from_row(cred))
            omni_seed = getattr(rest_creds, "omni_seed", None)
            if omni_seed:
                sdk_identity = public_from_seed(omni_seed)
                seeds = sdk_identity.seeds
                l2_key = sdk_identity.l2_key
                bundle_l2 = str(bundle.get("l2_key") or bundle.get("l2Key") or "")
                log.info(
                    "apex_l2_identity_source=omni_seed wallet_l2_match=%s user_id=%s connection_id=%s",
                    bool(bundle_l2 and bundle_l2 == l2_key), cred["user_id"], body.exchange_connection_id,
                )
            else:
                seeds = bundle["seeds"]
                l2_key = bundle.get("l2_key") or bundle.get("l2Key")
        except Exception:
            store.audit(intent, "rejected", reject_reason="DECRYPT_FAILED")
            raise HTTPException(status_code=500, detail="DECRYPT_FAILED")

        class _Rest:
            def __init__(self, env, c):
                self.env, self.c = env, RestCreds(api_key=c.api_key, api_secret=c.api_secret, passphrase=c.passphrase)
                self.sdk = SdkOrderClient(self.env, self.c, zk_seeds=seeds, zk_l2_key=str(l2_key))
            def create_order(self, params): return self.sdk.create_order(params)
            def cancel_by_client_order_id(self, coid): return orders_v3.cancel_by_client_order_id(self.env, self.c, coid)
            def get_open_orders(self, symbol=None): return orders_v3.get_open_orders(self.env, self.c, symbol)
            def get_positions(self): return orders_v3.get_positions(self.env, self.c)

        req = ExecutionRequest(
            intent_id=intent.id, user_id=intent.user_id, connection_id=intent.connection_id,
            client_order_id=intent.client_order_id, environment=intent.environment,
            built=built,
            protections=tuple(Protection(**p.model_dump()) for p in body.protections),
        )
        store.mark_signing(intent)
        try:
            result = create_order_pipeline(req, _Rest(row["environment"], rest_creds),
                                           nonce_seed=body.nonce)
        except PipelineError as e:
            # Fail-closed already ran inside pipeline for protection failures.
            store.mark_reconciliation_required(intent, e.code)
            raise HTTPException(status_code=409, detail=e.code)
        finally:
            # Best-effort scrub.
            try: bundle.clear()  # type: ignore[attr-defined]
            except Exception: pass

        store.mark_submitted(intent, venue_order_id=result.venue_order_id,
                             protection_ids=result.protection_venue_ids)
        return JSONResponse(sanitize_response({
            "status": "submitted",
            "venue_order_id": result.venue_order_id,
            "protection_venue_ids": result.protection_venue_ids,
        }), status_code=200)
    finally:
        rest_creds.scrub()


class CancelOrderBody(BaseModel):
    exchange_connection_id: str
    user_id: str
    client_order_id: str


@app.post("/v1/cancel-order")
async def cancel_order_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = CancelOrderBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not is_enabled("CANCEL_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    row, rest_creds = _rest_creds_for(body.user_id, body.exchange_connection_id)
    try:
        try:
            data = orders_v3.cancel_by_client_order_id(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                passphrase=rest_creds.passphrase,
            ), body.client_order_id)
        except OrderRestError as e:
            return JSONResponse(sanitize_response({
                "status": "error", "reject_reason": e.args[0] if e.args else "UPSTREAM_ERROR",
            }), status_code=200)
        return JSONResponse(sanitize_response({"status": "cancelled", "client_order_id": body.client_order_id,
                                               "venue_response": {"id": data.get("id")}}), status_code=200)
    finally:
        rest_creds.scrub()


class AsterEntryLifecycleBody(BaseModel):
    model_config = {"extra": "forbid"}
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    client_order_id: str = Field(min_length=8, max_length=64)
    symbol: str = Field(pattern=r"^(BTC|ETH|SOL|XRP)-?USDT$")
    rung: int = Field(ge=1, le=5, strict=True)


def _aster_entry_lifecycle(body: AsterEntryLifecycleBody, *, cancel: bool) -> JSONResponse:
    row = _fetch_owned_rest_row(ConnectionReadBody(
        user_id=body.user_id, exchange_connection_id=body.exchange_connection_id,
    ))
    if row.get("exchange") != "aster" or row.get("environment") not in ("mainnet", "production"):
        raise HTTPException(status_code=409, detail="ASTER_CONNECTION_MISMATCH")
    if cancel and (row.get("connection_status") != "verified"
                   or row.get("permission_trade") is not True
                   or row.get("permissions_verified") is not True):
        raise HTTPException(status_code=409, detail="ASTER_TRADE_PERMISSION_UNVERIFIED")
    creds = _decrypt_or_400(row)
    try:
        credentials = _aster_credentials(creds)
        handler = aster_lifecycle.cancel_entry if cancel else aster_lifecycle.observe_entry
        result = handler(
            credentials, user_id=body.user_id, connection_id=body.exchange_connection_id,
            client_order_id=body.client_order_id, symbol=body.symbol.replace("-", ""),
            rung=body.rung,
        )
        return JSONResponse(sanitize_response(result))
    except (aster_lifecycle.AsterLifecycleError, aster_v3.AsterV3Error) as exc:
        # Unknown is a durable outcome, not a confirmed cancellation or a
        # reason to retry. HTTP 200 preserves that state through the broker.
        return JSONResponse(sanitize_response({
            "status": "ambiguous" if exc.ambiguous else "error", "reject_reason": exc.code,
        }))
    finally:
        creds.scrub()


@app.post("/v1/aster/entry-status")
@app.post("/v1/aster/cancel-entry")
async def aster_entry_lifecycle_endpoint(request: Request) -> JSONResponse:
    raw = await enforce_signed_request(request)
    try:
        body = AsterEntryLifecycleBody.model_validate_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    cancel = request.url.path.endswith("/cancel-entry")
    if not is_enabled("CANCEL_ORDER" if cancel else "RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    # Read/cancel remains available when new entries are paused. This path
    # cannot submit entries, close positions, or cancel protective stops.
    return await asyncio.to_thread(_aster_entry_lifecycle, body, cancel=cancel)


class ClosePositionBody(BaseModel):
    credential_id: str
    exchange_connection_id: str
    user_id: str
    client_order_id: str  # unique id for the close leg
    symbol: str
    l2_pair_id: int
    decimals: int
    taker_fee_rate: str
    maker_fee_rate: str
    account_id: int
    sub_account_id: int
    slot_id: int
    nonce: int
    protected_price: str  # signer-computed worst acceptable exit


@app.post("/v1/close-position")
async def close_position_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ClosePositionBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not _canary_enabled():
        raise HTTPException(status_code=403, detail="CANARY_DISABLED")
    if not is_enabled("CLOSE_POSITION"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    cred = _db().fetch_active_credential(body.credential_id)
    if not cred:
        raise HTTPException(status_code=403, detail="CREDENTIAL_REVOKED_OR_MISSING")
    # F3: reject if the caller-supplied user_id disagrees with the credential
    # owner. STARK material and REST creds MUST resolve under one identity.
    if body.user_id != cred["user_id"]:
        raise HTTPException(status_code=403, detail="USER_MISMATCH")
    row, rest_creds = _rest_creds_for(cred["user_id"], body.exchange_connection_id)
    try:
        try:
            positions = orders_v3.get_positions(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                passphrase=rest_creds.passphrase,
            ))
        except OrderRestError as e:
            raise HTTPException(status_code=502, detail=e.args[0] if e.args else "UPSTREAM_ERROR")
        target = next((p for p in positions if str(p.get("symbol")) == body.symbol
                       and Decimal(str(p.get("size") or 0)) > 0), None)
        if not target:
            return JSONResponse(sanitize_response({"status": "noop", "reason": "NO_POSITION"}), status_code=200)

        size = str(target.get("size"))
        side_open = str(target.get("side", "")).upper()
        close_side = "SELL" if side_open in ("LONG", "BUY") else "BUY"

        try:
            bundle = decrypt_bundle(cred["encrypted_credentials"], EnvelopeContext.from_row(cred))
            seeds = bundle["seeds"]
        except Exception:
            raise HTTPException(status_code=500, detail="DECRYPT_FAILED")

        try:
            signed = zk_sign_order(
                seeds=seeds, account_id=body.account_id, sub_account_id=body.sub_account_id,
                slot_id=body.slot_id, nonce=body.nonce, l2_pair_id=body.l2_pair_id,
                size=size, price=body.protected_price, decimals=body.decimals,
                is_buy=(close_side == "BUY"), taker_fee_rate=body.taker_fee_rate,
                maker_fee_rate=body.maker_fee_rate, client_order_id=body.client_order_id,
            )
        except SigningError as e:
            raise HTTPException(status_code=500, detail=e.code)
        finally:
            seeds = None; del seeds

        try:
            resp = orders_v3.create_order(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                passphrase=rest_creds.passphrase,
            ), {
                "symbol": body.symbol, "side": close_side, "type": "MARKET",
                "size": size, "price": body.protected_price,
                "clientOrderId": body.client_order_id,
                "reduceOnly": "true",  # non-negotiable
                "signature": signed.signature, "limitFee": body.taker_fee_rate,
            })
        except OrderRestError as e:
            raise HTTPException(status_code=502, detail=e.args[0] if e.args else "UPSTREAM_ERROR")
        return JSONResponse(sanitize_response({
            "status": "closed", "venue_order_id": resp["venue_order_id"],
            "client_order_id": body.client_order_id, "reduce_only": True,
        }), status_code=200)
    finally:
        rest_creds.scrub()


class ReconcileBody(BaseModel):
    user_id: str
    exchange_connection_id: str
    known_client_order_ids: list[str] = []


@app.post("/v1/reconcile")
async def reconcile_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = ReconcileBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not is_enabled("RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    row, rest_creds = _rest_creds_for(body.user_id, body.exchange_connection_id)
    try:
        c = RestCreds(api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                      passphrase=rest_creds.passphrase)
        try:
            open_orders = orders_v3.get_open_orders(row["environment"], c, symbol=None)
            positions = orders_v3.get_positions(row["environment"], c)
        except OrderRestError as e:
            raise HTTPException(status_code=502, detail=e.args[0] if e.args else "UPSTREAM_ERROR")

        # Match by clientOrderId — NEVER by venue id alone.
        known = set(body.known_client_order_ids)
        matched: list[dict] = []
        unknown: list[str] = []
        for o in open_orders:
            coid = o.get("clientOrderId") or o.get("clientId")
            entry = {"client_order_id": coid, "venue_order_id": str(o.get("id") or ""),
                     "status": o.get("status") or o.get("state"),
                     "symbol": o.get("symbol"), "reduce_only": bool(o.get("reduceOnly"))}
            if coid and coid in known:
                matched.append(entry)
            else:
                unknown.append(entry["venue_order_id"])

        pos_summary = [{
            "symbol": p.get("symbol"),
            "side": p.get("side"),
            "size": str(p.get("size") or p.get("openSize") or "0"),
        } for p in positions if Decimal(str(p.get("size") or 0)) != 0]

        return JSONResponse(sanitize_response({
            "status": "reconciled",
            "matched_orders": matched,
            "unknown_venue_orders": unknown,
            "positions": pos_summary,
        }), status_code=200)
    finally:
        rest_creds.scrub()


# =========================================================================
# /v1/positions — READ-ONLY snapshot for the live-position reconciler.
# =========================================================================
#
# CONTRACT
#   Same HMAC / signer / owned-connection guards as every other route.
#   Returns { positions: [...], open_orders: [...] } sanitized. NEVER
#   places or cancels orders — this endpoint has no writable path.
#
# CALLERS
#   The Supabase edge `reconcile-live-positions` function polls this every
#   cycle to upsert public.positions rows the live desk reads. The signer
#   is the only process holding decrypted REST creds, so ApeX reads must
#   go through here — not through a stored key on the edge or the client.
#
# SANITIZATION
#   Only the fields the UI needs are echoed back: symbol, side, size,
#   entry, mark, unrealized pnl, liquidation price, leverage for
#   positions; venue id + type + price + size + reduce-only for orders.
#   Nothing else from the venue payload leaks out.

class PositionsReadBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)


def _num_or_none(v) -> str | None:
    if v in (None, ""):
        return None
    try:
        return str(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None


def _side_normalize(raw) -> str | None:
    s = str(raw or "").strip().upper()
    if s in ("LONG", "BUY"):
        return "LONG"
    if s in ("SHORT", "SELL"):
        return "SHORT"
    return None


@app.post("/v1/positions")
async def positions_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = PositionsReadBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not is_enabled("RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    row, rest_creds = _rest_creds_for(body.user_id, body.exchange_connection_id)
    try:
        c = RestCreds(api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                      passphrase=rest_creds.passphrase)
        try:
            positions_raw = orders_v3.get_positions(row["environment"], c)
            open_orders_raw = orders_v3.get_open_orders(row["environment"], c, symbol=None)
        except OrderRestError as e:
            return JSONResponse(sanitize_response({
                "status": "error",
                "reject_reason": e.args[0] if e.args else "UPSTREAM_ERROR",
            }), status_code=200)

        positions: list[dict] = []
        for p in positions_raw:
            side = _side_normalize(p.get("side"))
            if not side:
                continue
            size = _num_or_none(p.get("size") or p.get("openSize"))
            if not size or Decimal(size) <= 0:
                continue
            positions.append({
                "symbol": p.get("symbol"),
                "side": side,
                "size": size,
                "entry_price": _num_or_none(p.get("entryPrice") or p.get("avgEntryPrice") or p.get("averagePrice")),
                "mark_price": _num_or_none(p.get("markPrice") or p.get("indexPrice")),
                "unrealized_pnl": _num_or_none(p.get("unrealizedPnl") or p.get("unrealisedPnl") or p.get("uPnl")) or "0",
                "liquidation_price": _num_or_none(p.get("liquidationPrice") or p.get("liqPrice")),
                "leverage": _num_or_none(p.get("leverage")) or _num_or_none(p.get("effectiveLeverage")),
            })

        open_orders: list[dict] = []
        for o in open_orders_raw:
            open_orders.append({
                "venue_order_id": str(o.get("id") or o.get("orderId") or ""),
                "client_order_id": o.get("clientOrderId") or o.get("clientId"),
                "symbol": o.get("symbol"),
                "side": _side_normalize(o.get("side")),
                "order_type": o.get("type") or o.get("orderType"),
                "price": _num_or_none(o.get("price") or o.get("triggerPrice")),
                "trigger_price": _num_or_none(o.get("triggerPrice")),
                "size": _num_or_none(o.get("size") or o.get("qty")),
                "reduce_only": bool(o.get("reduceOnly")),
                "status": o.get("status") or o.get("state"),
            })

        return JSONResponse(sanitize_response({
            "status": "ok",
            "connection_id": body.exchange_connection_id,
            "environment": row["environment"],
            "positions": positions,
            "open_orders": open_orders,
        }), status_code=200)
    finally:
        rest_creds.scrub()





# =========================================================================
# /v1/fills — READ-ONLY fills poller for the realized-P&L ingest job.
# =========================================================================
#
# CONTRACT
#   Same HMAC + owned-connection guards as /v1/positions. Never writes to
#   the venue. Returns sanitized fills only:
#     [ { venue_fill_id, venue_order_id, symbol, side (BUY|SELL),
#         price, size, fee, fee_currency, liquidity, fill_ts_ms } ]
#   `since_ts_ms` filters at-or-after (server-side beginTimeInclusive).
#   Nothing else from the venue payload leaks out — no user id, no wallet
#   address, no raw envelope.

class FillsReadBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    since_ts_ms: int | None = Field(default=None, ge=0)
    symbol: str | None = Field(default=None, min_length=1, max_length=32)
    limit: int = Field(default=200, ge=1, le=500)


def _fill_side_normalize(raw) -> str | None:
    s = str(raw or "").strip().upper()
    if s in ("BUY", "LONG"):
        return "BUY"
    if s in ("SELL", "SHORT"):
        return "SELL"
    return None


def _fill_ts_ms(row: dict) -> int | None:
    for k in ("createdAt", "matchTime", "matchTimeMs", "executedAt", "time", "ts", "timestamp"):
        v = row.get(k)
        if v in (None, ""):
            continue
        try:
            n = int(str(v))
            # If it looks like seconds, upscale.
            if n < 10_000_000_000:
                n *= 1000
            return n
        except (ValueError, TypeError):
            continue
    return None


@app.post("/v1/fills")
async def fills_endpoint(request: Request) -> JSONResponse:
    body_bytes = await enforce_signed_request(request)
    try:
        body = FillsReadBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if not is_enabled("RECONCILE"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    from .orders_v3 import get_fills as _get_fills

    row, rest_creds = _rest_creds_for(body.user_id, body.exchange_connection_id)
    try:
        c = RestCreds(api_key=rest_creds.api_key, api_secret=rest_creds.api_secret,
                      passphrase=rest_creds.passphrase)
        try:
            raw_fills = _get_fills(
                row["environment"], c,
                symbol=body.symbol,
                begin_ts_ms=body.since_ts_ms,
                limit=body.limit,
            )
        except OrderRestError as e:
            return JSONResponse(sanitize_response({
                "status": "error",
                "reject_reason": e.args[0] if e.args else "UPSTREAM_ERROR",
            }), status_code=200)

        fills: list[dict] = []
        for f in raw_fills:
            side = _fill_side_normalize(f.get("side"))
            if not side:
                continue
            vid = f.get("id") or f.get("matchFillId") or f.get("fillId") or f.get("matchId")
            if not vid:
                continue
            size = _num_or_none(f.get("size") or f.get("qty") or f.get("filledSize"))
            price = _num_or_none(f.get("price") or f.get("filledPrice") or f.get("avgPrice"))
            if not size or not price or Decimal(size) <= 0 or Decimal(price) <= 0:
                continue
            ts_ms = _fill_ts_ms(f)
            if not ts_ms:
                continue
            liquidity = str(f.get("liquidity") or f.get("liquiditySide") or "").upper() or None
            if liquidity and liquidity not in ("MAKER", "TAKER"):
                liquidity = None
            fills.append({
                "venue_fill_id": str(vid),
                "venue_order_id": str(f.get("orderId") or f.get("orderID") or "") or None,
                "symbol": str(f.get("symbol") or ""),
                "side": side,
                "price": price,
                "size": size,
                "fee": _num_or_none(f.get("fee") or f.get("feePaid") or f.get("commission")) or "0",
                "fee_currency": (str(f.get("feeCurrency") or f.get("feeAsset") or "").upper() or None),
                "liquidity": liquidity,
                "fill_ts_ms": ts_ms,
            })

        # Chronological — matcher relies on ascending fill_ts.
        fills.sort(key=lambda x: (x["fill_ts_ms"], x["venue_fill_id"]))

        return JSONResponse(sanitize_response({
            "status": "ok",
            "connection_id": body.exchange_connection_id,
            "environment": row["environment"],
            "fills": fills,
            "count": len(fills),
        }), status_code=200)
    finally:
        rest_creds.scrub()



# =========================================================================
# /v1/orders — minimal-body order endpoint for the Supabase edge broker.
# =========================================================================
#

# CONTRACT
#   Accepts the shape the edge `execution-broker` posts today:
#     { user_id, exchange_connection_id, client_order_id, symbol, side,
#       order_type, size, price, leverage, reduce_only, environment,
#       purpose, venue }
#
#   size/price/leverage are ADVISORY — the signer AUTHORITATIVELY resizes
#   from the ratified constants in `builder.py` (canary baseline $30 =>
#   $300 notional at 100x). The caller cannot override pilot clamps.
#
# STARK STAGING (owner directive, 2026-07-27)
#   The signer resolves everything the STARK contract needs internally:
#     - account_id / sub_account_id / slot_id  ← /api/v3/user
#     - l2_pair_id / decimals / tick / step / fees  ← /api/v3/symbols
#     - mark_price  ← /api/v3/ticker
#   None of these come from the caller. This means a compromised edge
#   broker cannot smuggle wrong contract ids into a valid signature.
#
# PROTECTION CONTRACT (owner-ratified: "none/minimal per builder contract")
#   The minimal body has no stop. Rather than fork a second signing path,
#   we attach ONE default reduce-only STOP at ±DEFAULT_STOP_PCT from mark
#   so `create_order_pipeline` runs unchanged with fail-closed unwind.
#   TP tiers are strategy-layer concerns and NOT placed here.
#
# GUARDS
#   Same as every other write route: HMAC + skew/nonce, signer + canary
#   enabled, OPERATION_ENABLED("CREATE_ORDER"), idempotency, per-caller
#   kill-switch, per-symbol single-position rule (preflight).
#
# IDEMPOTENCY
#   `_IDEM` cheap pre-check + audit reservation. A replay with the same
#   fingerprint returns the prior venue_order_id; a replay with different
#   fingerprint fails with IDEMPOTENCY_CONFLICT.

DEFAULT_STOP_PCT = decimal.Decimal("0.05")  # 5% adverse move triggers reduce-only stop
INTERNAL_CANARY_SYMBOLS = frozenset({"BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"})
INTERNAL_CANARY_MAX_NOTIONAL_USD = decimal.Decimal("100")
INTERNAL_CANARY_MAX_LEVERAGE = 5


class TpTierBody(BaseModel):
    """Optional H2 take-profit ladder tier. `rr_multiple` is measured from
    the entry mark, using `R = |mark - stop_trigger|`. `size_frac` is the
    fraction of the entry `size` closed at that tier (sum ≤ 1)."""
    rr_multiple: float = Field(gt=0)
    size_frac: float = Field(gt=0, le=1)


class OrdersMinimalBody(BaseModel):
    """Shape mirrors execution-broker's `forwardBody` 1:1."""
    user_id: str = Field(min_length=1, max_length=64)
    exchange_connection_id: str = Field(min_length=1, max_length=64)
    client_order_id: str = Field(min_length=1, max_length=64)
    symbol: str = Field(min_length=1, max_length=32)
    side: str = Field(pattern=r"^(BUY|SELL|buy|sell)$")
    order_type: str = Field(default="MARKET", pattern=r"^(MARKET|LIMIT|market|limit)$")
    size: float | None = None       # advisory; server resizes
    price: float | None = None      # advisory
    leverage: int | None = None     # ApeX builder caps at 100; Aster validates <=125 and venue bracket.
    reduce_only: bool = False
    # POST-ONLY (maker-only) resting order. Valid ONLY with order_type=LIMIT;
    # the venue cancels the order instead of crossing the book.
    post_only: bool = False
    environment: str = Field(default="mainnet", pattern=r"^(mainnet|testnet)$")
    purpose: str | None = None
    venue: str | None = None
    margin_usdc: str | None = None  # SynFutures exact decimal; never a CEX size hint.

    # H2 strategy geometry (optional). When present, the signer builds
    # tick-rounded reduce-only TP protections layered on top of the default
    # attached stop. Same code path as the single-stop case — no exemption.
    tp_tiers: list[TpTierBody] | None = None
    stop_pct: float | None = None   # optional override of the 5% default
    campaign_rung_count: int | None = Field(default=None, ge=1, le=5)
    campaign_margin_usd: float | None = Field(default=None, ge=0)
    campaign_margin_per_rung_usd: float | None = Field(default=None, ge=0)


def _default_stop_for(side: str, mark: decimal.Decimal, size: str,
                      tick_size: str, stop_pct: decimal.Decimal | None = None) -> Protection:
    # Round TOWARD MARK so a tick-quantized stop is never looser than the
    # target %. BUY position stop sits below mark → round UP; SELL position
    # stop sits above mark → round DOWN.
    pct = stop_pct if stop_pct is not None else DEFAULT_STOP_PCT
    if side.upper() == "BUY":
        raw = mark * (decimal.Decimal(1) - pct)
        trigger = round_price_to_tick(raw, tick_size, "UP")
    else:
        raw = mark * (decimal.Decimal(1) + pct)
        trigger = round_price_to_tick(raw, tick_size, "DOWN")
    return Protection(kind="STOP", trigger_price=trigger,
                      size=size, order_type="STOP_MARKET")


def _build_tp_ladder(side: str, mark: decimal.Decimal, stop_trigger: str,
                     entry_size: str, step_size: str, tick_size: str,
                     tiers: list[TpTierBody]) -> tuple[Protection, ...]:
    """Layer tick/step-rounded reduce-only TP protections. TP price rounds
    TOWARD MARK (never loosen the target); sizes floor to stepSize."""
    R = abs(mark - decimal.Decimal(stop_trigger))
    if R <= 0:
        return ()
    total_size = decimal.Decimal(entry_size)
    if total_size <= 0:
        return ()
    out: list[Protection] = []
    for i, t in enumerate(tiers):
        rr = decimal.Decimal(str(t.rr_multiple))
        if side.upper() == "BUY":
            raw_price = mark + rr * R
            trig = round_price_to_tick(raw_price, tick_size, "DOWN")
        else:
            raw_price = mark - rr * R
            if raw_price <= 0:
                continue
            trig = round_price_to_tick(raw_price, tick_size, "UP")
        raw_size = total_size * decimal.Decimal(str(t.size_frac))
        sz = round_size_to_step(raw_size, step_size)
        if decimal.Decimal(sz) <= 0:
            continue
        out.append(Protection(
            kind=f"TP{i+1}", trigger_price=trig, size=sz,
            order_type="TAKE_PROFIT_MARKET",
        ))
    return tuple(out)


def _submit_aster_orders(body: OrdersMinimalBody) -> JSONResponse:
    """Aster-only signer path; never falls into ApeX credential or SDK code."""
    closing = body.reduce_only and body.purpose == "CLOSE_POSITION"
    if not closing and not _aster_automation_enabled():
        raise HTTPException(status_code=403, detail="ASTER_AUTOMATION_DISABLED")
    if not is_enabled("CLOSE_POSITION" if closing else "CREATE_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
    if body.environment != "mainnet" or (not closing and body.campaign_rung_count != 5):
        raise HTTPException(status_code=400, detail="ASTER_FIVE_RUNG_MAINNET_REQUIRED")
    if closing and (body.order_type.upper() != "MARKET" or body.size is None or body.size <= 0
                    or body.campaign_rung_count is not None or body.post_only or body.price is not None
                    or body.leverage is not None):
        raise HTTPException(status_code=400, detail="ASTER_EXIT_SHAPE_INVALID")
    if not closing and (
        body.reduce_only or body.post_only or body.purpose != "AUTOMATED_ENTRY"
        or body.order_type.upper() != "MARKET" or body.leverage is None
    ):
        raise HTTPException(status_code=400, detail="ASTER_ENTRY_SHAPE_INVALID")
    symbol = body.symbol.upper().replace("-", "")
    if symbol not in {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}:
        raise HTTPException(status_code=400, detail="ASTER_SYMBOL_UNSUPPORTED")
    row = _fetch_owned_rest_row(ConnectionReadBody(
        user_id=body.user_id, exchange_connection_id=body.exchange_connection_id,
    ))
    if row.get("exchange") != "aster" or row.get("environment") not in ("mainnet", "production"):
        raise HTTPException(status_code=409, detail="ASTER_CONNECTION_MISMATCH")
    if (
        row.get("connection_status") != "verified"
        or row.get("permission_trade") is not True
        or row.get("permissions_verified") is not True
    ):
        raise HTTPException(status_code=409, detail="ASTER_TRADE_PERMISSION_UNVERIFIED")
    creds = _decrypt_or_400(row)
    try:
        aster_credentials = _aster_credentials(creds)
        if closing:
            result = close_aster_position(db=_db(), credentials=aster_credentials,
                user_id=body.user_id, connection_id=body.exchange_connection_id,
                client_order_id=body.client_order_id, symbol=symbol,
                side=body.side.upper(), quantity=body.size, allow_cancel=is_enabled("CANCEL_ORDER"))
            return JSONResponse(sanitize_response(result), status_code=200)
        result = submit_aster_campaign(
            db=_db(), credentials=aster_credentials,
            user_id=body.user_id, connection_id=body.exchange_connection_id,
            client_order_id=body.client_order_id,
            symbol=symbol, side=body.side.upper(),
            leverage=body.leverage,
        )
        return JSONResponse(sanitize_response(result), status_code=200)
    except (AsterPlanError, AsterExitError) as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc
    except AsterExecutionError as exc:
        raise HTTPException(status_code=409 if not exc.ambiguous else 503, detail=exc.code) from exc
    except aster_v3.AsterV3Error as exc:
        raise HTTPException(status_code=503 if exc.ambiguous else 502, detail=exc.code) from exc
    finally:
        try: creds.scrub()
        except Exception: pass



@app.post("/v1/orders")
async def orders_minimal_endpoint(request: Request) -> JSONResponse:
    """Minimal broker-facing order-submit endpoint.

    Hardened: every downstream stage returns a specific 4xx subcode; any
    unhandled path falls through to the outer guard which logs a full
    traceback SERVER-SIDE and returns 500 INTERNAL_ERROR:<ClassName>. The
    response body NEVER contains stack frames, provider bodies, or key
    material — the caller sees only enum-shaped subcodes.
    """
    body_bytes = await enforce_signed_request(request)
    try:
        body = OrdersMinimalBody.model_validate_json(body_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if body.venue == "aster":
        return await asyncio.to_thread(_submit_aster_orders, body)
    if body.venue == "synfutures":
        from .synfutures_account import BaseAccountRpc, evaluate_entry_request
        from .synfutures_entry import SynFuturesEntryError
        payload = json.loads(body_bytes)
        native_fields = {"user_id", "exchange_connection_id", "client_order_id", "symbol", "side", "order_type",
                         "size", "price", "leverage", "reduce_only", "environment", "purpose", "venue", "margin_usdc"}
        if (set(payload) - native_fields or type(payload.get("leverage")) is not int or not isinstance(payload.get("margin_usdc"), str)
                or body.environment != "mainnet" or body.reduce_only or body.order_type != "MARKET"
                or body.size is not None or body.price is not None or body.campaign_rung_count is not None
                or body.tp_tiers is not None or body.stop_pct is not None or body.post_only
                or body.campaign_margin_usd is not None or body.campaign_margin_per_rung_usd is not None
                or body.purpose != "AUTOMATED_ENTRY"):
            raise HTTPException(status_code=400, detail="SYNFUTURES_ENTRY_SHAPE_INVALID")
        if not is_enabled("CREATE_ORDER"):
            raise HTTPException(status_code=403, detail="OPERATION_DISABLED")
        def synfutures_preflight():
            from .synfutures_execution import entry_enabled, prepare_campaign
            if entry_enabled():
                return prepare_campaign(db=_db(),rpc=BaseAccountRpc(),user_id=body.user_id,
                    connection_id=body.exchange_connection_id,symbol=body.symbol,margin_usdc=body.margin_usdc,
                    leverage=body.leverage,long=body.side.upper()=="BUY",campaign_key=body.client_order_id)
            return evaluate_entry_request(db=_db(), rpc=BaseAccountRpc(), user_id=body.user_id,
                connection_id=body.exchange_connection_id, symbol=body.symbol,
                margin_usdc=body.margin_usdc, leverage=body.leverage, long=body.side.upper() == "BUY")
        try:
            result = await asyncio.to_thread(synfutures_preflight)
        except SynFuturesEntryError as exc:
            result = {"status":"rejected", "reject_reason":str(exc)}
        except Exception:
            result = {"status":"rejected", "reject_reason":"SYNFUTURES_PREFLIGHT_UNAVAILABLE"}
        return JSONResponse(sanitize_response(result))
    if body.venue not in (None, "apex_omni"):
        raise HTTPException(status_code=400, detail="UNSUPPORTED_EXCHANGE")

    if not _signer_enabled():
        raise HTTPException(status_code=403, detail="SIGNER_DISABLED")
    if not _canary_enabled():
        raise HTTPException(status_code=403, detail="CANARY_DISABLED")
    if not is_enabled("CREATE_ORDER"):
        raise HTTPException(status_code=403, detail="OPERATION_DISABLED")

    side = body.side.upper()
    campaign_mode = body.campaign_rung_count is not None
    if campaign_mode and (body.campaign_rung_count != 5 or body.reduce_only):
        raise HTTPException(status_code=400, detail="CAMPAIGN_REQUIRES_FIVE_ENTRY_RUNGS")
    internal_owner_canary = (body.purpose or "").strip().lower() == "internal_owner_canary"
    if internal_owner_canary:
        if body.symbol.upper() not in INTERNAL_CANARY_SYMBOLS:
            raise HTTPException(status_code=400, detail="CANARY_SYMBOL_NOT_ALLOWED")
        if body.order_type.upper() != "MARKET" or body.reduce_only:
            raise HTTPException(status_code=400, detail="CANARY_ENTRY_SHAPE_INVALID")
        if body.leverage is None or body.leverage > INTERNAL_CANARY_MAX_LEVERAGE:
            raise HTTPException(status_code=400, detail="CANARY_LEVERAGE_ABOVE_LIMIT")
    proof_exempt_size = (body.purpose or "").strip().lower() == "proof_of_life"
    fp_payload = {
        "credential_id": f"{body.user_id}:{body.exchange_connection_id}:{body.environment}",
        "symbol": body.symbol.upper(),
        "side": side,
        "order_type": body.order_type.upper(),
        "size": body.size, "price": body.price,
        "leverage": body.leverage, "post_only": body.post_only,
        "purpose": body.purpose,
        "campaign_rung_count": body.campaign_rung_count,
        "reduce_only": bool(body.reduce_only),
    }
    fp = request_fingerprint(fp_payload)
    try:
        prior = _IDEM.check(body.client_order_id, fp)
    except IdempotencyConflict:
        raise HTTPException(status_code=409, detail="IDEMPOTENCY_CONFLICT")
    if prior is not None:
        # The cache is a refusal-only shortcut. Never present a cached venue
        # ID as fresh reconciliation evidence; the database/venue owns truth.
        raise HTTPException(status_code=409, detail="INTENT_ALREADY_RESERVED")

    cred = _db().find_active_credential_for_connection(
        user_id=body.user_id, exchange_connection_id=body.exchange_connection_id,
        environment=body.environment,
    )
    if not cred:
        raise HTTPException(status_code=403, detail="CREDENTIAL_REVOKED_OR_MISSING")

    # `_rest_creds_for` raises its own HTTPException on missing row / decrypt
    # failure. Callers unpack (row, creds).
    row, rest_creds = _rest_creds_for(cred["user_id"], body.exchange_connection_id)
    try:
        # Connection records retain legacy `production`/`live` labels, while
        # the durable order ledger accepts only mainnet/testnet. Canonicalize
        # the execution boundary, not the encrypted credential's source row.
        execution_environment = canonicalize_environment(row["environment"])
        if execution_environment != body.environment:
            raise HTTPException(status_code=409, detail="CONNECTION_ENVIRONMENT_MISMATCH")
        # --- Symbol config + STARK context + mark price --------------------
        try:
            sym_cfg = apex_omni_rest.get_symbol_config(row["environment"], body.symbol.upper())
        except RestError as e:
            raise HTTPException(status_code=502, detail=f"SYMBOL_METADATA_UNAVAILABLE:{(e.args[0] if e.args else 'UNKNOWN')}")

        try:
            mark_str = apex_omni_rest.get_mark_price(row["environment"], body.symbol.upper())
        except RestError as e:
            raise HTTPException(status_code=502, detail=f"MARK_UNAVAILABLE:{(e.args[0] if e.args else 'UNKNOWN')}")

        # --- Build (pilot clamps) ------------------------------------------
        leverage = int(body.leverage) if body.leverage else 100
        leverage = max(1, min(100, leverage))
        # AUTHORITATIVE SIZING CONTRACT (owner ruling): when the caller's
        # intent carries a size, the signer does NOT recompute it. The worker
        # owns sizing (accumulator_live_size.plan_entry_size); the signer only
        # quantizes DOWN to the venue step; authenticated free collateral and
        # venue limits are the hard bounds. Proof-of-life keeps the legacy server-sized path
        # verbatim — its 0.001 floor is a canary constant, not a sizing plan.
        size_override = None
        if (not proof_exempt_size) and body.size is not None and float(body.size) > 0:
            size_override = format(decimal.Decimal(str(body.size)), "f")
        order_type = body.order_type.upper()
        limit_price = None
        if order_type == "LIMIT":
            if body.price is None or float(body.price) <= 0:
                raise HTTPException(status_code=400, detail="BUILD_FAILED:LIMIT_PRICE_REQUIRED")
            limit_price = format(decimal.Decimal(str(body.price)), "f")
        if body.post_only:
            # POST-ONLY is maker-only: reject anything that could cross.
            if order_type != "LIMIT":
                raise HTTPException(status_code=400, detail="BUILD_FAILED:POST_ONLY_REQUIRES_LIMIT")
            _mark = decimal.Decimal(mark_str)
            _px = decimal.Decimal(limit_price or "0")
            if (side == "BUY" and _px >= _mark) or (side == "SELL" and _px <= _mark):
                raise HTTPException(status_code=400, detail="BUILD_FAILED:POST_ONLY_WOULD_CROSS")
        try:
            built = build_order(BuildInput(
                symbol=sym_cfg.symbol, side=side, mark_price=mark_str, leverage=leverage,
                capital_baseline_usd="0",  # deprecated/ignored; sizing reads ladder.dca_total_margin_usd
                tick_size=sym_cfg.tick_size, step_size=sym_cfg.step_size,
                decimals=sym_cfg.decimals, l2_pair_id=sym_cfg.l2_pair_id,
                taker_fee_rate=sym_cfg.taker_fee_rate, maker_fee_rate=sym_cfg.maker_fee_rate,
                size_override=size_override,
                order_type=order_type, limit_price=limit_price,
            ))

        except BuildError as e:
            raise HTTPException(status_code=400, detail=f"BUILD_FAILED:{e.code}")
        except Exception as e:
            log.exception("orders_minimal build_order unhandled")
            raise HTTPException(status_code=500, detail=f"BUILD_FAILED:UNHANDLED_{type(e).__name__}")

        # The public broker's estimate is advisory. Only the signer has the
        # venue mark and quantized size, so the real internal-canary ceiling
        # is enforced here after the authoritative build.
        if internal_owner_canary:
            if decimal.Decimal(str(built.notional_usd)) > INTERNAL_CANARY_MAX_NOTIONAL_USD:
                raise HTTPException(status_code=400, detail="CANARY_NOTIONAL_ABOVE_LIMIT")
            if int(built.leverage) > INTERNAL_CANARY_MAX_LEVERAGE:
                raise HTTPException(status_code=400, detail="CANARY_LEVERAGE_ABOVE_LIMIT")

        # --- Preflight (positions / open orders / account) -----------------
        try:
            positions = orders_v3.get_positions(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret, passphrase=rest_creds.passphrase))
            open_orders = orders_v3.get_open_orders(row["environment"], RestCreds(
                api_key=rest_creds.api_key, api_secret=rest_creds.api_secret, passphrase=rest_creds.passphrase),
                symbol=built.symbol)
            account_identity = apex_omni_rest.read_account(
                environment=row["environment"], api_key=rest_creds.api_key,
                api_secret=rest_creds.api_secret, passphrase=rest_creds.passphrase)
            account_balance = apex_omni_rest.read_account_balance(
                environment=row["environment"], api_key=rest_creds.api_key,
                api_secret=rest_creds.api_secret, passphrase=rest_creds.passphrase)
        except (OrderRestError, RestError) as e:
            code = e.args[0] if e.args else "UNKNOWN"
            # Same account-registration hint if the venue rejects the account
            # lookup from any of these three calls.
            if code in ("STARK_CONTEXT_MISSING", "USER_SHAPE_UNEXPECTED", "ACCOUNT_NOT_FOUND"):
                raise HTTPException(
                    status_code=409,
                    detail="ACCOUNT_NOT_REGISTERED:Press Register account for trading on the connection.",
                )
            raise HTTPException(status_code=502, detail=f"PREFLIGHT_FAILED:{code}")
        except AttributeError as e:
            # An unregistered account returns a shape that misses expected
            # attributes on the parsed account object.
            log.exception("orders_minimal preflight AttributeError (likely unregistered account)")
            raise HTTPException(
                status_code=409,
                detail="ACCOUNT_NOT_REGISTERED:Press Register account for trading on the connection.",
            )
        except Exception as e:
            log.exception("orders_minimal preflight unhandled")
            raise HTTPException(status_code=502, detail=f"PREFLIGHT_FAILED:UNHANDLED_{type(e).__name__}")

        account_id = account_identity.account_id
        if account_id is None:
            raise HTTPException(status_code=502, detail="USER_CONTEXT_UNAVAILABLE:ACCOUNT_ID_MISSING")
        account = account_balance if account_balance.total_equity is not None or account_balance.available_balance is not None else account_identity

        campaign_plan = None
        if campaign_mode:
            # The venue's authenticated account-balance response is the
            # sizing authority. Caller-provided campaign dollar fields are
            # display/audit hints only and never influence signing.
            if account.total_equity is None or account.available_balance is None:
                raise HTTPException(status_code=502, detail="CAMPAIGN_WALLET_BALANCE_UNAVAILABLE")
            try:
                campaign_plan = build_wallet_campaign_plan(
                    symbol=sym_cfg.symbol, side=side, mark_price=mark_str,
                    leverage=leverage, tick_size=sym_cfg.tick_size,
                    step_size=sym_cfg.step_size,
                    min_order_size=sym_cfg.min_order_size,
                    max_order_size=sym_cfg.max_order_size,
                    venue_max_leverage=sym_cfg.max_leverage,
                    settled_wallet_balance_usd=str(account.total_equity),
                    available_collateral_usd=str(account.available_balance),
                    decimals=sym_cfg.decimals, l2_pair_id=sym_cfg.l2_pair_id,
                    taker_fee_rate=sym_cfg.taker_fee_rate,
                    maker_fee_rate=sym_cfg.maker_fee_rate,
                )
                built = campaign_plan.rungs[0].built
            except BuildError as exc:
                raise HTTPException(status_code=409, detail=f"CAMPAIGN_BUILD_FAILED:{exc.code}")

        halted = bool(_db().is_execution_halted(cred["user_id"], body.exchange_connection_id))
        proof_exempt = (body.purpose or "").strip().lower() in ("proof_of_life", "post_only_proof")
        if proof_exempt:
            log.info(
                "preflight: proof_of_life exemption — existing order/position checks skipped "
                "user_id=%s connection_id=%s symbol=%s",
                cred["user_id"], body.exchange_connection_id, built.symbol,
            )
        # Free collateral first, total equity only as fallback. An unreadable
        # pair stays None so preflight can raise EQUITY_UNAVAILABLE instead of
        # mislabelling a failed read as a drained account.
        equity_for_gate = resolve_preflight_equity(
            account.available_balance, account.total_equity
        )
        log.info(
            "preflight equity source=%s available_present=%s total_present=%s resolved=%s "
            "connection_id=%s symbol=%s",
            "account-balance" if account is account_balance else "account",
            account.available_balance is not None,
            account.total_equity is not None,
            "none" if equity_for_gate is None else str(equity_for_gate),
            body.exchange_connection_id, built.symbol,
        )
        if body.reduce_only:
            # REDUCE-ONLY EXIT PREFLIGHT. The normal gate refuses when a
            # position exists — for an exit that IS the precondition. What we
            # verify instead, against the VENUE (never against our own DB):
            #   * a position on this symbol exists,
            #   * it is on the opposite side of this order,
            #   * its size covers the requested exit size.
            # Kill switch does NOT block a risk-reducing exit: halting must
            # never trap a user in an unmanaged position. Equity floors do not
            # apply — an exit frees margin, it does not commit any.
            venue_pos = None
            for p in positions:
                if str(p.get("symbol")) != built.symbol:
                    continue
                try:
                    psize = decimal.Decimal(str(p.get("size") or p.get("openSize") or "0"))
                except Exception:
                    psize = decimal.Decimal(0)
                if abs(psize) > 0:
                    venue_pos = (p, abs(psize))
                    break
            if venue_pos is None:
                raise HTTPException(status_code=409, detail="REDUCE_ONLY_NO_POSITION")
            pos_row, pos_size = venue_pos
            pos_side = str(pos_row.get("side", "")).upper()
            if not pos_side:
                pos_side = "LONG" if decimal.Decimal(str(pos_row.get("size") or 0)) > 0 else "SHORT"
            expected_exit = "SELL" if pos_side in ("LONG", "BUY") else "BUY"
            if side != expected_exit:
                raise HTTPException(status_code=409, detail="REDUCE_ONLY_WRONG_SIDE")
            if decimal.Decimal(built.size) > pos_size:
                raise HTTPException(status_code=409, detail="REDUCE_ONLY_EXCEEDS_POSITION")
        else:
            try:
                preflight(
                    equity_usd=equity_for_gate,
                    total_equity_usd=resolve_account_equity(
                        account.available_balance, account.total_equity
                    ),
                    required_margin_usd=(
                        Decimal(campaign_plan.total_margin_usd)
                        if campaign_plan is not None else _required_margin(built)
                    ),
                    open_orders_for_symbol=[o for o in open_orders if str(o.get("symbol")) == built.symbol],
                    open_positions_for_symbol=[p for p in positions if str(p.get("symbol")) == built.symbol],
                    kill_switch_halted=halted,
                    allow_existing_exposure=proof_exempt,
                )
            except PipelineError as e:
                raise HTTPException(status_code=409, detail=e.code)




        # --- Decrypt STARK bundle / choose ApeX SDK signing identity --------
        try:
            bundle = decrypt_bundle(cred["encrypted_credentials"], EnvelopeContext.from_row(cred))
            omni_seed = getattr(rest_creds, "omni_seed", None)
            if omni_seed:
                sdk_identity = public_from_seed(omni_seed)
                seeds = sdk_identity.seeds
                l2_key = sdk_identity.l2_key
                bundle_l2 = str(bundle.get("l2_key") or bundle.get("l2Key") or "")
                log.info(
                    "apex_l2_identity_source=omni_seed wallet_l2_match=%s user_id=%s connection_id=%s",
                    bool(bundle_l2 and bundle_l2 == l2_key), cred["user_id"], body.exchange_connection_id,
                )
            else:
                seeds = bundle["seeds"]
                l2_key = bundle.get("l2_key") or bundle.get("l2Key")
        except Exception:
            log.exception("orders_minimal decrypt_bundle failed")
            raise HTTPException(status_code=500, detail="CREDENTIAL_DECRYPT_FAILED")

        # NO TAKE-PROFIT AT ENTRY (owner directive 2026-08-04).
        #
        # Standard policy: an entry carries its protective STOP — atomically
        # attached — and NOTHING else. Take-profit is decided later by the
        # council after three fully closed candles and submitted as a
        # SEPARATE reduce-only order through this same endpoint with
        # `reduce_only=true`. `tp_tiers` on the entry body is accepted and
        # ignored so older callers cannot re-introduce an entry-attached TP.
        #
        # LIVE TEST MODE (SIGNER_LIVE_TEST_MODE=1) additionally drops the
        # attached STOP: entry goes out bare, and the council owns every
        # subsequent TP/exit action. Kill switch, exposure caps, equity floor
        # and venue liquidation stay in force. See app/test_mode.py.
        #
        # Proof-of-life is entry-only: no STOP, no TP, no unwind.
        stop_pct_dec = decimal.Decimal(str(body.stop_pct)) if body.stop_pct else None
        test_mode_entry = (
            not internal_owner_canary
            and entry_without_protections(
                reduce_only=bool(body.reduce_only), proof_exempt=proof_exempt,
                purpose=body.purpose,
            )
        )
        if body.reduce_only:
            # Reduce-only exit (council TP / partial TP / EXIT_NOW). No stop,
            # no ladder — the order can only shrink the position.
            protections: tuple = ()
        elif proof_exempt:
            protections = ()
        elif test_mode_entry:
            protections = ()
            log.warning(
                "LIVE TEST MODE: entry submitted with NO stop-loss and NO take-profit "
                "— council owns management after 3 closed candles. "
                "user_id=%s connection_id=%s symbol=%s side=%s size=%s",
                cred["user_id"], body.exchange_connection_id, built.symbol, side, built.size,
            )
        else:
            default_stop = _default_stop_for(side, decimal.Decimal(mark_str), built.size,
                                             sym_cfg.tick_size, stop_pct=stop_pct_dec)
            protections = (default_stop,)


        class _Rest:
            def __init__(self, env, c):
                self.env = env
                self.c = RestCreds(api_key=c.api_key, api_secret=c.api_secret, passphrase=c.passphrase)
                self.sdk = SdkOrderClient(self.env, self.c, zk_seeds=seeds, zk_l2_key=str(l2_key))
            def create_order(self, params): return self.sdk.create_order(params)
            def cancel_by_client_order_id(self, coid): return orders_v3.cancel_by_client_order_id(self.env, self.c, coid)
            def get_open_orders(self, symbol=None): return orders_v3.get_open_orders(self.env, self.c, symbol)
            def get_positions(self): return orders_v3.get_positions(self.env, self.c)

        if campaign_plan is not None:
            requests_to_submit = tuple(
                ExecutionRequest(
                    intent_id=f"{body.client_order_id}-r{rung.index}",
                    user_id=cred["user_id"], connection_id=body.exchange_connection_id,
                    client_order_id=f"{body.client_order_id}-r{rung.index}",
                    environment=execution_environment, built=rung.built,
                    protections=(Protection(
                        kind="STOP", trigger_price=campaign_plan.hard_stop_price,
                        size=rung.built.size, order_type="STOP_MARKET",
                    ),), post_only=False, reduce_only=False,
                )
                for rung in campaign_plan.rungs
            )
        else:
            requests_to_submit = (ExecutionRequest(
                intent_id=body.client_order_id, user_id=cred["user_id"],
                connection_id=body.exchange_connection_id,
                client_order_id=body.client_order_id, environment=execution_environment,
                built=built, protections=protections,
                post_only=bool(body.post_only), reduce_only=bool(body.reduce_only),
            ),)

        def _built_context(req: ExecutionRequest) -> dict:
            value = req.built
            return {
                "symbol": value.symbol, "side": value.side, "size": value.size,
                "notional_usd": value.notional_usd, "margin_usd": value.margin_usd,
                "mark_price": value.mark_price, "protected_price": value.protected_price,
                "leverage": value.leverage,
            }

        built_context = _built_context(requests_to_submit[0])
        # The unique (user_id, client_order_id) database insert is the live
        # signing reservation. In-memory _IDEM is only a response cache: a
        # signer restart or a second replica must never authorize a replay.
        # Reserve after all read-only preflight and before the first venue write.
        reservations: list[tuple[str, ExecutionRequest]] = []
        try:
            for submit_req in requests_to_submit:
                intent_id = _db().insert_order_intent({
                    "user_id": cred["user_id"],
                    "connection_id": body.exchange_connection_id,
                    "client_order_id": submit_req.client_order_id,
                    **({"automation_campaign_key": body.client_order_id}
                       if campaign_plan is not None and body.purpose == "AUTOMATED_ENTRY" else {}),
                    "environment": execution_environment,
                    "venue": body.venue or "apex_omni",
                    "symbol": submit_req.built.symbol,
                    "side": side,
                    "order_type": submit_req.built.order_type,
                    "size": float(submit_req.built.size),
                    "price": (
                        float(submit_req.built.protected_price)
                        if submit_req.built.order_type == "LIMIT" else None
                    ),
                    "reduce_only": bool(submit_req.reduce_only),
                    "state": "signing",
                })
                if not intent_id:
                    raise RuntimeError("INTENT_ID_MISSING")
                reservations.append((intent_id, submit_req))
        except Exception as exc:
            for reserved_id, _reserved_req in reservations:
                try:
                    _db().transition_order_intent(
                        intent_id=reserved_id, user_id=cred["user_id"], state="rejected",
                        state_reason="CAMPAIGN_RESERVATION_INCOMPLETE",
                    )
                except Exception:
                    log.exception("orders_minimal failed to release partial reservation")
            try: bundle.clear()  # type: ignore[attr-defined]
            except Exception: pass
            if "INTENT_DUPLICATE" in str(exc):
                raise HTTPException(status_code=409, detail="INTENT_ALREADY_RESERVED")
            log.exception("orders_minimal durable reservation failed")
            raise HTTPException(status_code=503, detail="INTENT_RESERVATION_UNAVAILABLE")

        def _finish_all(state: str, *, results=None, reason: str | None = None) -> None:
            for index, (reserved_id, _submit_req) in enumerate(reservations):
                venue_id = None
                if results is not None and index < len(results):
                    venue_id = results[index].venue_order_id
                _db().transition_order_intent(
                    intent_id=reserved_id, user_id=cred["user_id"], state=state,
                    exchange_order_id=venue_id, state_reason=reason,
                )

        import time as _t
        nonce_seed = int(_t.time() * 1000) & 0x7FFFFFFF
        rest_port = _Rest(row["environment"], rest_creds)
        try:
            if campaign_plan is not None:
                campaign_result = create_campaign_pipeline(
                    requests_to_submit, rest_port, nonce_seed=nonce_seed,
                )
                results = campaign_result.orders
            else:
                results = (create_order_pipeline(
                    requests_to_submit[0], rest_port, nonce_seed=nonce_seed,
                    allow_no_protections=proof_exempt or test_mode_entry,
                ),)

        except PipelineError as e:
            try:
                accepted_ids = dict(e.accepted_orders)
                for reserved_id, submit_req in reservations:
                    not_attempted = submit_req.client_order_id in e.unattempted_client_ids
                    _db().transition_order_intent(
                        intent_id=reserved_id, user_id=cred["user_id"],
                        state="rejected" if not_attempted else "reconciliation_required",
                        exchange_order_id=accepted_ids.get(submit_req.client_order_id),
                        state_reason="CAMPAIGN_NOT_SUBMITTED" if not_attempted else e.code,
                    )
            except Exception:
                log.exception("orders_minimal failed to mark ambiguous pipeline outcome")
            # Post-build failure — return 200 with built context so the panel
            # can show the exact numbers alongside the reject reason.
            from .venue_reject import facts_from_token, signer_revision
            return JSONResponse(sanitize_response({
                "status": "rejected", "exchange_order_id": None,
                "exchange_status": "rejected", "reject_reason": e.code,
                "venue_reject": facts_from_token(e.code),
                "signer_revision": signer_revision(),
                "built": built_context,
            }), status_code=200)
        except (OrderRestError, RestError) as e:
            try:
                _finish_all("reconciliation_required", reason="VENUE_ERROR")
            except Exception:
                log.exception("orders_minimal failed to mark ambiguous venue outcome")
            from .venue_reject import facts_from_token, signer_revision
            _token = f"VENUE_ERROR:{(e.args[0] if e.args else 'UNKNOWN')}"
            return JSONResponse(sanitize_response({
                "status": "rejected", "exchange_order_id": None,
                "exchange_status": "rejected",
                "reject_reason": _token,
                "venue_reject": facts_from_token(_token),
                "signer_revision": signer_revision(),
                "built": built_context,
            }), status_code=200)

        except Exception as e:
            log.exception("orders_minimal create_order_pipeline unhandled")
            try:
                _finish_all("reconciliation_required", reason="SUBMIT_UNHANDLED")
            except Exception:
                log.exception("orders_minimal failed to mark ambiguous submit outcome")
            raise HTTPException(status_code=500, detail=f"SUBMIT_FAILED:UNHANDLED_{type(e).__name__}")
        finally:
            try: bundle.clear()  # type: ignore[attr-defined]
            except Exception: pass

        try:
            _finish_all("submitted", results=results)
        except Exception:
            log.exception("orders_minimal venue accepted but durable outcome update failed")
            raise HTTPException(status_code=503, detail="VENUE_SUBMITTED_RECONCILIATION_REQUIRED")
        _IDEM.record(body.client_order_id, fp, f"submitted:{results[0].venue_order_id}")
        response_payload = {
            "status": "submitted",
            "exchange_order_id": results[0].venue_order_id,
            "exchange_status": "accepted",
            "built": built_context,
            "protection_venue_ids": results[0].protection_venue_ids,
            "stop_attachment_confirmed": results[0].stop_attachment_confirmed,
            "protections_attached": all(
                "STOP" in item.protection_venue_ids or item.stop_attachment_confirmed
                for item in results
            ),
        }
        if campaign_plan is not None:
            response_payload.update({
                "campaign_rung_count": len(results),
                "campaign_margin_usd": campaign_plan.total_margin_usd,
                "wallet_equity_at_plan_usd": str(account.total_equity),
                "hard_stop_price": campaign_plan.hard_stop_price,
                "campaign_orders": [
                    {
                        "rung": index + 1,
                        "exchange_order_id": item.venue_order_id,
                        "protection_venue_ids": item.protection_venue_ids,
                        "stop_attachment_confirmed": item.stop_attachment_confirmed,
                        "built": _built_context(requests_to_submit[index]),
                    }
                    for index, item in enumerate(results)
                ],
            })
        if proof_exempt:
            response_payload["proof_of_life"] = True
            response_payload["unprotected"] = True
            response_payload["note"] = (
                "Proof-of-life entry only — no protective stop attached "
                "(owner-directed). Position is unprotected until closed manually."
            )
        return JSONResponse(sanitize_response(response_payload), status_code=200)
    except HTTPException:
        raise
    except Exception as e:
        # Absolute last resort: log the traceback server-side, return a
        # sanitized subcode. This is the guard that turns any latent
        # AttributeError / KeyError / ValueError into a clean 500 subcode
        # instead of an unhandled FastAPI 500 with a leaked traceback.
        log.exception("orders_minimal_endpoint unhandled")
        raise HTTPException(status_code=500, detail=f"INTERNAL_ERROR:{type(e).__name__}")
    finally:
        try: rest_creds.scrub()
        except Exception: pass
