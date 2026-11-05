"""Canonical deterministic decision contract (Python side).

READ-ONLY / PURE. This module computes the identity, the evidence hash and
the wire shape of ONE immutable decision for ONE completed candle. It
performs no I/O, holds no credential, and cannot reach the broker, the
signer, or any venue.

WHY THIS REPLACES THE CANDIDATE CONTRACT ON THE LIVE PATH
---------------------------------------------------------
`candidate_contract.py` only had an identity for a setup that CONFIRMED:
there was no record for a candle that resolved to WAIT, so every downstream
surface had to infer "no candidate" and render it as "no decision", "gate
not passed" or "AI unavailable". None of those were true.

A decision is produced for EVERY completed candle on every verified live
connection, including WAIT. `strategy_candidates` is preserved as historical
data and is no longer written by the live path.

IDENTITY
--------
    decision_id = f(schema, connection_id, symbol, candle_close_ms)

Identity is EXACTLY the database's uniqueness tuple — no wider, no narrower.
Two fields the owner's tuple names are deliberately absent from the seed:

  * `direction` is an OUTPUT of the deterministic reduction. Seeding identity
    with it would make the id self-referential: a retry that reduced
    differently would mint a second identity for the same immutable evidence,
    which is exactly the duplication this contract exists to prevent.
  * `strategy` is determined BY the candle. `routing.leg_for_regime` arms
    exactly one leg per completed candle, so (connection, symbol, candle)
    already fixes the strategy. Seeding with it would let a fail-closed
    record written under `unrouted` and a later evaluation under `sweep`
    both claim the same candle.

Both are recorded as attributes of the decision. The first write for a
candle wins and is immutable; a divergent retry re-reads it rather than
recording a second decision.

The TypeScript mirror is `src/lib/decision/contract.ts`. Both sides MUST
produce byte-identical canonical strings; `tests/fixtures/decision/contract_v1.json`
is the cross-language parity fixture that proves it.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Optional

DECISION_SCHEMA_VERSION = "decision.v1"

DIRECTIONS = ("long", "short", "wait")
TRADE_DIRECTIONS = ("long", "short")


# ---------------------------------------------------------------------------
# Stable machine reason codes. CLOSED SET — a reader may switch on these.
# Adding a code is a contract change; changing the meaning of one is not
# allowed. Every code answers "why this direction, on this candle".
# ---------------------------------------------------------------------------
REASON_CODES = frozenset({
    # Tradeable outcomes
    "LONG_CONFIRMED",
    "SHORT_CONFIRMED",
    # Deterministic WAIT outcomes
    "NO_CONFIRMED_ENTRY",
    "REGIME_WAIT",
    "REGIME_UNAVAILABLE",
    # NOTE: re-entry lockout is deliberately NOT a decision reason. It is a
    # clock-dependent policy state, not a property of the completed candle, so
    # it is enforced as safety check 3 (`REENTRY_LOCKOUT_ACTIVE`) instead. A
    # code here that nothing can emit is exactly the dead branch a reader
    # switching on this set would waste time handling.
    "STOP_DISTANCE_UNAVAILABLE",
    # NOTE: there is no code for "long and short both confirmed". That is not
    # a refusal — the reducer takes the first confirmation in the caller's
    # order, which is precisely the trade the pre-refactor bridges submitted
    # first. Standing down would refuse a trade the old code placed.
    "EVALUATOR_NOT_WIRED",
    "TURTLE_NOT_ENABLED",
    "CANDLE_STALE",
    # Higher-timeframe authorization refusals for the SWEEP leg. A 5m sweep is
    # EXECUTION-ONLY: without a fresh, non-conflicting 4h+1h thesis confirmed
    # on 15m, the candle is recorded as one of these WAITs and nothing is sent.
    "HTF_ALIGNMENT_REQUIRED",
    "HTF_DATA_MISSING",
    "HTF_DATA_STALE",
    "HTF_INSUFFICIENT_HISTORY",
    "M15_CONFIRMATION_REQUIRED",
    "REGIME_OPPOSES_DIRECTION",

    # NOTE: there is no code here for "the feed failed" or "the evaluator
    # crashed". A decision claims its candle permanently, so recording one for
    # a transient failure would burn a candle the next cycle could still have
    # traded. Those failures are reported on the SIGNAL_EVALUATION event and
    # the candle stays open — see bot_worker's feed/evaluator error paths.
})


def iso_ms(ms: int) -> str:
    """UTC ISO-8601 with a trailing Z, from epoch milliseconds."""
    return (
        datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _canonical_number(value: float) -> str:
    """Language-neutral decimal form — identical to candidate_contract."""
    text = "{:.10f}".format(float(value))
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def canonical_json(value: Any) -> str:
    """Stable, key-sorted, number-normalised serialization."""
    import json

    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _canonical_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            parts.append(json.dumps(str(k), ensure_ascii=False) + ":" + canonical_json(value[k]))
        return "{" + ",".join(parts) + "}"
    raise TypeError("uncanonicalisable value of type %s" % type(value).__name__)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def evidence_hash(evidence: Any) -> str:
    """Full sha256 of the immutable deterministic evidence block."""
    return _sha256_hex(canonical_json(evidence))


def decision_id(
    *,
    connection_id: str,
    symbol: str,
    candle_close_ms: int,
) -> str:
    """Deterministic, idempotent identity for one completed candle.

    The same connection/symbol/completed candle always yields the same id,
    across processes, restarts and concurrent retries. Contains no credential
    and no personal data — `connection_id` is an opaque application UUID,
    never a venue key.
    """
    seed = "|".join(
        [
            DECISION_SCHEMA_VERSION,
            str(connection_id).strip(),
            str(symbol).strip().upper(),
            str(int(candle_close_ms)),
        ]
    )
    return "dec_v1_" + _sha256_hex(seed)[:32]


def build_decision(
    *,
    connection_id: str,
    symbol: str,
    strategy: str,
    candle_close_ms: int,
    direction: str,
    reason_code: str,
    reason: str,
    evidence: dict,
    created_at_ms: int,
    entry_zone: Optional[dict] = None,
    invalidation: Optional[float] = None,
    take_profits: Optional[list] = None,
) -> dict:
    """Assemble the versioned wire contract shared with TypeScript.

    Raises ValueError on an out-of-contract direction or reason code: a
    decision that cannot be described precisely must not be recorded at all.

    `entry_zone`, `invalidation` and `take_profits` are the deterministic
    strategy geometry as computed from the completed candle. They are a
    RECORD, not an instruction: the signer re-derives protective levels from
    the live mark at submission time and remains authoritative.
    """
    if direction not in DIRECTIONS:
        raise ValueError("direction must be long|short|wait")
    if reason_code not in REASON_CODES:
        raise ValueError("unknown reason_code")
    if direction == "wait" and reason_code in ("LONG_CONFIRMED", "SHORT_CONFIRMED"):
        raise ValueError("wait cannot carry a confirmation reason code")
    if direction == "long" and reason_code != "LONG_CONFIRMED":
        raise ValueError("long requires LONG_CONFIRMED")
    if direction == "short" and reason_code != "SHORT_CONFIRMED":
        raise ValueError("short requires SHORT_CONFIRMED")

    did = decision_id(
        connection_id=connection_id,
        symbol=symbol,
        candle_close_ms=candle_close_ms,
    )
    zone = None
    if isinstance(entry_zone, dict) and entry_zone.get("low") is not None and entry_zone.get("high") is not None:
        zone = {"low": float(entry_zone["low"]), "high": float(entry_zone["high"])}
    return {
        "schema_version": DECISION_SCHEMA_VERSION,
        "decision_id": did,
        "connection_id": str(connection_id),
        "symbol": str(symbol).strip().upper(),
        "strategy": str(strategy).strip().lower(),
        "candle_close_at": iso_ms(candle_close_ms),
        "candle_close_ms": int(candle_close_ms),
        "direction": direction,
        "reason_code": reason_code,
        "reason": str(reason)[:200],
        "entry_zone": zone,
        "invalidation": None if invalidation is None else float(invalidation),
        "take_profits": [float(t) for t in (take_profits or [])],
        # The immutable snapshot itself travels with the decision so the AI
        # committee evaluates EXACTLY what the strategy saw. Without it the
        # models would be reasoning about a re-fetched, slightly different
        # market and the matching evidence hash would be a fiction.
        "evidence": evidence,
        "evidence_hash": evidence_hash(evidence),
        "created_at": iso_ms(created_at_ms),
    }
