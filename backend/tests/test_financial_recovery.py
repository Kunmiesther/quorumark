from datetime import datetime, timedelta, timezone

import pytest

from app.engine import run_reference_backtest
from app.market_data import MarketDataError, validate_candles
from app.models import BacktestRequest, Candle, PaperExecutionRequest, ReferenceStrategyParams, RiskPolicy, SignalInput
from app.paper import process_paper_signal
from app.repository import PaperRepository
from app.risk import evaluate_signal_risk


def make_candle(index: int, close: float, *, low: float | None = None, high: float | None = None) -> Candle:
    timestamp = datetime.now(timezone.utc) - timedelta(hours=20 - index)
    return Candle(timestamp=timestamp, open=close, high=high or close + 0.2, low=low or close - 0.2, close=close, volume=100, source="fixture")


def test_stop_loss_and_slippage_are_candle_driven():
    candles = [make_candle(i, close) for i, close in enumerate([10, 10, 10, 12, 14, 14, 14, 14, 14])]
    candles.append(make_candle(9, 14, low=13.0, high=14.2))
    result = run_reference_backtest(BacktestRequest(candles=candles, strategy=ReferenceStrategyParams(fast_window=2, slow_window=3, allocation_pct=50, fee_bps=10, slippage_bps=10, stop_loss_pct=5, take_profit_pct=10)))
    assert any(execution.reason == "stop_loss" for execution in result.executions)
    assert result.performance.trade_count == 1
    assert result.executions[0].price > candles[4].open


def test_market_data_rejects_duplicates_and_incomplete_rows():
    first = make_candle(0, 10)
    duplicate = first.model_copy()
    with pytest.raises(MarketDataError, match="duplicate"):
        validate_candles([first, duplicate])
    with pytest.raises(MarketDataError, match="incomplete"):
        validate_candles([first, first.model_copy(update={"timestamp": first.timestamp + timedelta(hours=1), "complete": False})])


def test_risk_rejects_max_loss_before_execution():
    candles = [make_candle(i, 100) for i in range(3)]
    signal = SignalInput(id="sig-risk", strategy_id="s", strategy_version="v1", asset="BTC", side="long", entry=100, stop=90, target=120, size_pct=50, created_at=candles[0].timestamp)
    policy = RiskPolicy(capital=10_000, max_trade=10_000, max_position=10_000, max_loss=100, approved_assets=["BTC"])
    decision = evaluate_signal_risk(signal, policy, candles, now=candles[-1].timestamp)
    assert decision.status == "rejected"
    assert decision.reason_code == "MAX_LOSS_EXCEEDED"


def test_paper_execution_is_idempotent(tmp_path):
    candles = [make_candle(i, 100 + i) for i in range(4)]
    request = PaperExecutionRequest(
        follower_id="near:testnet",
        signal=SignalInput(id="sig-idempotent", strategy_id="s", strategy_version="v1", asset="BTC", side="long", entry=100, stop=90, target=120, size_pct=5, created_at=candles[0].timestamp),
        policy=RiskPolicy(capital=10_000, max_trade=10_000, max_position=10_000, max_loss=1_000, approved_assets=["BTC"]),
        candles=candles,
        idempotency_key="exec-test-key",
    )
    repository = PaperRepository(str(tmp_path / "ledger.sqlite"))
    first = process_paper_signal(request, repository)
    second = process_paper_signal(request, repository)
    assert first.evidence_hash == second.evidence_hash
    assert first.execution_id == second.execution_id
    assert len(repository.list_executions("near:testnet")) == 1
