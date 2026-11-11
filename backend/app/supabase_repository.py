from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx


class SupabaseRepository:
    """Server-only repository backed by Quorumark's Supabase Data API.

    It uses a secret key and never exposes that key to the browser. Hosted startup
    fails closed if this adapter is not configured; SQLite is only for local tests.
    """

    def __init__(self) -> None:
        self.url = os.getenv("QUORUMARK_SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL", "")
        self.key = os.getenv("QUORUMARK_SUPABASE_SECRET_KEY", "")
        if not self.url or not self.key or not self.key.startswith(("sb_secret_", "eyJ")):
            raise RuntimeError("QUORUMARK_SUPABASE_URL and a server-only Supabase secret key are required")
        headers = {"apikey": self.key, "Accept": "application/json"}
        if self.key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {self.key}"
        self.client = httpx.Client(timeout=20, headers=headers)

    def _request(self, method: str, table: str, *, params: dict[str, str] | None = None, body: Any = None, prefer: str | None = None) -> list[dict[str, Any]]:
        headers = {"Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        response = self.client.request(method, f"{self.url.rstrip('/')}/rest/v1/{table}", params=params, json=body, headers=headers)
        if not response.is_success:
            detail = response.text[:300]
            raise RuntimeError(f"Supabase {method} {table} failed ({response.status_code}): {detail}")
        if not response.content:
            return []
        value = response.json()
        return value if isinstance(value, list) else [value]

    def save_backtest(self, run_id: str, strategy_version: str, source: str, payload: dict[str, Any], created_at: str) -> None:
        body = {"id": run_id, "evidence_class": "backtested", "data_source": source, "payload": payload, "evidence_hash": payload.get("evidence_hash", "")}
        if len(strategy_version) == 36 and strategy_version.count("-") == 4:
            body["strategy_version_id"] = strategy_version
        self._request("POST", "strategy_exchange_backtest_runs", body=body, prefer="resolution=merge-duplicates")

    def save_ai_evaluation(self, record: dict[str, Any]) -> None:
        self._request("POST", "strategy_exchange_ai_evaluations", body=record, prefer="return=representation")

    def find_execution(self, key: str) -> dict[str, Any] | None:
        rows = self._request("GET", "strategy_exchange_paper_executions", params={"idempotency_key": f"eq.{key}", "select": "payload"})
        return rows[0].get("payload") if rows else None

    def save_decision(self, decision: dict[str, Any]) -> None:
        self._request("POST", "strategy_exchange_paper_decisions", body={"id": decision["id"], "signal_id": decision["signal_id"], "follower_id": decision["follower_id"], "status": decision["status"], "reason_code": decision["reason_code"], "payload": decision, "created_at": decision["created_at"]}, prefer="resolution=merge-duplicates")

    def save_execution(self, execution: dict[str, Any]) -> None:
        self._request("POST", "strategy_exchange_paper_executions", body={"id": execution["id"], "idempotency_key": execution["idempotency_key"], "decision_id": execution["decision_id"], "follower_id": execution["follower_id"], "payload": execution, "created_at": execution["created_at"]}, prefer="resolution=merge-duplicates")

    def list_executions(self, follower_id: str) -> list[dict[str, Any]]:
        rows = self._request("GET", "strategy_exchange_paper_executions", params={"follower_id": f"eq.{follower_id}", "select": "payload", "order": "created_at.asc"})
        return [row["payload"] for row in rows]

    def save_strategy(self, strategy: dict[str, Any]) -> None:
        self._request("POST", "strategy_exchange_strategies", body={"id": strategy["id"], "creator_id": strategy["creator_id"], "slug": strategy["slug"], "name": strategy["name"], "thesis": strategy["thesis"], "market": strategy["market"], "supported_assets": strategy["supported_assets"], "risk_class": strategy["risk_class"], "cadence": strategy["cadence"], "monthly_price": strategy["monthly_price"], "status": strategy["status"], "current_version": strategy["current_version"], "evidence_class": strategy["evidence_class"], "created_at": strategy["created_at"]}, prefer="return=representation")

    def get_strategy(self, strategy_id: str) -> dict[str, Any] | None:
        for field in ("id", "slug"):
            rows = self._request("GET", "strategy_exchange_strategies", params={field: f"eq.{strategy_id}", "select": "*", "limit": "1"})
            if rows:
                return rows[0]
        return None

    def get_wallet_identity(self, user_id: str, chain: str = "near") -> dict[str, Any] | None:
        rows = self._request(
            "GET",
            "wallet_identities",
            params={"user_id": f"eq.{user_id}", "chain": f"eq.{chain}", "select": "*", "order": "created_at.desc", "limit": "1"},
        )
        return rows[0] if rows else None

    def list_strategies(self, published_only: bool = True, creator_id: str | None = None) -> list[dict[str, Any]]:
        params = {"select": "*", "order": "created_at.desc"}
        if published_only:
            params["status"] = "eq.published"
        if creator_id:
            params["creator_id"] = f"eq.{creator_id}"
        return self._request("GET", "strategy_exchange_strategies", params=params)

    def update_strategy(self, strategy_id: str, creator_id: str, **changes: Any) -> dict[str, Any] | None:
        current = self.get_strategy(strategy_id)
        if not current or current.get("creator_id") != creator_id:
            return None
        rows = self._request("PATCH", "strategy_exchange_strategies", params={"id": f"eq.{current['id']}", "creator_id": f"eq.{creator_id}"}, body=changes, prefer="return=representation")
        return rows[0] if rows else self.get_strategy(current["id"])

    def save_strategy_version(self, strategy_id: str, version: str, definition: dict[str, Any], backtest_id: str | None, metrics: dict[str, Any] | None, digest: str | None, created_at: str) -> dict[str, Any]:
        body = {"strategy_id": strategy_id, "version": version, "definition": definition, "backtest_id": backtest_id, "backtest_metrics": metrics, "content_hash": digest, "created_at": created_at}
        rows = self._request("POST", "strategy_exchange_versions", body=body, prefer="resolution=merge-duplicates,return=representation")
        return rows[0] if rows else body

    def list_versions(self, strategy_id: str) -> list[dict[str, Any]]:
        return self._request("GET", "strategy_exchange_versions", params={"strategy_id": f"eq.{strategy_id}", "select": "*", "order": "created_at.desc"})

    def save_publication_evidence(self, record: dict[str, Any]) -> dict[str, Any]:
        rows = self._request("POST", "strategy_exchange_publication_evidence", body=record, prefer="resolution=merge-duplicates,return=representation")
        return rows[0] if rows else record

    def get_publication_evidence(self, version_id: str) -> dict[str, Any] | None:
        rows = self._request("GET", "strategy_exchange_publication_evidence", params={"version_id": f"eq.{version_id}", "select": "*", "limit": "1"})
        return rows[0] if rows else None

    def update_publication_evidence(self, version_id: str, **changes: Any) -> dict[str, Any] | None:
        rows = self._request("PATCH", "strategy_exchange_publication_evidence", params={"version_id": f"eq.{version_id}"}, body=changes, prefer="return=representation")
        return rows[0] if rows else None

    def save_subscription(self, strategy_id: str, follower_id: str, environment: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        body = {"strategy_id": strategy_id, "follower_id": follower_id, "status": "active", "environment": environment, "starts_at": now.isoformat(), "expires_at": (now + timedelta(days=30)).isoformat()}
        rows = self._request("POST", "strategy_exchange_subscriptions", body=body, prefer="resolution=merge-duplicates,return=representation")
        return rows[0] if rows else body

    def list_subscriptions(self, follower_id: str) -> list[dict[str, Any]]:
        return self._request("GET", "strategy_exchange_subscriptions", params={"follower_id": f"eq.{follower_id}", "select": "*", "order": "created_at.desc"})

    def cancel_subscription(self, strategy_id: str, follower_id: str) -> dict[str, Any] | None:
        rows = self._request(
            "PATCH",
            "strategy_exchange_subscriptions",
            params={"strategy_id": f"eq.{strategy_id}", "follower_id": f"eq.{follower_id}"},
            body={"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()},
            prefer="return=representation",
        )
        return rows[0] if rows else None

    def save_policy(self, follower_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {"follower_id": follower_id, "capital": payload["capital"], "max_trade": payload["max_trade"], "max_position": payload["max_position"], "max_loss": payload["max_loss"], "max_slippage_bps": payload["max_slippage_bps"], "approved_assets": payload["approved_assets"], "paused": payload["paused"]}
        rows = self._request("POST", "strategy_exchange_risk_policies", body=body, prefer="resolution=merge-duplicates,return=representation")
        return rows[0] if rows else body

    def get_policy(self, follower_id: str) -> dict[str, Any] | None:
        rows = self._request("GET", "strategy_exchange_risk_policies", params={"follower_id": f"eq.{follower_id}", "select": "*", "limit": "1"})
        return rows[0] if rows else None
