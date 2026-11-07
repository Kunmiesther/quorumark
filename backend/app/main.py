import os
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .agents import evaluate_strategy
from .engine import run_reference_backtest
from .models import AgentEvaluationRequest, AgentEvaluationResponse, BacktestRequest, BacktestResponse, PaperExecutionRequest, PaperExecutionResponse
from .paper import process_paper_signal
from .repository import PaperRepository
from .supabase_repository import SupabaseRepository
from .security import require_verified_identity
from .marketplace import (
    PolicyRequest,
    StrategyDraftRequest,
    StrategyVersionRequest,
    SubscriptionRequest,
    create_strategy,
    require_local_identity,
    to_public_strategy,
)

app = FastAPI(title="Quorumark Strategy Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)
if os.getenv("QUORUMARK_PYTHON_ENVIRONMENT", "local").lower() == "local":
    repository = PaperRepository()
else:
    repository = SupabaseRepository()


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"service": "quorumark-python-engine", "status": "ok", "paper_only": True}


@app.post("/v1/backtests/reference", response_model=BacktestResponse)
def reference_backtest(request: BacktestRequest) -> BacktestResponse:
    result = run_reference_backtest(request)
    repository.save_backtest(result.backtest_id or "bt_unknown", request.strategy_version, result.data_source, result.model_dump(mode="json"), result.signals[0].timestamp.isoformat() if result.signals else "now")
    return result


@app.post("/v1/paper/executions", response_model=PaperExecutionResponse)
def paper_execution(request: PaperExecutionRequest, identity: str = Depends(require_verified_identity)) -> PaperExecutionResponse:
    return process_paper_signal(request.model_copy(update={"follower_id": identity}), repository)


@app.get("/v1/paper/executions")
def paper_executions(identity: str = Depends(require_verified_identity)) -> list[dict[str, object]]:
    return repository.list_executions(identity)


@app.get("/v1/strategies")
def strategies() -> list[dict[str, object]]:
    return [to_public_strategy(item) for item in repository.list_strategies()]


@app.get("/v1/strategies/mine")
def my_strategies(identity: str = Depends(require_local_identity)) -> list[dict[str, object]]:
    return repository.list_strategies(published_only=False, creator_id=identity)


@app.post("/v1/strategies", status_code=201)
def create_strategy_route(request: StrategyDraftRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    return create_strategy(repository, identity, request)


@app.post("/v1/strategies/{strategy_id}/versions", status_code=201)
def create_version(strategy_id: str, request: StrategyVersionRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy["creator_id"] != identity:
        raise HTTPException(status_code=404, detail="Strategy not found")
    repository.save_strategy_version(strategy["id"], request.version, request.definition, request.backtest_id, request.backtest_metrics, request.evidence_hash, datetime.now(timezone.utc).isoformat())
    updated = repository.update_strategy(strategy["id"], identity, current_version=request.version)
    return updated or strategy


@app.post("/v1/strategies/{strategy_id}/publish")
def publish_strategy(strategy_id: str, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy["creator_id"] != identity:
        raise HTTPException(status_code=404, detail="Strategy not found")
    if not repository.list_versions(strategy["id"]):
        raise HTTPException(status_code=409, detail="Create a version before publishing")
    updated = repository.update_strategy(strategy["id"], identity, status="published", published_at=datetime.now(timezone.utc).isoformat())
    return updated or strategy


@app.get("/v1/strategies/{strategy_id}/versions")
def strategy_versions(strategy_id: str) -> list[dict[str, object]]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy["status"] != "published":
        raise HTTPException(status_code=404, detail="Published strategy not found")
    return repository.list_versions(strategy["id"])


@app.post("/v1/subscriptions", status_code=201)
def subscribe(request: SubscriptionRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    strategy = repository.get_strategy(request.strategy_id)
    if not strategy or strategy["status"] != "published":
        raise HTTPException(status_code=404, detail="Published strategy not found")
    try:
        return repository.save_subscription(strategy["id"], identity, request.environment)
    except Exception as error:
        if "unique" in str(error).lower():
            existing = next((item for item in repository.list_subscriptions(identity) if item["strategy_id"] == strategy["id"] and item["status"] == "active"), None)
            if existing:
                return existing
        raise HTTPException(status_code=409, detail="Subscription could not be created") from error


@app.get("/v1/subscriptions/me")
def subscriptions(identity: str = Depends(require_local_identity)) -> list[dict[str, object]]:
    return repository.list_subscriptions(identity)


@app.put("/v1/follower/policy")
def save_policy(request: PolicyRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    return repository.save_policy(identity, request.model_dump())


@app.get("/v1/follower/policy")
def get_policy(identity: str = Depends(require_local_identity)) -> dict[str, object]:
    return repository.get_policy(identity) or {}


@app.post("/v1/agents/evaluate", response_model=AgentEvaluationResponse)
def agent_evaluation(request: AgentEvaluationRequest) -> AgentEvaluationResponse:
    return evaluate_strategy(request)
