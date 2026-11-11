from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Candle(BaseModel):
    timestamp: datetime
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float = Field(default=0, ge=0)
    source: str = Field(default="fixture", min_length=1, max_length=80)
    complete: bool = True

    @field_validator("high")
    @classmethod
    def high_covers_range(cls, value: float, info):
        if "open" in info.data and value < info.data["open"]:
            raise ValueError("high must be at least open")
        return value

    @field_validator("low")
    @classmethod
    def low_covers_range(cls, value: float, info):
        if "open" in info.data and value > min(info.data["open"], info.data.get("close", value)):
            raise ValueError("low must be at most open and close")
        return value

    @model_validator(mode="after")
    def high_covers_close(self):
        if self.high < max(self.open, self.close):
            raise ValueError("high must cover open and close")
        if self.low > min(self.open, self.close):
            raise ValueError("low must cover open and close")
        return self


class ReferenceStrategyParams(BaseModel):
    fast_window: int = Field(default=3, ge=2, le=50)
    slow_window: int = Field(default=8, ge=3, le=200)
    initial_cash: float = Field(default=10_000, gt=0, le=10_000_000)
    allocation_pct: float = Field(default=25, gt=0, le=100)
    fee_bps: float = Field(default=10, ge=0, le=500)
    slippage_bps: float = Field(default=0, ge=0, le=500)
    stop_loss_pct: float = Field(default=0, ge=0, le=100)
    take_profit_pct: float = Field(default=0, ge=0, le=500)
    partial_take_profit_pct: float = Field(default=50, ge=0, le=100)

    @field_validator("slow_window")
    @classmethod
    def slow_after_fast(cls, value: int, info):
        if "fast_window" in info.data and value <= info.data["fast_window"]:
            raise ValueError("slow_window must be greater than fast_window")
        return value


class BacktestRequest(BaseModel):
    candles: list[Candle] = Field(min_length=10, max_length=10_000)
    strategy: ReferenceStrategyParams = Field(default_factory=ReferenceStrategyParams)
    strategy_version: str = Field(default="reference.v1", min_length=1, max_length=100)
    source: str = Field(default="fixture", min_length=1, max_length=80)

    @field_validator("candles")
    @classmethod
    def chronological(cls, value: list[Candle]):
        if any(left.timestamp >= right.timestamp for left, right in zip(value, value[1:])):
            raise ValueError("candles must be strictly chronological")
        return value


class Signal(BaseModel):
    timestamp: datetime
    side: Literal["long", "flat"]
    price: float = Field(gt=0)
    reason: str
    strategy_id: str = "reference"
    strategy_version: str = "reference.v1"
    signal_id: str | None = None


class Execution(BaseModel):
    timestamp: datetime
    side: Literal["buy", "sell"]
    price: float = Field(gt=0)
    quantity: float = Field(gt=0)
    fee: float = Field(ge=0)
    realized_pnl: float = 0
    order_type: Literal["entry", "exit", "partial_exit", "rejected"] = "entry"
    position_id: str | None = None
    slippage: float = 0
    reason: str = ""
    notional: float = 0
    environment: Literal["paper"] = "paper"
    follower_id: str | None = None


class Performance(BaseModel):
    initial_cash: float
    final_equity: float
    realized_pnl: float
    fees: float
    return_pct: float
    max_drawdown_pct: float
    win_rate_pct: float
    trade_count: int
    unrealized_pnl: float = 0
    realized_gross_pnl: float = 0


class BacktestResponse(BaseModel):
    evidence_class: Literal["backtested"] = "backtested"
    paper_only: bool = True
    signals: list[Signal]
    executions: list[Execution]
    equity_curve: list[float]
    performance: Performance
    data_source: str = "fixture"
    evidence_hash: str = ""
    backtest_id: str | None = None


class RiskPolicy(BaseModel):
    capital: float = Field(gt=0, le=10_000_000)
    max_trade: float = Field(gt=0)
    max_position: float = Field(gt=0)
    max_loss: float = Field(gt=0)
    max_data_age_seconds: int = Field(default=86_400, ge=60, le=31_536_000)
    fee_bps: float = Field(default=10, ge=0, le=500)
    slippage_bps: float = Field(default=5, ge=0, le=500)
    quantity_step: float = Field(default=0.000001, gt=0)
    min_order_size: float = Field(default=0.000001, gt=0)
    approved_assets: list[str] = Field(min_length=1)
    paused: bool = False


class SignalInput(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    strategy_id: str = Field(min_length=1, max_length=120)
    strategy_version: str = Field(min_length=1, max_length=100)
    asset: str = Field(min_length=1, max_length=30)
    side: Literal["long", "short"]
    entry: float = Field(gt=0)
    stop: float = Field(gt=0)
    target: float = Field(gt=0)
    size_pct: float = Field(gt=0, le=100)
    created_at: datetime


class PaperExecutionRequest(BaseModel):
    follower_id: str = Field(min_length=1, max_length=160)
    signal: SignalInput
    policy: RiskPolicy
    candles: list[Candle] = Field(min_length=2, max_length=10_000)
    idempotency_key: str | None = Field(default=None, max_length=200)
    source: str = Field(default="fixture", min_length=1, max_length=80)


class RiskDecisionResponse(BaseModel):
    status: Literal["accepted", "rejected"]
    reason_code: str
    reason: str
    notional: float
    quantity: float
    reserved_capital: float
    estimated_loss: float


class PaperExecutionResponse(BaseModel):
    evidence_class: Literal["paper_traded"] = "paper_traded"
    paper_only: bool = True
    decision: RiskDecisionResponse
    execution: Execution | None = None
    idempotency_key: str
    evidence_hash: str
    execution_id: str | None = None


class AgentEvaluationRequest(BaseModel):
    strategy_name: str = Field(min_length=1, max_length=120)
    thesis: str = Field(min_length=1, max_length=2_000)
    risk_class: Literal["low", "medium", "high"]
    strategy: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    market_observations: dict[str, Any] = Field(default_factory=dict)


class AgentEvaluationResponse(BaseModel):
    provider: Literal["openai", "openai_compatible", "near_ai", "gemini"]
    model: str
    strategy_name: str
    risk_notes: list[str]
    action: Literal["accept", "reject", "no_action"]
    signal_reason: str
    rationale: str
    needs_human_review: bool = True


class AIProposalRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4_000)
    current_proposal: dict[str, Any] | None = None


class AIProposalResponse(BaseModel):
    proposal: dict[str, Any]
    provenance: dict[str, str]


class AIAnalysisRequest(BaseModel):
    strategy: dict[str, Any]
    metrics: dict[str, Any]
    question: str = Field(default="Explain the main risks and observations.", max_length=2_000)


class AIAnalysisResponse(BaseModel):
    analysis: dict[str, Any]
    provenance: dict[str, str]


class HistoricalDataQuery(BaseModel):
    symbol: str = Field(default="BTCUSDT", min_length=5, max_length=20)
    interval: str = Field(default="1h", min_length=2, max_length=4)
    limit: int = Field(default=200, ge=10, le=1_000)
