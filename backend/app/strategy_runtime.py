from __future__ import annotations

import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from pydantic import BaseModel, Field

from .contracts import canonical_json
from .market_data import validate_candles
from .models import Candle, PaperExecutionRequest, RiskPolicy, SignalInput
from .paper import process_paper_signal
from .repository import PaperRepository


class ExecutableRisk(BaseModel):
    allocation_pct: float = Field(default=10, gt=0, le=100)
    stop_loss_pct: float = Field(default=2, gt=0, le=100)
    take_profit_pct: float = Field(default=4, gt=0, le=500)
    fee_bps: float = Field(default=10, ge=0, le=500)
    slippage_bps: float = Field(default=5, ge=0, le=500)


class ExecutableStrategy(BaseModel):
    schema_version: str = "quorumark.executable_strategy.v1"
    symbol: str = Field(min_length=5, max_length=20)
    interval: str = Field(pattern=r"^(1m|5m|15m|1h|4h|1d)$")
    entry_rule: str = "ema_cross_up"
    exit_rule: str = "ema_cross_down"
    fast_window: int = Field(default=3, ge=2, le=50)
    slow_window: int = Field(default=8, ge=3, le=200)
    risk: ExecutableRisk = Field(default_factory=ExecutableRisk)

    @classmethod
    def from_version(cls, strategy: dict[str, Any], definition: dict[str, Any]) -> "ExecutableStrategy":
        existing = definition.get("executable_strategy") if isinstance(definition, dict) else None
        if isinstance(existing, dict):
            return cls.model_validate(existing)

        proposal = definition.get("proposal", {}) if isinstance(definition, dict) else {}
        instruments = proposal.get("instruments") if isinstance(proposal, dict) else None
        symbol = (instruments[0] if isinstance(instruments, list) and instruments else None) or (strategy.get("supported_assets") or [""])[0]
        symbol = re.sub(r"[^A-Za-z0-9]", "", str(symbol)).upper()
        if len(symbol) < 5:
            symbol = f"{symbol}USDT"
        timeframe = str((proposal or {}).get("timeframe", "")) if isinstance(proposal, dict) else ""
        cadence = str(strategy.get("cadence", "Every 4 hours"))
        interval = "1d" if "day" in f"{timeframe} {cadence}".lower() else "1h"
        if "4" in f"{timeframe} {cadence}" and "hour" in f"{timeframe} {cadence}".lower():
            interval = "4h"
        indicators = (proposal or {}).get("indicators", []) if isinstance(proposal, dict) else []
        fast, slow = 3, 8
        if isinstance(indicators, list):
            for indicator in indicators:
                params = indicator.get("parameters", {}) if isinstance(indicator, dict) else {}
                if isinstance(params, dict):
                    fast = int(params.get("fast_window", params.get("fast", fast))) if str(params.get("fast_window", params.get("fast", ""))).isdigit() else fast
                    slow = int(params.get("slow_window", params.get("slow", slow))) if str(params.get("slow_window", params.get("slow", ""))).isdigit() else slow
        if slow <= fast:
            slow = fast + 1
        return cls(symbol=symbol, interval=interval, fast_window=fast, slow_window=slow)

    def as_definition(self) -> dict[str, Any]:
        return {"executable_strategy": self.model_dump(mode="json")}


def _ema(values: list[float], window: int) -> float:
    weight = 2 / (window + 1)
    result = values[0]
    for value in values[1:]:
        result = value * weight + result * (1 - weight)
    return result


def evaluate_candles(strategy: ExecutableStrategy, candles: list[Candle]) -> dict[str, Any]:
    """Evaluate only completed candles; no future values or arbitrary code run."""
    if len(candles) < strategy.slow_window + 2:
        return {"decision": "NO_ACTION", "reason": "Not enough completed candles for this strategy", "entry": None, "stop": None, "target": None}
    closes = [candle.close for candle in candles]
    previous = closes[:-1]
    previous_fast = _ema(previous[-strategy.slow_window :], strategy.fast_window)
    previous_slow = _ema(previous[-strategy.slow_window :], strategy.slow_window)
    current_fast = _ema(closes[-strategy.slow_window :], strategy.fast_window)
    current_slow = _ema(closes[-strategy.slow_window :], strategy.slow_window)
    price = closes[-1]
    if previous_fast <= previous_slow and current_fast > current_slow:
        decision = "BUY"
        reason = "The fast trend moved above the slower trend on the completed candle"
    elif previous_fast >= previous_slow and current_fast < current_slow:
        decision = "SELL"
        reason = "The fast trend moved below the slower trend on the completed candle"
    else:
        decision = "HOLD"
        reason = "No new trend crossing was confirmed on the completed candle"
    return {
        "decision": decision,
        "reason": reason,
        "entry": price,
        "stop": price * (1 - strategy.risk.stop_loss_pct / 100) if decision == "BUY" else price * (1 + strategy.risk.stop_loss_pct / 100),
        "target": price * (1 + strategy.risk.take_profit_pct / 100) if decision == "BUY" else price * (1 - strategy.risk.take_profit_pct / 100),
    }


def observation_key(strategy_id: str, version_id: str, candle: Candle) -> str:
    return hashlib.sha256(canonical_json({"strategy_id": strategy_id, "version_id": version_id, "timestamp": candle.timestamp.isoformat(), "source": candle.source}).encode()).hexdigest()


def _default_policy(strategy: dict[str, Any]) -> RiskPolicy:
    return RiskPolicy(capital=10_000, max_trade=1_500, max_position=2_500, max_loss=250, approved_assets=strategy.get("supported_assets") or ["BTC"], paused=False)


def _subscription_is_active(subscription: dict[str, Any], now: datetime) -> bool:
    if subscription.get("status") != "active":
        return False
    expires_at = subscription.get("expires_at")
    if not expires_at:
        return True
    try:
        expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return expiry > now
    except ValueError:
        return False


def run_autonomous_evaluations(
    repository: PaperRepository,
    *,
    now: datetime | None = None,
    market_fetcher: Callable[[str, str, int], tuple[list[Candle], dict[str, Any]]],
    limit: int = 25,
) -> dict[str, Any]:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    summary: dict[str, Any] = {"evaluated": 0, "skipped": 0, "signals": 0, "paper_decisions": 0, "errors": [], "paper_only": True}
    for strategy in repository.list_strategies(published_only=True)[:limit]:
        version: dict[str, Any] | None = None
        try:
            version = next((item for item in repository.list_versions(strategy["id"]) if item.get("version") == strategy.get("current_version")), None)
            if not version:
                raise ValueError("Published strategy has no current version")
            executable = ExecutableStrategy.from_version(strategy, version.get("definition") or {})
            candles, provenance = market_fetcher(executable.symbol, executable.interval, max(executable.slow_window + 5, 30))
            candles = validate_candles(candles, source=str(provenance.get("source", "market_data")), max_age_seconds=172_800)
            closed = [candle for candle in candles if candle.complete and candle.timestamp <= current]
            if not closed:
                raise ValueError("No completed market candle is available")
            latest = closed[-1]
            key = observation_key(strategy["id"], str(version["id"]), latest)
            if repository.find_autonomous_evaluation(key):
                summary["skipped"] += 1
                continue
            result = evaluate_candles(executable, closed)
            evaluation_id = "eval_" + key[:28]
            evaluation = {
                "id": evaluation_id,
                "strategy_id": strategy["id"],
                "version_id": str(version["id"]),
                "observation_key": key,
                "decision": result["decision"],
                "status": "completed",
                "source": provenance.get("source", latest.source),
                "candle_timestamp": latest.timestamp.isoformat(),
                "payload": {"strategy": executable.model_dump(mode="json"), "result": result, "candle": latest.model_dump(mode="json"), "provenance": provenance},
                "created_at": current.isoformat(),
            }
            repository.save_autonomous_evaluation(evaluation)
            summary["evaluated"] += 1
            if result["decision"] not in {"BUY", "SELL"}:
                continue
            signal_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"quorumark:autonomous:{key}"))
            signal_payload = {**evaluation, "signal_id": signal_id, "signal_source": "autonomous_market_data"}
            repository.save_autonomous_signal(signal_id, strategy["id"], str(version["id"]), signal_payload, current.isoformat())
            summary["signals"] += 1
            side = "long" if result["decision"] == "BUY" else "short"
            for subscription in repository.list_subscriptions_for_strategy(strategy["id"]):
                if not _subscription_is_active(subscription, current):
                    continue
                follower_id = str(subscription["follower_id"])
                policy_data = repository.get_policy(follower_id) or _default_policy(strategy).model_dump()
                policy = RiskPolicy.model_validate({**_default_policy(strategy).model_dump(), **policy_data})
                request = PaperExecutionRequest(
                    follower_id=follower_id,
                    subscription_id=str(subscription["id"]),
                    signal=SignalInput(id=signal_id, strategy_id=strategy["id"], strategy_version=str(version["version"]), strategy_version_id=str(version["id"]), asset=executable.symbol, side=side, entry=result["entry"], stop=result["stop"], target=result["target"], size_pct=executable.risk.allocation_pct, created_at=latest.timestamp),
                    policy=policy,
                    candles=closed,
                    source=str(provenance.get("source", latest.source)),
                )
                process_paper_signal(request, repository)
                summary["paper_decisions"] += 1
        except Exception as error:
            if version and version.get("id"):
                failure_key = hashlib.sha256(canonical_json({
                    "strategy_id": strategy.get("id"),
                    "version_id": str(version["id"]),
                    "failure_hour": current.replace(minute=0, second=0, microsecond=0).isoformat(),
                }).encode()).hexdigest()
                if not repository.find_autonomous_evaluation(failure_key):
                    failure_status = "stale" if "stale" in str(error).lower() else "failed"
                    try:
                        repository.save_autonomous_evaluation({
                            "id": "eval_" + failure_key[:28],
                            "strategy_id": strategy["id"],
                            "version_id": str(version["id"]),
                            "observation_key": failure_key,
                            "decision": "NO_ACTION",
                            "status": failure_status,
                            "source": "autonomous_market_data",
                            "candle_timestamp": current.isoformat(),
                            "payload": {"error_type": type(error).__name__, "message": str(error)},
                            "created_at": current.isoformat(),
                        })
                    except Exception:
                        pass
            summary["errors"].append({"strategy_id": strategy.get("id"), "error": str(error)})
    return summary
