from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


SIGNAL_SCHEMA_VERSION = "quorumark.signal.v1"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def evidence_hash(evidence: Any) -> str:
    return hashlib.sha256(canonical_json(evidence).encode("utf-8")).hexdigest()


def signal_id(strategy_id: str, strategy_version: str, asset: str, created_at: datetime, side: str) -> str:
    timestamp = created_at.astimezone(timezone.utc).isoformat()
    seed = "|".join((SIGNAL_SCHEMA_VERSION, strategy_id.strip(), strategy_version.strip(), asset.upper(), side, timestamp))
    return "sig_v1_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


def idempotency_key(signal: dict[str, Any], follower_id: str) -> str:
    return "exec_v1_" + hashlib.sha256(canonical_json({"signal": signal, "follower_id": follower_id.strip()}).encode("utf-8")).hexdigest()[:40]
