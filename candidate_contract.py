"""Canonical TurtleBot strategy-candidate contract (Python side).

READ-ONLY / PURE. This module computes identity and evidence hashes for a
naturally generated deterministic strategy candidate. It performs no I/O,
holds no credential, and cannot reach the broker, the signer, or any venue.

The TypeScript mirror is `src/lib/candidate/contract.ts`. Both sides MUST
produce byte-identical canonical strings; `tests/fixtures/candidate/contract_v1.json`
is the cross-language parity fixture that proves it.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional

CANDIDATE_SCHEMA_VERSION = "candidate.v1"

DIRECTIONS = ("long", "short")


def _canonical_number(value: float) -> str:
    """Language-neutral decimal form.

    Plain `json.dumps` and `JSON.stringify` disagree on float formatting, so
    every number is rendered through a fixed 10-decimal form and trimmed. Both
    languages implement exactly this, which is what makes the hash portable.
    """
    text = "{:.10f}".format(float(value))
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def canonical_json(value: Any) -> str:
    """Stable, key-sorted, number-normalised serialization."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _canonical_number(value)
    if isinstance(value, str):
        # json.dumps gives us correct escaping; JSON.stringify matches it for
        # the ASCII/UTF-8 payloads this contract allows.
        import json

        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            import json

            parts.append(json.dumps(str(k), ensure_ascii=False) + ":" + canonical_json(value[k]))
        return "{" + ",".join(parts) + "}"
    raise TypeError("uncanonicalisable value of type %s" % type(value).__name__)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def evidence_hash(evidence: Any) -> str:
    """Full sha256 of the immutable deterministic evidence block."""
    return _sha256_hex(canonical_json(evidence))


def candidate_id(
    *,
    strategy: str,
    connection_id: str,
    symbol: str,
    direction: str,
    candle_close_ms: int,
    confirmation_ref: str,
) -> str:
    """Deterministic, idempotent identity for one natural candidate.

    Identical strategy/connection/symbol/direction/completed candle/
    confirmation always yields the same id, across processes and restarts.
    Contains no credential and no personal data — `connection_id` is an opaque
    application UUID, never a venue key.
    """
    if direction not in DIRECTIONS:
        raise ValueError("direction must be long|short")
    seed = "|".join(
        [
            CANDIDATE_SCHEMA_VERSION,
            str(strategy).strip().lower(),
            str(connection_id).strip(),
            str(symbol).strip().upper(),
            direction,
            str(int(candle_close_ms)),
            str(confirmation_ref).strip(),
        ]
    )
    return "cand_v1_" + _sha256_hex(seed)[:32]


def build_candidate(
    *,
    strategy: str,
    connection_id: str,
    symbol: str,
    timeframe: str,
    direction: str,
    candle_close_ms: int,
    confirmation_ref: str,
    market_data_ts_ms: int,
    evidence: dict,
    entry_zone: Optional[dict] = None,
    invalidation: Optional[float] = None,
    tp_ladder: Optional[list] = None,
) -> dict:
    """Assemble the versioned wire contract shared with TypeScript.

    `freshness_ms` is recorded, never used as an execution gate here: staleness
    policy belongs to the deterministic worker, not to this contract.
    """
    cid = candidate_id(
        strategy=strategy,
        connection_id=connection_id,
        symbol=symbol,
        direction=direction,
        candle_close_ms=candle_close_ms,
        confirmation_ref=confirmation_ref,
    )
    return {
        "schema_version": CANDIDATE_SCHEMA_VERSION,
        "candidate_id": cid,
        "connection_id": str(connection_id),
        "strategy": str(strategy).strip().lower(),
        "symbol": str(symbol).strip().upper(),
        "timeframe": str(timeframe),
        "direction": direction,
        "candle_close_ms": int(candle_close_ms),
        "confirmation_ref": str(confirmation_ref),
        "market_data_ts_ms": int(market_data_ts_ms),
        "freshness_ms": int(market_data_ts_ms) - int(candle_close_ms),
        "entry_zone": entry_zone,
        "invalidation": invalidation,
        "tp_ladder": list(tp_ladder or []),
        "evidence": evidence,
        "evidence_hash": evidence_hash(evidence),
    }
