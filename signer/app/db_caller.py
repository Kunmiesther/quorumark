"""Caller-scoped backend REST client for /v1/onboard.

The onboarding path writes to `apex_execution_credentials` and
`apex_credential_audit`. Both tables now have owner-scoped RLS
(auth.uid() = user_id) plus INSERT/UPDATE grants to `authenticated`,
so the signer no longer needs `SUPABASE_SERVICE_ROLE_KEY` on Railway
for onboarding — it acts on behalf of the caller by attaching the
caller's Supabase JWT to the PostgREST request.

No table name, filter, or column list is ever accepted from the caller.
"""
from __future__ import annotations

import os
import json
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

import requests

from .db import DbConfigError


def _publishable_key() -> str | None:
    return (
        os.environ.get("SUPABASE_PUBLISHABLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY")
        or os.environ.get("VITE_SUPABASE_ANON_KEY")
    )


def build_caller_client(caller_jwt: str):
    """Construct a small PostgREST client scoped to the caller's JWT.

    Requires `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` on the signer
    host. `SUPABASE_SERVICE_ROLE_KEY` is NOT required for this path.

    We intentionally do NOT use supabase-py here. The version pinned in the
    signer image can treat new `sb_publishable_*` keys as bearer JWTs, which
    makes PostgREST reject the request with `Invalid API key`. Raw REST keeps
    the opaque publishable key in `apikey` and the caller's real JWT in
    `Authorization`, which is the required header split for RLS.
    """
    url = os.environ.get("SUPABASE_URL")
    pub = _publishable_key()
    if not url or not pub:
        raise DbConfigError("MISSING_SUPABASE_PUBLISHABLE_CREDENTIALS")
    if not caller_jwt:
        raise DbConfigError("MISSING_CALLER_JWT")
    return CallerPostgrestClient(url=url.rstrip("/"), publishable_key=pub.strip(), caller_jwt=caller_jwt.strip())


class CallerPostgrestClient:
    def __init__(self, *, url: str, publishable_key: str, caller_jwt: str) -> None:
        self._base = f"{url}/rest/v1"
        self._session = requests.Session()
        self._headers = {
            "apikey": publishable_key,
            "authorization": f"Bearer {caller_jwt}",
            "content-type": "application/json",
        }

    def _url(self, table: str) -> str:
        return f"{self._base}/{quote(table, safe='')}"

    def request(self, method: str, table: str, *, params: dict | None = None, body: object | None = None, prefer: str | None = None) -> object:
        headers = dict(self._headers)
        if prefer:
            headers["prefer"] = prefer
        resp = self._session.request(
            method,
            self._url(table),
            headers=headers,
            params=params,
            data=json.dumps(body) if body is not None else None,
            timeout=10,
        )
        if resp.status_code >= 400:
            raise DbConfigError(f"CALLER_DB_HTTP_{resp.status_code}")
        if not resp.text:
            return None
        try:
            return resp.json()
        except ValueError as e:
            raise DbConfigError("CALLER_DB_BAD_JSON") from e


class CallerScopedDbClient:
    """Implements the subset of DbClient methods used by /v1/onboard,
    executing every write as the caller (RLS enforced).
    """

    def __init__(self, caller_jwt: str, client=None) -> None:
        self._c = client or build_caller_client(caller_jwt)

    # --- credentials ------------------------------------------------------
    def find_active_credential_for_scope(
        self, *, user_id: str, exchange_connection_id: str,
        environment: str, wallet_address: str,
    ) -> Optional[dict]:
        data = self._c.request("GET", "apex_execution_credentials", params={
            "select": "id,user_id,exchange_connection_id,environment,wallet_address,encryption_key_version,credential_fingerprint,active,revoked_at",
            "user_id": f"eq.{user_id}",
            "exchange_connection_id": f"eq.{exchange_connection_id}",
            "environment": f"eq.{environment}",
            "wallet_address": f"ilike.{wallet_address}",
            "active": "eq.true",
            "revoked_at": "is.null",
            "limit": "1",
        })
        if isinstance(data, list) and data:
            return data[0]
        return None

    def revoke_credential(self, credential_id: str) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        data = self._c.request("PATCH", "apex_execution_credentials", params={
            "select": "id,active,revoked_at,updated_at",
            "id": f"eq.{credential_id}",
            "active": "eq.true",
            "revoked_at": "is.null",
        }, body={"active": False, "revoked_at": now, "updated_at": now}, prefer="return=representation")
        return bool(data)

    def insert_credential(self, row: dict) -> dict:
        # Request only the non-secret columns the authenticated role is
        # allowed to SELECT. PostgREST otherwise expands
        # `return=representation` to every column, including the encrypted
        # bundle, and correctly rejects the response even though the INSERT
        # itself is owner-scoped by RLS.
        data = self._c.request(
            "POST",
            "apex_execution_credentials",
            params={
                "select": (
                    "id,user_id,exchange_connection_id,environment,wallet_address,"
                    "encryption_key_version,credential_fingerprint,active,created_at"
                )
            },
            body=row,
            prefer="return=representation",
        )
        if not data:
            raise DbConfigError("CREDENTIAL_INSERT_FAILED")
        return data[0] if isinstance(data, list) else data

    def insert_credential_audit(self, row: dict) -> None:
        self._c.request("POST", "apex_credential_audit", body=row, prefer="return=minimal")
