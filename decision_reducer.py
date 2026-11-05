"""Deterministic reduction: one completed candle -> exactly one direction.

PURE. No I/O, no credentials, no venue access, no clock read. Every input is
supplied by the caller and every output is a function of those inputs, so
running this twice over the same completed candle yields the same decision.

WHAT THIS REPLACES
------------------
The worker previously carried three near-identical live bridges (§5a
Accumulator, §5b Hunter, §5c Sweep). Each decided independently whether to
fire, each `continue`d silently on its own private refusal (no confirmation,
no stop distance, stale candle, gate blocked), and none of them recorded a
WAIT. A symbol could therefore sit for hours with nothing persisted and the
UI would report "no decision" when in truth a deterministic WAIT had been
computed and thrown away.

Here, every one of those branches produces a NAMED WAIT with a stable
reason code. Nothing is silent.

WHAT IS DELIBERATELY *NOT* HERE
-------------------------------
  * Re-entry lockout. Lockout is a policy state that changes with the clock,
    not a property of the completed candle. Hashing it would make the
    evidence for one candle depend on WHEN it was evaluated. It is enforced
    as a SAFETY check (conflicting exposure) instead — a locked-out setup
    still cannot trade, and now the record says so precisely.
  * Sizing, equity, connection permissions, kill switches. Those are safety
    checks that run only after a LONG or SHORT decision exists.
  * Any AI, Scout, Onyx or candidate input. A decision is derived from
    market structure alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

import decision_contract as dc


# Gate block codes emitted by entry_guard.evaluate_entry_authorization.
_GATE_CODE_TO_REASON = {
    "wait_regime": "REGIME_WAIT",
    "no_regime": "REGIME_UNAVAILABLE",
    "no_leg": "REGIME_UNAVAILABLE",
}


@dataclass(frozen=True)
class DirectionInput:
    """One direction's deterministic evaluator output for this candle."""

    direction: str                       # "long" | "short"
    confirmed: bool
    # Human-usable detail from the evaluator when it did NOT confirm.
    reason_detail: str = ""
    # Geometry, present only on a confirmation.
    entry_price: Optional[float] = None
    entry_zone: Optional[dict] = None
    invalidation: Optional[float] = None
    take_profits: Sequence[float] = ()
    stop_pct: Optional[float] = None
    # Cross-cycle identity of the confirmation (break/retest ts, FVG ts,
    # sweep dedup key). Recorded in evidence; never a clock read.
    confirmation_ref: str = ""
    # The EXACT idempotency key this confirmation would carry to the broker.
    # Unchanged from the pre-refactor bridges — it is the correlation spine
    # between a decision and its order intent, and the broker's duplicate
    # protection depends on its formula not moving.
    idempotency_key: str = ""
    # Extra candle-derived facts for the evidence block. Must be JSON-safe
    # and must NOT contain anything time-varying.
    evidence: dict = field(default_factory=dict)
    # HIGHER-TIMEFRAME AUTHORIZATION (sweep leg).
    #
    # `htf_gate_required` marks a strategy whose 15m trigger is execution-only.
    # For such a strategy the reducer refuses to let a confirmation win unless
    # `htf_authorized` is True — a second, structural stop so that a 15m
    # condition alone can never produce a live long/short decision even if a
    # caller mistakenly marks the direction confirmed.
    htf_gate_required: bool = False
    htf_authorized: bool = False
    # Static reason code from a deterministic refusal (HTF gate, etc.). When
    # nothing confirms, this is recorded verbatim as the decision's reason.
    refusal_code: Optional[str] = None



@dataclass(frozen=True)
class Reduction:
    direction: str
    reason_code: str
    reason: str
    entry_zone: Optional[dict]
    invalidation: Optional[float]
    take_profits: list
    evidence: dict
    # The winning DirectionInput, or None for a WAIT. The caller needs it to
    # build the order intent; it is never persisted verbatim.
    chosen: Optional[DirectionInput]


_NO_ENTRY_PROSE = {
    "accumulator": "No confirmed break-and-retest on the newest 15m candle",
    "vanguard": "No confirmed break-and-retest on the newest 15m candle",
    "hunter": "No fair-value gap retest on the newest 15m candle",
    "sweep": "No liquidity sweep and reclaim on the newest 15m candle",
}


def _wait(
    reason_code: str,
    reason: str,
    evidence: dict,
) -> Reduction:
    return Reduction(
        direction="wait",
        reason_code=reason_code,
        reason=reason,
        entry_zone=None,
        invalidation=None,
        take_profits=[],
        evidence=evidence,
        chosen=None,
    )


def reduce_decision(
    *,
    strategy: str,
    candle_close_ms: int,
    directions: Sequence[DirectionInput],
    regime: Optional[str],
    trend_age_candles: Optional[int],
    guard_authorized: bool,
    guard_block_code: Optional[str],
    evaluator_wired: bool,
    candle_fresh: bool,
    turtle_route_authorized: bool = True,
    market_context: Optional[dict] = None,
    executing_turtle: Optional[str] = None,
) -> Reduction:
    """Collapse both evaluated directions into ONE decision.

    Order matters and is fail-closed: an input that could not be trusted
    produces a WAIT before any confirmation is allowed to win.

    `market_context` is the bounded, candle-derived price series that travels
    inside the evidence. It makes the evidence a real immutable snapshot
    rather than a summary, which is what lets the AI committee evaluate
    exactly what the strategy evaluated.
    """
    evidence: dict = {
        "strategy": str(strategy).strip().lower(),
        "candle_close_ms": int(candle_close_ms),
        "regime": regime,
        "trend_age_candles": trend_age_candles,
        "guard_authorized": bool(guard_authorized),
        "guard_block_code": guard_block_code,
        "turtle_route_authorized": bool(turtle_route_authorized),
        "directions": {
            d.direction: {
                "confirmed": bool(d.confirmed),
                "confirmation_ref": d.confirmation_ref,
                **({k: v for k, v in sorted(d.evidence.items())} if d.evidence else {}),
            }
            for d in sorted(directions, key=lambda x: x.direction)
        },
    }
    if executing_turtle is not None:
        evidence["executing_turtle"] = executing_turtle
    if market_context:
        evidence["market"] = market_context

    # 1. The evaluator exists, but the owner did not include the routed Turtle
    #    in this mandate. This is a policy refusal, not a wiring defect. Keeping
    #    the two states separate makes the live console actionable and prevents
    #    operators from chasing a nonexistent deployment failure.
    if not turtle_route_authorized:
        return _wait(
            "TURTLE_NOT_ENABLED",
            f"An executing Turtle for strategy '{strategy}' is not enabled in this mandate",
            evidence,
        )

    # 2. The regime routed to a leg this worker has no evaluator for.
    if not evaluator_wired:
        return _wait(
            "EVALUATOR_NOT_WIRED",
            f"Regime armed '{strategy}', which has no evaluator in this worker",
            evidence,
        )

    # 3. The newest completed candle is too old to describe the market.
    if not candle_fresh:
        return _wait(
            "CANDLE_STALE",
            "Newest completed candle is outside the freshness window",
            evidence,
        )

    confirmed = [d for d in directions if d.confirmed]

    # 4. Nothing confirmed — the ordinary, overwhelmingly common outcome.
    #    Recorded as a first-class decision, not as an absence. A deterministic
    #    refusal code (e.g. the sweep HTF gate) is preserved verbatim so the
    #    record says exactly WHY, not merely "nothing confirmed".
    if not confirmed:
        refusal = next((d.refusal_code for d in directions if d.refusal_code), None)
        detail = next((d.reason_detail for d in directions if d.reason_detail), "")
        base = _NO_ENTRY_PROSE.get(
            str(strategy).strip().lower(), "No confirmed entry on the newest 15m candle"
        )
        if refusal and refusal in dc.REASON_CODES:
            return _wait(refusal, f"{base} — refused: {refusal}"
                         f"{f' ({detail})' if detail else ''}", evidence)
        return _wait("NO_CONFIRMED_ENTRY", f"{base}{f' ({detail})' if detail else ''}", evidence)


    # 4. Both directions confirmed on one candle — rare, and NOT a refusal.
    #
    #    The pre-refactor bridges looped over SIGNAL_DIRECTIONS and submitted
    #    an intent for each confirmation, so the FIRST one in that order is the
    #    trade that actually reached the venue; the second always hit the
    #    signer's single-position preflight and was rejected. Taking the first
    #    confirmation in the caller's order therefore preserves exactly the
    #    trade that was placed before, loses nothing that was ever filled, and
    #    still yields one decision per candle.
    #
    #    Standing down here would refuse a trade the old code placed. That is
    #    not this module's call to make.
    winner = confirmed[0]
    if len(confirmed) > 1:
        evidence["multiple_confirmations"] = [d.direction for d in confirmed]

    # 4b. EXECUTION-ONLY 5m enforcement. A strategy whose trigger only refines
    #     timing (sweep) cannot create a long/short decision without a real
    #     higher-timeframe authorization travelling with the confirmation.
    if winner.htf_gate_required and not winner.htf_authorized:
        code = winner.refusal_code if winner.refusal_code in dc.REASON_CODES else "HTF_ALIGNMENT_REQUIRED"
        return _wait(
            code,
            f"{winner.direction.upper()} 15m trigger present but higher-timeframe"
            f" authorization missing ({code})",
            evidence,
        )

    # 5. Confirmed, but the deterministic regime guard refuses new entries.

    if not guard_authorized:
        code = _GATE_CODE_TO_REASON.get(str(guard_block_code or ""), "REGIME_UNAVAILABLE")
        return _wait(
            code,
            f"{winner.direction.upper()} confirmed but regime guard blocked it"
            f" ({guard_block_code or 'unknown'})",
            evidence,
        )

    # 6. Confirmed and authorized, but no provable structural stop distance.
    #    Never defaulted — an unproven stop is a refusal.
    if winner.stop_pct is None or not (winner.stop_pct > 0):
        return _wait(
            "STOP_DISTANCE_UNAVAILABLE",
            f"{winner.direction.upper()} confirmed but no sane structural stop distance",
            evidence,
        )

    reason_code = "LONG_CONFIRMED" if winner.direction == "long" else "SHORT_CONFIRMED"
    return Reduction(
        direction=winner.direction,
        reason_code=reason_code,
        reason=(
            f"{winner.direction.upper()} confirmed on the newest 15m candle"
            f" ({strategy})"
        ),
        entry_zone=winner.entry_zone,
        invalidation=winner.invalidation,
        take_profits=list(winner.take_profits or []),
        evidence=evidence,
        chosen=winner,
    )


def take_profit_levels(
    *,
    entry_price: float,
    stop_pct: float,
    direction: str,
    rr_multiples: Sequence[float],
) -> list:
    """Indicative TP levels for the recorded decision.

    Geometry mirrors the signer's ladder (`R = |mark - stop_trigger|`,
    TP = mark ± rr·R) using the candle close in place of the live mark. This
    is a RECORD for the operator and the chart, not an instruction: the
    signer recomputes every protective level from the live mark at submission
    and stays authoritative. No value here is sent to the signer.
    """
    if not (entry_price > 0) or not (stop_pct > 0):
        return []
    r = entry_price * stop_pct
    sign = 1.0 if direction == "long" else -1.0
    out = []
    for rr in rr_multiples:
        level = entry_price + sign * float(rr) * r
        if level > 0:
            out.append(round(level, 8))
    return out


__all__ = [
    "DirectionInput",
    "Reduction",
    "reduce_decision",
    "take_profit_levels",
    "dc",
]
