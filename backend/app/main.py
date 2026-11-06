from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agents import evaluate_strategy
from .engine import run_reference_backtest
from .models import AgentEvaluationRequest, AgentEvaluationResponse, BacktestRequest, BacktestResponse

app = FastAPI(title="Quorumark Strategy Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"service": "quorumark-python-engine", "status": "ok", "paper_only": True}


@app.post("/v1/backtests/reference", response_model=BacktestResponse)
def reference_backtest(request: BacktestRequest) -> BacktestResponse:
    return run_reference_backtest(request)


@app.post("/v1/agents/evaluate", response_model=AgentEvaluationResponse)
def agent_evaluation(request: AgentEvaluationRequest) -> AgentEvaluationResponse:
    return evaluate_strategy(request)
