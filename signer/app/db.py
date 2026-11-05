"""DbClient for the signer.

Two backends are available:

* `SupabaseDbClient` — service-role. Used for `order_intents`, `order_audit`,
  and `apex_execution_credentials` (zk-STARK bundle store). All of those
  paths are behind execution flags that stay OFF. The service-role client
  is constructed LAZILY per-method so the signer no longer *requires*
  `SUPABASE_SERVICE_ROLE_KEY` on Railway just to boot the read handlers.

* `WorkerIngestBackedCredsReader` — reads `exchange_credentials` through the
  signed `worker-ingest` edge function using `WORKER_INGEST_SHARED_SECRET`.
  This is the ONLY path used by `/v1/verify-credentials` and
  `/v1/read-account`. It never touches the Supabase Data API directly and
  never receives plaintext credentials.

No table name, filter, or column list is ever accepted from a request body.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


class DbConfigError(Exception):
    pass


# ---------------------------------------------------------------------------
# Service-role client (order_intents / apex_execution_credentials only).
# Lazy: constructed on first service-role call.
# ---------------------------------------------------------------------------

def _client():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        # Names only. Never values.
        raise DbConfigError("MISSING_SUPABASE_SERVICE_CREDENTIALS")
    from supabase import create_client
    return create_client(url, key)


class SupabaseDbClient:
    """Implements the `order_store.DbClient` protocol.

    Only paths reachable through disabled execution flags require the
    service-role key. The read endpoints do not construct this client.
    """

    def __init__(self, client=None) -> None:
        self._c = client  # lazy: built on first use if not injected

    def _cli(self):
        if self._c is None:
            self._c = _client()
        return self._c

    # --- order_intents -----------------------------------------------------
    def fetch_intent(self, user_id: str, client_order_id: str) -> Optional[dict]:
        r = (self._cli().table("order_intents").select(
                "id, user_id, connection_id, client_order_id, environment, "
                "state, state_reason, reduce_only")
             .eq("user_id", user_id).eq("client_order_id", client_order_id)
             .maybe_single().execute())
        return r.data if r and r.data else None

    def update_intent(self, intent_id: str, patch: dict) -> None:
        self._cli().table("order_intents").update(patch).eq("id", intent_id).execute()

    def transition_order_intent(self, *, intent_id: str, user_id: str,
                                state: str, exchange_order_id: Optional[str] = None,
                                state_reason: Optional[str] = None) -> None:
        patch = {"state": state}
        if exchange_order_id:
            patch["exchange_order_id"] = exchange_order_id
        if state_reason:
            patch["state_reason"] = state_reason
        result = (self._cli().table("order_intents").update(patch)
                  .eq("id", intent_id).eq("user_id", user_id).eq("state", "signing")
                  .select("id").execute())
        if not result.data:
            raise DbConfigError("INTENT_NOT_SIGNING")

    # --- order_audit -------------------------------------------------------
    def insert_audit(self, row: dict) -> None:
        self._cli().table("order_audit").insert(row).execute()

    # --- credentials -------------------------------------------------------
    def fetch_active_credential(self, credential_id: str) -> Optional[dict]:
        """ACTIVE and NON-REVOKED only. A revoked credential must be
        unusable — enforced in the query, not by a caller's `if`."""
        r = (self._cli().table("apex_execution_credentials").select(
                "id, user_id, exchange_connection_id, environment, wallet_address, "
                "encrypted_credentials, encryption_key_version, credential_fingerprint, "
                "active, revoked_at")
             .eq("id", credential_id).eq("active", True).is_("revoked_at", "null")
             .maybe_single().execute())
        return r.data if r and r.data else None

    def revoke_credential(self, credential_id: str) -> bool:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        r = (self._cli().table("apex_execution_credentials")
             .update({"active": False, "revoked_at": now, "updated_at": now})
             .eq("id", credential_id).eq("active", True).is_("revoked_at", "null")
             .execute())
        return bool(r and r.data)

    def find_active_credential_for_scope(
        self, *, user_id: str, exchange_connection_id: str,
        environment: str, wallet_address: str,
    ) -> Optional[dict]:
        """The uniqueness scope enforced by
        apex_execution_credentials_one_active. Used by /v1/onboard to
        revoke-and-replace before inserting a fresh bundle.
        Wallet is compared case-insensitively (checksum vs lowercase)."""
        r = (self._cli().table("apex_execution_credentials").select(
                "id, user_id, exchange_connection_id, environment, wallet_address, "
                "encryption_key_version, credential_fingerprint, active, revoked_at")
             .eq("user_id", user_id)
             .eq("exchange_connection_id", exchange_connection_id)
             .eq("environment", environment)
             .ilike("wallet_address", wallet_address)
             .eq("active", True).is_("revoked_at", "null")
             .maybe_single().execute())
        return r.data if r and r.data else None

    def find_active_credential_for_connection(
        self, *, user_id: str, exchange_connection_id: str, environment: str,
    ) -> Optional[dict]:
        """Locate the single ACTIVE, NON-REVOKED credential for a
        (user_id, connection, environment) tuple. Used by /v1/orders where
        the caller supplies the connection id, not the credential id.

        Returns None if no match. Enforces active/revoked filters IN THE
        QUERY — never rely on a caller `if` for revocation."""
        r = (self._cli().table("apex_execution_credentials").select(
                "id, user_id, exchange_connection_id, environment, wallet_address, "
                "encrypted_credentials, encryption_key_version, credential_fingerprint, "
                "active, revoked_at")
             .eq("user_id", user_id)
             .eq("exchange_connection_id", exchange_connection_id)
             .eq("environment", environment)
             .eq("active", True).is_("revoked_at", "null")
             .limit(1).maybe_single().execute())
        return r.data if r and r.data else None

    def insert_credential(self, row: dict) -> dict:
        """Insert a fresh bundle. Returns the inserted row (id at minimum).
        Caller is responsible for revoking any existing active bundle in the
        same scope first — the unique partial index would otherwise raise."""
        r = (self._cli().table("apex_execution_credentials")
             .insert(row).execute())
        data = r.data if r else None
        if not data:
            raise DbConfigError("CREDENTIAL_INSERT_FAILED")
        return data[0] if isinstance(data, list) else data

    # --- kill switch (via SECURITY DEFINER RPC) ---------------------------
    def is_execution_halted(self, user_id: str, connection_id: Optional[str],
                            *, require_live: bool = False) -> bool:
        """Fail-CLOSED: any error means halted. Never returns False on
        transient failure — silent False would authorize a live entry."""
        try:
            if require_live:
                if not connection_id:
                    return True
                connection = (self._cli().table("exchange_connections")
                    .select("is_live,status,permission_trade,permissions_verified")
                    .eq("id", connection_id).eq("user_id", user_id)
                    .maybe_single().execute())
                row = connection.data if connection else None
                if not row or row.get("is_live") is not True or row.get("status") != "verified" \
                        or row.get("permission_trade") is not True or row.get("permissions_verified") is not True:
                    return True
            r = self._cli().rpc("is_execution_halted", {
                "p_user_id": user_id, "p_connection_id": connection_id,
            }).execute()
            v = r.data if r else None
            if isinstance(v, list):
                v = v[0] if v else None
            return bool(v) if v is not None else True
        except Exception:
            return True

    def insert_credential_audit(self, row: dict) -> None:
        """`event` is CHECK-constrained to
        created|verified|rotated|used|revoked|signing_failed. Metadata only."""
        self._cli().table("apex_credential_audit").insert(row).execute()

    # --- exchange_credentials (HMAC REST material) -------------------------
    #
    # DEPRECATED direct path. Kept only for tests that inject a fake `client`.
    # In production, the read handlers use `WorkerIngestBackedCredsReader`
    # via `main._creds_reader()`. This method is unreachable from the read
    # endpoints as of the worker-ingest routing change.
    def fetch_rest_credentials_owned(
        self, user_id: str, connection_id: str
    ) -> Optional[dict]:
        conn = (
            self._cli().table("exchange_connections")
            .select("id, user_id, exchange, environment, status")
            .eq("id", connection_id)
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        row = conn.data if conn and conn.data else None
        if not row or row.get("status") in ("disconnected", "disabled"):
            return None
        cred = (
            self._cli().table("exchange_credentials")
            .select(
                "id, user_id, connection_id, encrypted_api_key, "
                "encrypted_api_secret, encrypted_passphrase, encrypted_omni_seed, encryption_version"
            )
            .eq("connection_id", connection_id)
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        cred_row = cred.data if cred and cred.data else None
        if not cred_row:
            return None
        return {
            **cred_row,
            "exchange": row["exchange"],
            "environment": row["environment"],
            "connection_status": row["status"],
        }

    def touch_connection_verified(self, connection_id: str, user_id: str) -> None:
        """No-op via worker-ingest path. Audit is the source of truth."""
        return None


# ---------------------------------------------------------------------------
# Worker-ingest backed credential reader — the only path the read handlers use.
# ---------------------------------------------------------------------------

def _import_wic():
    """Return the worker-ingest client module.

    Prefer the signer-local packaged copy (`signer/app/worker_ingest_client.py`)
    so Railway deployments with Root Directory `/signer` work without the
    repository-root file. Fall back to the repo-root module when running from
    the monorepo root (e.g. cross-package contract tests).
    """
    try:
        from . import worker_ingest_client as wic  # type: ignore
        return wic
    except ImportError:
        pass
    try:
        import worker_ingest_client as wic  # type: ignore
        return wic
    except ImportError:
        repo_root = Path(__file__).resolve().parents[2]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        import worker_ingest_client as wic  # type: ignore
        return wic


class WorkerIngestBackedCredsReader:
    """Reads encrypted credential rows via the signed worker-ingest path.

    Never touches the Data API directly. Never receives plaintext. Every
    call is bounded by the underlying HTTP timeout (see
    `worker_ingest_client.REQUEST_TIMEOUT`).
    """

    def __init__(self, client=None) -> None:
        if client is not None:
            self._c = client
            return
        wic = _import_wic()
        supabase_url = os.environ.get("SUPABASE_URL")
        if not supabase_url:
            raise DbConfigError("MISSING_SUPABASE_URL")
        # Delegates all secret/env validation to the client constructor.
        self._c = wic.WorkerIngestClient(supabase_url)

    def fetch_rest_credentials_owned(
        self, user_id: str, connection_id: str
    ) -> Optional[dict]:
        wic = _import_wic()
        try:
            cred = self._c.read_exchange_credentials_owned(
                user_id=user_id, connection_id=connection_id,
            )
        except wic.WorkerIngestAuthError as e:
            msg = str(e)
            if "HTTP_404" in msg:
                return None
            raise
        if not cred:
            return None
        # Adapt to the shape the read handlers expect.
        return {
            "id": None,
            "user_id": user_id,
            "connection_id": connection_id,
            "encrypted_api_key": cred["encrypted_api_key"],
            "encrypted_api_secret": cred["encrypted_api_secret"],
            "encrypted_passphrase": cred.get("encrypted_passphrase"),
            "encrypted_omni_seed": cred.get("encrypted_omni_seed"),
            "encryption_version": cred["encryption_version"],
            "exchange": cred["exchange"],
            "environment": cred["environment"],
            "connection_status": cred["connection_status"],
            "permission_trade": cred.get("permission_trade"),
            "permissions_verified": cred.get("permissions_verified"),
        }

    def touch_connection_verified(self, connection_id: str, user_id: str) -> None:
        # Not exposed via worker-ingest; audit is the source of truth.
        return None


# ---------------------------------------------------------------------------
# Worker-ingest backed DB client for the /v1/orders hot path.
#
# The Railway signer cannot read SUPABASE_SERVICE_ROLE_KEY on Lovable Cloud,
# so the service role stays inside the worker-ingest edge function. This
# client routes the four /v1/orders service-role calls
# (find_active_credential_for_connection, is_execution_halted,
# insert_audit, insert_credential_audit, plus an unused-by-/v1/orders
# insert_order_intent stub for future callers) through the same HMAC-signed
# transport as WorkerIngestBackedCredsReader.
#
# Methods not reachable from /v1/orders (fetch_intent, update_intent,
# fetch_active_credential, revoke_credential, find_active_credential_for_scope,
# insert_credential, touch_connection_verified, fetch_rest_credentials_owned)
# raise NotImplementedError. Callers that need them are legacy endpoints
# outside this refactor's scope; opt in with
# `SIGNER_USE_LEGACY_SERVICE_ROLE_DB=true` (local tests only — the key is
# not available on production Lovable Cloud).
# ---------------------------------------------------------------------------

class WorkerIngestBackedDbClient:
    """Implements the subset of `SupabaseDbClient` that /v1/orders needs,
    via the signed worker-ingest edge function. Never holds a service role."""

    def __init__(self, client=None) -> None:
        if client is not None:
            self._c = client
            return
        wic = _import_wic()
        supabase_url = os.environ.get("SUPABASE_URL")
        if not supabase_url:
            raise DbConfigError("MISSING_SUPABASE_URL")
        self._c = wic.WorkerIngestClient(supabase_url)

    # --- credentials (used by /v1/orders) ---------------------------------
    def find_active_credential_for_connection(
        self, *, user_id: str, exchange_connection_id: str, environment: str,
    ) -> Optional[dict]:
        return self._c.find_active_apex_credential(
            user_id=user_id,
            exchange_connection_id=exchange_connection_id,
            environment=environment,
        )

    # --- kill switch (used by /v1/orders) ---------------------------------
    def is_execution_halted(self, user_id: str, connection_id: Optional[str],
                            *, require_live: bool = False) -> bool:
        """Fail-CLOSED: any transport error returns True (halted)."""
        try:
            return bool(self._c.check_execution_halted(
                user_id=user_id, connection_id=connection_id,
                **({"require_live": True} if require_live else {}),
            ))
        except Exception:
            return True

    # --- audits / intents -------------------------------------------------
    def insert_audit(self, row: dict) -> None:
        self._c.insert_order_audit_row(row)

    def insert_credential_audit(self, row: dict) -> None:
        self._c.insert_apex_credential_audit_row(row)

    def insert_order_intent(self, row: dict) -> Optional[str]:
        return self._c.insert_order_intent_row(row)

    def transition_order_intent(self, *, intent_id: str, user_id: str,
                                state: str, exchange_order_id: Optional[str] = None,
                                state_reason: Optional[str] = None) -> None:
        self._c.transition_order_intent(
            intent_id=intent_id, user_id=user_id, state=state,
            exchange_order_id=exchange_order_id, state_reason=state_reason,
        )

    # --- unsupported (legacy endpoints only) ------------------------------
    def synfutures_campaign_operation(self, **payload):
        return self._c.synfutures_campaign_operation(**payload)

    def synfutures_account_context(self, **scope):
        return self._c.synfutures_account_context(**scope)

    def list_synfutures_transactions(self, **scope):
        return self._c.list_synfutures_transactions(**scope)

    def reserve_synfutures_transaction(self, **transaction):
        return self._c.reserve_synfutures_transaction(**transaction)

    def observe_synfutures_transaction(self, **observation):
        return self._c.observe_synfutures_transaction(**observation)

    def list_aster_intents(self, **scope):
        return self._c.list_aster_intents(**scope)

    def reconcile_aster_order(self, **observation):
        return self._c.reconcile_aster_order(**observation)

    def fetch_intent(self, user_id: str, client_order_id: str) -> Optional[dict]:
        raise NotImplementedError(
            "fetch_intent not routed via worker-ingest; set "
            "SIGNER_USE_LEGACY_SERVICE_ROLE_DB=true for local tests only.")

    def update_intent(self, intent_id: str, patch: dict) -> None:
        raise NotImplementedError(
            "update_intent not routed via worker-ingest; set "
            "SIGNER_USE_LEGACY_SERVICE_ROLE_DB=true for local tests only.")

    def fetch_active_credential(self, credential_id: str) -> Optional[dict]:
        raise NotImplementedError(
            "fetch_active_credential not routed via worker-ingest; "
            "/v1/orders uses find_active_credential_for_connection instead.")

    def revoke_credential(self, credential_id: str) -> bool:
        raise NotImplementedError(
            "revoke_credential not routed via worker-ingest; legacy path only.")

    def find_active_credential_for_scope(self, **_kw) -> Optional[dict]:
        raise NotImplementedError(
            "find_active_credential_for_scope not routed via worker-ingest; "
            "onboarding uses the caller-JWT path.")

    def insert_credential(self, row: dict) -> dict:
        raise NotImplementedError(
            "insert_credential not routed via worker-ingest; "
            "onboarding uses the caller-JWT path.")

    def touch_connection_verified(self, connection_id: str, user_id: str) -> None:
        return None

    def fetch_rest_credentials_owned(self, user_id: str, connection_id: str) -> Optional[dict]:
        raise NotImplementedError(
            "use WorkerIngestBackedCredsReader for exchange_credentials reads.")
