from __future__ import annotations

from .models import AgentEvaluationRequest, AgentEvaluationResponse


def evaluate_strategy(request: AgentEvaluationRequest) -> AgentEvaluationResponse:
    """Deterministic safety review; no model provider is called."""
    notes = [
        "Backtest outputs are simulated and require human review.",
        "Follower risk limits must be enforced independently of creator signals.",
    ]
    if request.risk_class == "high":
        notes.append("High-risk classification requires an explicit follower acknowledgement.")
    return AgentEvaluationResponse(
        provider="disabled",
        strategy_name=request.strategy_name,
        risk_notes=notes,
    )
