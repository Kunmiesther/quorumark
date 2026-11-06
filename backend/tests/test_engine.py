from datetime import datetime, timedelta, timezone

from app.engine import run_reference_backtest
from app.models import BacktestRequest, Candle, ReferenceStrategyParams


def candles_from_closes(closes: list[float]) -> list[Candle]:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(timestamp=start + timedelta(hours=i), open=value, high=value + 1, low=value - 1, close=value) for i, value in enumerate(closes)]


def test_backtest_executes_next_open_and_returns_paper_evidence():
    request = BacktestRequest(
        candles=candles_from_closes([10, 10, 10, 12, 14, 16, 18, 20, 22, 24, 22, 20, 18, 18]),
        strategy=ReferenceStrategyParams(fast_window=2, slow_window=3, fee_bps=0),
    )
    result = run_reference_backtest(request)
    assert result.paper_only is True
    assert result.evidence_class == "backtested"
    assert result.executions[0].timestamp == request.candles[4].timestamp
    assert result.performance.trade_count == 1
    assert result.performance.realized_pnl > 0


def test_no_lookahead_when_price_changes_after_signal():
    request = BacktestRequest(
        candles=candles_from_closes([10, 10, 10, 10, 100, 100, 100, 100, 100, 100]),
        strategy=ReferenceStrategyParams(fast_window=2, slow_window=3, fee_bps=0),
    )
    result = run_reference_backtest(request)
    assert result.executions[0].price == 100
