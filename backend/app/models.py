from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Candle(BaseModel):
    timestamp: datetime
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)

    @field_validator("high")
    @classmethod
    def high_covers_range(cls, value: float, info):
        if "open" in info.data and value < info.data["open"]:
            raise ValueError("high must be at least open")
        return value

    @field_validator("low")
    @classmethod
    def low_covers_range(cls, value: float, info):
        if "open" in info.data and value > info.data["open"]:
            raise ValueError("low must be at most open")
        return value


class ReferenceStrategyParams(BaseModel):
    fast_window: int = Field(default=3, ge=2, le=50)
    slow_window: int = Field(default=8, ge=3, le=200)
    initial_cash: float = Field(default=10_000, gt=0, le=10_000_000)
    allocation_pct: float = Field(default=25, gt=0, le=100)
    fee_bps: float = Field(default=10, ge=0, le=500)

    @field_validator("slow_window")
    @classmethod
    def slow_after_fast(cls, value: int, info):
        if "fast_window" in info.data and value <= info.data["fast_window"]:
            raise ValueError("slow_window must be greater than fast_window")
        return value


class BacktestRequest(BaseModel):
    candles: list[Candle] = Field(min_length=10, max_length=10_000)
    strategy: ReferenceStrategyParams = Field(default_factory=ReferenceStrategyParams)

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


class Execution(BaseModel):
    timestamp: datetime
    side: Literal["buy", "sell"]
    price: float = Field(gt=0)
    quantity: float = Field(gt=0)
    fee: float = Field(ge=0)
    realized_pnl: float = 0


class Performance(BaseModel):
    initial_cash: float
    final_equity: float
    realized_pnl: float
    fees: float
    return_pct: float
    max_drawdown_pct: float
    win_rate_pct: float
    trade_count: int


class BacktestResponse(BaseModel):
    evidence_class: Literal["backtested"] = "backtested"
    paper_only: bool = True
    signals: list[Signal]
    executions: list[Execution]
    equity_curve: list[float]
    performance: Performance


class AgentEvaluationRequest(BaseModel):
    strategy_name: str = Field(min_length=1, max_length=120)
    thesis: str = Field(min_length=1, max_length=2_000)
    risk_class: Literal["low", "medium", "high"]


class AgentEvaluationResponse(BaseModel):
    provider: Literal["disabled", "configured"]
    strategy_name: str
    risk_notes: list[str]
    needs_human_review: bool = True
