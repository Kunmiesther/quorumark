import os
import base64
import httpx
import json
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .ai import AIProviderError, AIUnavailableError, StrategyProposal, analyze_strategy, evaluate_agent, generate_strategy_proposal
from .historical_data import HistoricalDataError, fetch_historical
from .engine import run_reference_backtest
from .models import AIAnalysisRequest, AIAnalysisResponse, AIProposalRequest, AIProposalResponse, AgentEvaluationRequest, AgentEvaluationResponse, BacktestRequest, BacktestResponse, HistoricalDataQuery, PaperExecutionRequest, PaperExecutionResponse
from .paper import process_paper_signal
from .contracts import evidence_hash
from .repository import PaperRepository
from .supabase_repository import SupabaseRepository
from .security import require_verified_identity
from .publication_evidence import PUBLICATION_SCHEMA_VERSION, publication_commitment
from .marketplace import (
    PolicyRequest,
    StrategyDraftRequest,
    StrategyVersionRequest,
    SubscriptionRequest,
    PublicationPrepareRequest,
    PublicationConfirmRequest,
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
    allow_headers=["content-type", "authorization"],
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


@app.get("/v1/market-data/historical")
def historical_market_data(query: HistoricalDataQuery = Depends()) -> dict[str, object]:
    try:
        candles, provenance = fetch_historical(query.symbol, query.interval, query.limit)
    except HistoricalDataError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"candles": [candle.model_dump(mode="json") for candle in candles], "provenance": provenance}


@app.post("/v1/ai/strategy-proposals", response_model=AIProposalResponse)
def strategy_proposal(request: AIProposalRequest, identity: str = Depends(require_local_identity)) -> AIProposalResponse:
    current = None
    if request.current_proposal:
        try:
            current = StrategyProposal.model_validate(request.current_proposal)
        except Exception as error:
            raise HTTPException(status_code=422, detail="Current strategy proposal is invalid") from error
    try:
        proposal, provenance = generate_strategy_proposal(request.prompt, current)
    except (AIUnavailableError, AIProviderError, ValueError) as error:
        status = 503 if isinstance(error, AIUnavailableError) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error
    repository.save_ai_evaluation({"kind": "strategy_proposal", "provider": provenance["provider"], "model": provenance["model"], "actor_id": identity.removeprefix("near:"), "input": {"prompt": request.prompt, "refinement": bool(current)}, "output": proposal.model_dump(mode="json"), "status": "completed", "created_at": datetime.now(timezone.utc).isoformat()})
    return AIProposalResponse(proposal=proposal.model_dump(mode="json"), provenance=provenance)


@app.post("/v1/ai/strategy-analysis", response_model=AIAnalysisResponse)
def strategy_analysis(request: AIAnalysisRequest, identity: str = Depends(require_local_identity)) -> AIAnalysisResponse:
    try:
        analysis, provenance = analyze_strategy(request.strategy, request.metrics, request.question)
    except (AIUnavailableError, AIProviderError, ValueError) as error:
        status = 503 if isinstance(error, AIUnavailableError) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error
    repository.save_ai_evaluation({"kind": "strategy_analysis", "provider": provenance["provider"], "model": provenance["model"], "actor_id": identity.removeprefix("near:"), "input": {"strategy": request.strategy, "metrics": request.metrics, "question": request.question}, "output": analysis.model_dump(mode="json"), "status": "completed", "created_at": datetime.now(timezone.utc).isoformat()})
    return AIAnalysisResponse(analysis=analysis.model_dump(mode="json"), provenance=provenance)


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
    existing = next((item for item in repository.list_versions(strategy["id"]) if item.get("version") == request.version), None)
    requested_hash = request.evidence_hash or evidence_hash(request.definition)
    if existing:
        if requested_hash and existing.get("content_hash") != requested_hash:
            raise HTTPException(status_code=409, detail="That version is immutable. Create a new version for these changes.")
        return existing
    version = repository.save_strategy_version(strategy["id"], request.version, request.definition, request.backtest_id, request.backtest_metrics, requested_hash, datetime.now(timezone.utc).isoformat())
    updated = repository.update_strategy(strategy["id"], identity, current_version=request.version)
    return {**version, "strategy": updated or strategy}


@app.post("/v1/strategies/{strategy_id}/publish")
def publish_strategy(strategy_id: str, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy["creator_id"] != identity:
        raise HTTPException(status_code=404, detail="Strategy not found")
    if not repository.list_versions(strategy["id"]):
        raise HTTPException(status_code=409, detail="Create a version before publishing")
    updated = repository.update_strategy(strategy["id"], identity, status="published", published_at=datetime.now(timezone.utc).isoformat())
    return updated or strategy


@app.post("/v1/strategies/{strategy_id}/publication-evidence", status_code=201)
def prepare_publication_evidence(strategy_id: str, request: PublicationPrepareRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy.get("creator_id") != identity or strategy.get("status") != "published":
        raise HTTPException(status_code=404, detail="Published strategy not found")
    version = next((item for item in repository.list_versions(strategy_id) if item.get("version") == request.version), None)
    if not version or not version.get("id"):
        raise HTTPException(status_code=404, detail="Strategy version not found")
    account = identity.removeprefix("near:")
    if not account.endswith(".testnet") and account != "testnet":
        raise HTTPException(status_code=400, detail="A verified NEAR testnet creator session is required")
    record = {
        "id": str(version["id"]), "strategy_id": strategy_id, "version_id": str(version["id"]),
        "creator_near_account": account, "schema_version": PUBLICATION_SCHEMA_VERSION, "network": "near:testnet",
        "status": "pending", "commitment": publication_commitment({
            "strategy_id": strategy_id, "version_id": str(version["id"]), "creator_near_account": account,
            "strategy_commitment": version.get("content_hash") or "", "backtest_commitment": version.get("backtest_id") or "",
            "published_at": strategy.get("published_at") or "", "network": "near:testnet",
        }), "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    existing = repository.get_publication_evidence(str(version["id"]))
    if existing and existing.get("commitment") != record["commitment"]:
        raise HTTPException(status_code=409, detail="Publication evidence commitment is immutable")
    return repository.save_publication_evidence(existing or record)


@app.post("/v1/strategies/{strategy_id}/publication-evidence/{version_id}/confirm")
def confirm_publication_evidence(strategy_id: str, version_id: str, request: PublicationConfirmRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    evidence = repository.get_publication_evidence(version_id)
    contract_id = os.getenv("QUORUMARK_NEAR_EVIDENCE_CONTRACT_ID", "").strip()
    if not evidence or evidence.get("strategy_id") != strategy_id or evidence.get("creator_near_account") != identity.removeprefix("near:"):
        raise HTTPException(status_code=404, detail="Publication evidence request not found")
    if not contract_id or evidence.get("network") != "near:testnet":
        raise HTTPException(status_code=503, detail="NEAR testnet evidence contract is not configured")
    rpc = os.getenv("VITE_NEAR_RPC_URL", "https://rpc.testnet.near.org").strip()
    try:
        response = httpx.post(rpc, json={"jsonrpc": "2.0", "id": "quorumark-evidence", "method": "tx", "params": [request.transaction_hash, evidence["creator_near_account"]]}, timeout=20)
        payload = response.json()
        result = payload.get("result") or {}
        transaction = result.get("transaction") or {}
        if payload.get("error") or transaction.get("signer_id") != evidence["creator_near_account"] or transaction.get("receiver_id") != contract_id:
            raise ValueError("Transaction signer or receiver does not match publication evidence")
        status = result.get("status") or {}
        if "SuccessValue" not in status:
            raise ValueError("Transaction is not finalized successfully")
        action = next((item.get("FunctionCall") for item in transaction.get("actions", []) if item.get("FunctionCall")), None)
        args = json.loads(base64.b64decode(action.get("args", "")).decode("utf-8")) if action else {}
        if args.get("commitment") != evidence.get("commitment") or args.get("strategy_id") != strategy_id or args.get("version_id") != version_id:
            raise ValueError("Transaction commitment does not match the publication record")
    except (httpx.HTTPError, ValueError, KeyError, json.JSONDecodeError, base64.binascii.Error) as error:
        repository.update_publication_evidence(version_id, status="failed", transaction_hash=request.transaction_hash)
        raise HTTPException(status_code=422, detail=f"NEAR transaction could not be verified: {error}") from error
    confirmed = repository.update_publication_evidence(version_id, status="confirmed", transaction_hash=request.transaction_hash, transaction_receiver=contract_id, receipt=result, confirmed_at=datetime.now(timezone.utc).isoformat())
    repository.update_strategy(strategy_id, identity, evidence_class="testnet_executed")
    return confirmed or evidence


@app.get("/v1/strategies/{strategy_id}/versions")
def strategy_versions(strategy_id: str, identity: str = Depends(require_local_identity)) -> list[dict[str, object]]:
    strategy = repository.get_strategy(strategy_id)
    if not strategy or strategy["status"] != "published":
        raise HTTPException(status_code=404, detail="Published strategy not found")
    if strategy.get("creator_id") != identity:
        entitled = next(
            (
                item
                for item in repository.list_subscriptions(identity)
                if item.get("strategy_id") == strategy["id"]
                and item.get("status") == "active"
                and (not item.get("expires_at") or item["expires_at"] > datetime.now(timezone.utc).isoformat())
            ),
            None,
        )
        if not entitled:
            raise HTTPException(status_code=403, detail="Active subscription required")
    versions = repository.list_versions(strategy["id"])
    if strategy.get("creator_id") == identity:
        return versions
    return [{key: value for key, value in version.items() if key != "definition"} for version in versions]


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


@app.post("/v1/subscriptions/{strategy_id}/cancel")
def cancel_subscription(strategy_id: str, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    result = repository.cancel_subscription(strategy_id, identity)
    if not result:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return result


@app.put("/v1/follower/policy")
def save_policy(request: PolicyRequest, identity: str = Depends(require_local_identity)) -> dict[str, object]:
    return repository.save_policy(identity, request.model_dump())


@app.get("/v1/follower/policy")
def get_policy(identity: str = Depends(require_local_identity)) -> dict[str, object]:
    return repository.get_policy(identity) or {}


@app.post("/v1/agents/evaluate", response_model=AgentEvaluationResponse)
def agent_evaluation(request: AgentEvaluationRequest, identity: str = Depends(require_local_identity)) -> AgentEvaluationResponse:
    try:
        assessment, provenance = evaluate_agent(
            {"name": request.strategy_name, "thesis": request.thesis, "risk_class": request.risk_class, **request.strategy},
            request.metrics,
            request.market_observations,
        )
    except (AIUnavailableError, AIProviderError) as error:
        status = 503 if isinstance(error, AIUnavailableError) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error
    action = "no_action" if request.risk_class == "high" and assessment.action == "accept" else assessment.action
    repository.save_ai_evaluation({"kind": "agent_evaluation", "provider": provenance["provider"], "model": provenance["model"], "actor_id": identity.removeprefix("near:"), "input": request.model_dump(mode="json"), "output": {**assessment.model_dump(mode="json"), "deterministic_action": action}, "status": "completed", "created_at": datetime.now(timezone.utc).isoformat()})
    return AgentEvaluationResponse(provider=provenance["provider"], model=provenance["model"], strategy_name=request.strategy_name, risk_notes=assessment.risks, action=action, signal_reason=assessment.signal_reason, rationale=assessment.rationale)
