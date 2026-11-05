"""ApeX Omni account registration.

Mirrors the pinned SDK's `HttpPrivate_v3.generate_nonce_v3` +
`register_user_v3` pair (`apexomni/http_private_v3.py`) but does the HTTP
directly with `httpx` so we don't pull in the SDK's web3/eth session setup
on the signer host.

Called from `/v1/register-account` after we've already decrypted the
STARK bundle for the caller (seeds + l2_key). Returns the freshly minted
ApeX REST API credentials (`key`, `secret`, `passphrase`). The signer
returns them to the edge function INSIDE the HMAC-signed response body;
the edge re-encrypts under `TURTLE_CREDENTIAL_ENCRYPTION_KEY` and writes
`exchange_credentials`. Plaintext never reaches the browser.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import httpx

from apexomni import zklink_sdk as sdk

from .apex_omni_rest import base_url, _canon_env

# Same starkex EC order the SDK's register_user_v3 uses.
_EC_ORDER = 3618502788666131213697322783095070105526743751716087489154079457884512865583

# Default zkLink chain ids per environment (SDK `NETWORKID_OMNI_*`).
_DEFAULT_CHAIN_IDS = {"mainnet": 9, "testnet": 11}

_TIMEOUT_SECONDS = 10.0
_MAX_RESPONSE_BYTES = 512 * 1024


class RegisterError(Exception):
    """Stable code only. Never carries request/response bodies."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RegisteredAccount:
    api_key: str
    api_secret: str
    passphrase: str
    account_id: str | None
    ethereum_address: str
    environment: str

    def sanitized(self) -> dict:
        # Never include the credential values here — this dict is safe for
        # host logs / audit metadata only.
        return {
            "account_id": self.account_id,
            "ethereum_address_tail": self.ethereum_address[-6:].lower(),
            "environment": self.environment,
            "api_key_prefix": (self.api_key or "")[:6],
        }


def default_chain_id(environment: str) -> int:
    env = _canon_env(environment)
    return _DEFAULT_CHAIN_IDS.get(env, 9)


def _post(url: str, body: dict, headers: dict | None = None) -> dict:
    hdrs = {"accept": "application/json", "content-type": "application/json"}
    if headers:
        hdrs.update(headers)
    try:
        with httpx.Client(
            timeout=httpx.Timeout(_TIMEOUT_SECONDS, connect=_TIMEOUT_SECONDS),
            follow_redirects=False,
        ) as c:
            r = c.post(url, content=json.dumps(body), headers=hdrs)
    except httpx.TimeoutException:
        raise RegisterError("UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        raise RegisterError("UPSTREAM_UNREACHABLE")
    if r.status_code == 401 or r.status_code == 403:
        raise RegisterError("UPSTREAM_UNAUTHORIZED")
    if r.status_code == 429:
        raise RegisterError("RATE_LIMITED")
    if r.status_code >= 500:
        raise RegisterError("UPSTREAM_UNAVAILABLE")
    if r.status_code != 200:
        raise RegisterError(f"UPSTREAM_HTTP_{r.status_code}")
    body_bytes = r.content[:_MAX_RESPONSE_BYTES]
    try:
        payload: Any = json.loads(body_bytes.decode("utf-8", errors="replace"))
    except Exception:
        raise RegisterError("BAD_RESPONSE_JSON")
    if not isinstance(payload, dict):
        raise RegisterError("BAD_RESPONSE_JSON")
    code = payload.get("code")
    if code not in (0, "0", None):
        # Preserve ApeX's structured error subcode so the owner can act.
        msg = payload.get("msg") or payload.get("message") or "APEX_ERROR"
        # Truncate to keep host logs bounded and never echo secrets.
        raise RegisterError(f"APEX_{str(code)}:{str(msg)[:80]}")
    return payload


def _fetch_nonce(environment: str, l2_key: str, ethereum_address: str, chain_id: int) -> str:
    url = base_url(environment) + "/api/v3/generate-nonce"
    payload = _post(
        url,
        {
            "l2Key": l2_key,
            "ethAddress": ethereum_address,
            "chainId": chain_id,
            "category": "CATEGORY_API",
            "refresh": "false",
        },
    )
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    nonce = data.get("nonce") if isinstance(data, dict) else None
    if not isinstance(nonce, (str, int)) or str(nonce) == "":
        raise RegisterError("NONCE_MISSING")
    return str(nonce)


def _sign_onboarding(l2_key: str, ethereum_address: str, nonce: str, seeds_hex: str) -> tuple[str, str]:
    """Reproduce the SDK's onboarding signature. Returns (signature, apiKeyHash)."""
    msg = (l2_key.removeprefix("0x") + ethereum_address + str(nonce)).lower()
    digest = hashlib.sha256(msg.encode("utf-8")).digest()
    bn1 = int(digest.hex(), 16)
    sign_msg_hex = hex(bn1 % _EC_ORDER).removeprefix("0x")
    try:
        signer = sdk.ZkLinkSigner.new_from_seed(bytes.fromhex(seeds_hex.removeprefix("0x")))
        auth = signer.sign_musig(sign_msg_hex.encode())
    except Exception:
        raise RegisterError("ZK_SIGN_FAILED")
    signature = str(auth.signature)
    api_key_hash = hex(bn1).removeprefix("0x") + "|" + sign_msg_hex
    return signature, api_key_hash


def register_account(
    *,
    environment: str,
    l2_key: str,
    seeds_hex: str,
    ethereum_address: str,
    chain_id: int | None = None,
) -> RegisteredAccount:
    """Full generate-nonce → new-onboarding round-trip. Idempotent on
    ApeX's side: re-registering an already-registered wallet returns the
    same account with existing apiKey material.
    """
    env = _canon_env(environment)
    eth = ethereum_address  # canonicalized upstream in main.py
    cid = chain_id if chain_id is not None else default_chain_id(env)

    nonce = _fetch_nonce(env, l2_key, eth, cid)
    signature, api_key_hash = _sign_onboarding(l2_key, eth, nonce, seeds_hex)

    url = base_url(env) + "/api/v3/new-onboarding"
    payload = _post(
        url,
        {
            "l2Key": l2_key,
            "ethereumAddress": eth,
            "category": "CATEGORY_API",
            "apiKeyHash": api_key_hash,
        },
        headers={
            "APEX-SIGNATURE": signature,
            "APEX-ETHEREUM-ADDRESS": eth,
        },
    )
    data = payload.get("data") if isinstance(payload.get("data"), dict) else None
    if not isinstance(data, dict):
        raise RegisterError("ONBOARDING_SHAPE_UNEXPECTED")
    api_key = data.get("apiKey")
    if not isinstance(api_key, dict):
        raise RegisterError("APIKEY_MISSING")
    key = api_key.get("key")
    secret = api_key.get("secret")
    passphrase = api_key.get("passphrase")
    if not (isinstance(key, str) and isinstance(secret, str) and isinstance(passphrase, str)):
        raise RegisterError("APIKEY_FIELDS_MISSING")
    account = data.get("account") if isinstance(data.get("account"), dict) else {}
    account_id = str(account.get("id") or account.get("accountId") or "") or None
    return RegisteredAccount(
        api_key=key,
        api_secret=secret,
        passphrase=passphrase,
        account_id=account_id,
        ethereum_address=eth,
        environment=env,
    )
