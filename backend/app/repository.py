from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PaperRepository:
    """Durable local development ledger; production should use Quorumark Supabase tables."""

    def __init__(self, path: str | None = None):
        configured = path or os.getenv("QUORUMARK_SQLITE_PATH", "backend/.data/quorumark.db")
        self.path = Path(configured)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript("""
              create table if not exists backtest_runs (
                id text primary key, strategy_version text not null, evidence_class text not null,
                source text not null, payload text not null, created_at text not null
              );
              create table if not exists paper_decisions (
                id text primary key, signal_id text not null, follower_id text not null,
                status text not null, reason_code text not null, payload text not null, created_at text not null,
                unique(signal_id, follower_id)
              );
              create table if not exists paper_executions (
                id text primary key, idempotency_key text not null unique, decision_id text not null,
                follower_id text not null, payload text not null, created_at text not null
              );
              create table if not exists strategies (
                id text primary key, slug text not null unique, creator_id text not null,
                name text not null, thesis text not null, market text not null,
                supported_assets text not null, risk_class text not null, cadence text not null,
                monthly_price real not null, status text not null, current_version text not null,
                evidence_class text not null, created_at text not null, published_at text
              );
              create table if not exists strategy_versions (
                id text primary key, strategy_id text not null, version text not null,
                definition text not null, backtest_id text, backtest_metrics text,
                evidence_hash text, created_at text not null, unique(strategy_id, version)
              );
              create table if not exists subscriptions (
                id text primary key, strategy_id text not null, follower_id text not null,
                status text not null, environment text not null, created_at text not null,
                cancelled_at text, unique(strategy_id, follower_id)
              );
              create table if not exists risk_policies (
                follower_id text primary key, payload text not null, updated_at text not null
              );
              create table if not exists publication_evidence (
                id text primary key, strategy_id text not null, version_id text not null unique,
                creator_near_account text not null, commitment text not null, schema_version text not null,
                network text not null, status text not null, transaction_hash text, transaction_receiver text,
                block_height integer, receipt text, requested_at text not null, confirmed_at text
              );
              create table if not exists ai_evaluations (
                id text primary key, kind text not null, provider text not null,
                model text not null, actor_id text not null, input text not null,
                output text not null, status text not null, created_at text not null
              );
            """)

    def save_ai_evaluation(self, record: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute(
                "insert into ai_evaluations values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), record["kind"], record["provider"], record["model"], record["actor_id"], json.dumps(record["input"], sort_keys=True), json.dumps(record["output"], sort_keys=True), record["status"], record["created_at"]),
            )

    def save_backtest(self, run_id: str, strategy_version: str, source: str, payload: dict[str, Any], created_at: str) -> None:
        with self._connect() as db:
            db.execute("insert or replace into backtest_runs values (?, ?, ?, ?, ?, ?)", (run_id, strategy_version, "backtested", source, json.dumps(payload, sort_keys=True), created_at))

    def find_execution(self, key: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("select payload from paper_executions where idempotency_key = ?", (key,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def save_decision(self, decision: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute("insert or replace into paper_decisions values (?, ?, ?, ?, ?, ?, ?)", (decision["id"], decision["signal_id"], decision["follower_id"], decision["status"], decision["reason_code"], json.dumps(decision, sort_keys=True), decision["created_at"]))

    def save_execution(self, execution: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute("insert or replace into paper_executions values (?, ?, ?, ?, ?, ?)", (execution["id"], execution["idempotency_key"], execution["decision_id"], execution["follower_id"], json.dumps(execution, sort_keys=True), execution["created_at"]))

    def list_executions(self, follower_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("select payload from paper_executions where follower_id = ? order by created_at", (follower_id,)).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def save_strategy(self, strategy: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute(
                """insert into strategies
                (id, slug, creator_id, name, thesis, market, supported_assets, risk_class, cadence,
                 monthly_price, status, current_version, evidence_class, created_at, published_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (strategy["id"], strategy["slug"], strategy["creator_id"], strategy["name"], strategy["thesis"],
                 strategy["market"], json.dumps(strategy["supported_assets"]), strategy["risk_class"],
                 strategy["cadence"], strategy["monthly_price"], strategy["status"], strategy["current_version"],
                 strategy["evidence_class"], strategy["created_at"], strategy["published_at"]),
            )

    def get_strategy(self, strategy_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("select * from strategies where id = ? or slug = ?", (strategy_id, strategy_id)).fetchone()
        if not row:
            return None
        value = dict(row)
        value["supported_assets"] = json.loads(value["supported_assets"])
        return value

    def list_strategies(self, published_only: bool = True, creator_id: str | None = None) -> list[dict[str, Any]]:
        query = "select * from strategies"
        params: list[str] = []
        clauses: list[str] = []
        if published_only:
            clauses.append("status = 'published'")
        if creator_id:
            clauses.append("creator_id = ?")
            params.append(creator_id)
        if clauses:
            query += " where " + " and ".join(clauses)
        query += " order by created_at desc"
        with self._connect() as db:
            rows = db.execute(query, params).fetchall()
        values = []
        for row in rows:
            value = dict(row)
            value["supported_assets"] = json.loads(value["supported_assets"])
            values.append(value)
        return values

    def update_strategy(self, strategy_id: str, creator_id: str, **changes: Any) -> dict[str, Any] | None:
        current = self.get_strategy(strategy_id)
        if not current or current["creator_id"] != creator_id:
            return None
        assignments = ", ".join(f"{key} = ?" for key in changes)
        with self._connect() as db:
            db.execute(f"update strategies set {assignments} where id = ? and creator_id = ?", [*changes.values(), current["id"], creator_id])
        return self.get_strategy(current["id"])

    def save_strategy_version(self, strategy_id: str, version: str, definition: dict[str, Any], backtest_id: str | None, metrics: dict[str, Any] | None, digest: str | None, created_at: str) -> dict[str, Any]:
        version_id = "ver_" + uuid.uuid4().hex[:20]
        with self._connect() as db:
            db.execute(
                "insert or replace into strategy_versions values (?, ?, ?, ?, ?, ?, ?, ?)",
                (version_id, strategy_id, version, json.dumps(definition, sort_keys=True), backtest_id, json.dumps(metrics, sort_keys=True) if metrics else None, digest, created_at),
            )
        return {"id": version_id, "strategy_id": strategy_id, "version": version, "content_hash": digest, "backtest_id": backtest_id}

    def list_versions(self, strategy_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("select * from strategy_versions where strategy_id = ? order by created_at desc", (strategy_id,)).fetchall()
        values = []
        for row in rows:
            value = dict(row)
            value["definition"] = json.loads(value["definition"])
            value["backtest_metrics"] = json.loads(value["backtest_metrics"]) if value["backtest_metrics"] else None
            values.append(value)
        return values

    def save_publication_evidence(self, record: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as db:
            db.execute(
                """insert or replace into publication_evidence
                (id, strategy_id, version_id, creator_near_account, commitment, schema_version, network,
                 status, transaction_hash, transaction_receiver, block_height, receipt, requested_at, confirmed_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (record["id"], record["strategy_id"], record["version_id"], record["creator_near_account"],
                 record["commitment"], record["schema_version"], record["network"], record["status"],
                 record.get("transaction_hash"), record.get("transaction_receiver"), record.get("block_height"),
                 json.dumps(record.get("receipt")) if record.get("receipt") is not None else None,
                 record["requested_at"], record.get("confirmed_at")),
            )
        return record

    def get_publication_evidence(self, version_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("select * from publication_evidence where version_id = ?", (version_id,)).fetchone()
        if not row:
            return None
        record = dict(row)
        record["receipt"] = json.loads(record["receipt"]) if record["receipt"] else None
        return record

    def update_publication_evidence(self, version_id: str, **changes: Any) -> dict[str, Any] | None:
        assignments = ", ".join(f"{key} = ?" for key in changes)
        with self._connect() as db:
            db.execute(f"update publication_evidence set {assignments} where version_id = ?", [*changes.values(), version_id])
        return self.get_publication_evidence(version_id)

    def save_subscription(self, strategy_id: str, follower_id: str, environment: str) -> dict[str, Any]:
        record = {"id": "sub_" + uuid.uuid4().hex[:20], "strategy_id": strategy_id, "follower_id": follower_id, "status": "active", "environment": environment, "created_at": utc_now(), "cancelled_at": None}
        with self._connect() as db:
            db.execute("insert into subscriptions values (?, ?, ?, ?, ?, ?, ?)", tuple(record.values()))
            return record

    def cancel_subscription(self, strategy_id: str, follower_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "select * from subscriptions where strategy_id = ? and follower_id = ?",
                (strategy_id, follower_id),
            ).fetchone()
            if not row:
                return None
            cancelled_at = utc_now()
            db.execute(
                "update subscriptions set status = 'cancelled', cancelled_at = ? where strategy_id = ? and follower_id = ?",
                (cancelled_at, strategy_id, follower_id),
            )
        result = dict(row)
        result.update(status="cancelled", cancelled_at=cancelled_at)
        return result

    def list_subscriptions(self, follower_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("select * from subscriptions where follower_id = ? order by created_at desc", (follower_id,)).fetchall()
        return [dict(row) for row in rows]

    def save_policy(self, follower_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        updated_at = utc_now()
        with self._connect() as db:
            db.execute("insert or replace into risk_policies values (?, ?, ?)", (follower_id, json.dumps(payload, sort_keys=True), updated_at))
        return {**payload, "follower_id": follower_id, "updated_at": updated_at}

    def get_policy(self, follower_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("select payload, updated_at from risk_policies where follower_id = ?", (follower_id,)).fetchone()
        if not row:
            return None
        return {**json.loads(row["payload"]), "follower_id": follower_id, "updated_at": row["updated_at"]}
