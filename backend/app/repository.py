from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any


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
            """)

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
