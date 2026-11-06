from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agents import evaluate_strategy
from .engine import run_reference_backtest
from .models import AgentEvaluationRequest, AgentEvaluationResponse, BacktestRequest, BacktestResponse, PaperExecutionRequest, PaperExecutionResponse
from .paper import process_paper_signal
from .repository import PaperRepository

app = FastAPI(title="Quorumark Strategy Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)
repository = PaperRepository()


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"service": "quorumark-python-engine", "status": "ok", "paper_only": True}


@app.post("/v1/backtests/reference", response_model=BacktestResponse)
def reference_backtest(request: BacktestRequest) -> BacktestResponse:
    result = run_reference_backtest(request)
    repository.save_backtest(result.backtest_id or "bt_unknown", request.strategy_version, result.data_source, result.model_dump(mode="json"), result.signals[0].timestamp.isoformat() if result.signals else "now")
    return result


@app.post("/v1/paper/executions", response_model=PaperExecutionResponse)
def paper_execution(request: PaperExecutionRequest) -> PaperExecutionResponse:
    return process_paper_signal(request, repository)


@app.get("/v1/paper/executions/{follower_id}")
def paper_executions(follower_id: str) -> list[dict[str, object]]:
    return repository.list_executions(follower_id)


@app.post("/v1/agents/evaluate", response_model=AgentEvaluationResponse)
def agent_evaluation(request: AgentEvaluationRequest) -> AgentEvaluationResponse:
    return evaluate_strategy(request)
