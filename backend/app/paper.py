from __future__ import annotations

import uuid
from datetime import datetime, timezone

from .contracts import evidence_hash, idempotency_key
from .market_data import validate_candles
from .models import Execution, PaperExecutionRequest, PaperExecutionResponse, RiskDecisionResponse
from .repository import PaperRepository
from .risk import evaluate_signal_risk


def process_paper_signal(request: PaperExecutionRequest, repository: PaperRepository) -> PaperExecutionResponse:
    candles = validate_candles(request.candles, source=request.source, max_age_seconds=request.policy.max_data_age_seconds)
    signal = request.signal
    key = request.idempotency_key or idempotency_key(signal.model_dump(mode="json"), request.follower_id)
    existing = repository.find_execution(key)
    if existing:
        return PaperExecutionResponse(decision=RiskDecisionResponse(**existing["decision"]), execution=Execution(**existing["execution"]) if existing.get("execution") else None, idempotency_key=key, evidence_hash=existing["evidence_hash"], execution_id=existing.get("execution_id"))

    risk = evaluate_signal_risk(signal, request.policy, candles)
    decision = {
        "status": risk.status,
        "reason_code": risk.reason_code,
        "reason": risk.reason,
        "notional": round(risk.notional, 8),
        "quantity": round(risk.quantity, 12),
        "reserved_capital": round(risk.reserved_capital, 8),
        "estimated_loss": round(risk.estimated_loss, 8),
    }
    decision_id = "dec_" + uuid.uuid5(uuid.NAMESPACE_URL, f"{key}:decision").hex[:24]
    created_at = datetime.now(timezone.utc).isoformat()
    provenance = {
        "signal_id": signal.id,
        "asset": signal.asset,
        "strategy_id": signal.strategy_id,
        "strategy_version": signal.strategy_version,
        "strategy_version_id": signal.strategy_version_id,
        "subscription_id": request.subscription_id,
        "signal_source": request.source,
    }
    decision_record = {"id": decision_id, "signal_id": signal.id, "follower_id": request.follower_id, "created_at": created_at, **provenance, **decision}
    repository.save_decision(decision_record)
    execution = None
    if risk.status == "accepted":
        slippage = request.policy.slippage_bps / 10_000
        entry = signal.entry * (1 + slippage * (1 if signal.side == "long" else -1))
        remaining = [c for c in candles if c.timestamp >= signal.created_at]
        exit_price = signal.target if signal.side == "long" else signal.target
        reason = "target_not_reached_marked_at_latest_close"
        for candle in remaining:
            stop_hit = candle.low <= signal.stop if signal.side == "long" else candle.high >= signal.stop
            target_hit = candle.high >= signal.target if signal.side == "long" else candle.low <= signal.target
            if stop_hit:
                exit_price = signal.stop
                reason = "stop_loss"
                break
            if target_hit:
                exit_price = signal.target
                reason = "take_profit"
                break
            exit_price = candle.close
        quantity = risk.quantity
        exit_price *= 1 - slippage if signal.side == "long" else 1 + slippage
        gross_pnl = quantity * (exit_price - entry) if signal.side == "long" else quantity * (entry - exit_price)
        fee = (quantity * entry + quantity * exit_price) * request.policy.fee_bps / 10_000
        execution = Execution(timestamp=datetime.now(timezone.utc), side="sell" if signal.side == "long" else "buy", price=exit_price, quantity=quantity, fee=fee, realized_pnl=gross_pnl - fee, order_type="exit", position_id="pos_" + uuid.uuid4().hex[:16], slippage=0, reason=reason, notional=risk.notional, follower_id=request.follower_id)
    execution_id = "exec_" + uuid.uuid4().hex[:20] if execution else None
    response_data = {"decision": decision, "execution": execution.model_dump(mode="json") if execution else None, **provenance, "evidence_hash": evidence_hash({"signal": signal.model_dump(mode="json"), "decision": decision, "execution": execution.model_dump(mode="json") if execution else None, **provenance}), "idempotency_key": key, "execution_id": execution_id}
    repository.save_execution({"id": execution_id or "decision_" + uuid.uuid4().hex[:20], "idempotency_key": key, "decision_id": decision_id, "follower_id": request.follower_id, "created_at": created_at, **response_data})
    return PaperExecutionResponse(decision=RiskDecisionResponse(**decision), execution=execution, idempotency_key=key, evidence_hash=response_data["evidence_hash"], execution_id=execution_id)
