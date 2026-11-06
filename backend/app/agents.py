from __future__ import annotations

import os

from .models import AgentEvaluationRequest, AgentEvaluationResponse


def evaluate_strategy(request: AgentEvaluationRequest) -> AgentEvaluationResponse:
    """Deterministic safety review; model providers are opt-in and never trade."""
    provider = os.getenv("AI_PROVIDER", "disabled")
    notes = [
        "Backtest outputs are simulated and require human review.",
        "Follower risk limits must be enforced independently of creator signals.",
    ]
    if request.risk_class == "high":
        notes.append("High-risk classification requires an explicit follower acknowledgement.")
    return AgentEvaluationResponse(
        provider="configured" if provider not in {"", "disabled"} else "disabled",
        strategy_name=request.strategy_name,
        risk_notes=notes,
    )
