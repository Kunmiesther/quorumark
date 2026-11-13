from datetime import datetime, timedelta, timezone

from app.repository import PaperRepository
from app.strategy_runtime import run_autonomous_evaluations
from app.models import Candle


def candles_for_cross() -> list[Candle]:
    now = datetime.now(timezone.utc)
    closes = [100, 100, 100, 100, 100, 200]
    return [
        Candle(timestamp=now - timedelta(hours=len(closes) - index), open=close, high=close + 1, low=close - 1, close=close, volume=100, source="test-market", complete=True)
        for index, close in enumerate(closes)
    ]


def test_autonomous_evaluation_fans_out_independent_policies_and_is_idempotent(tmp_path):
    repository = PaperRepository(str(tmp_path / "autonomous.sqlite"))
    strategy = {
        "id": "strategy-autonomous",
        "slug": "autonomous",
        "creator_id": "creator.testnet",
        "name": "Autonomous Bitcoin Trend",
        "thesis": "A deterministic paper strategy.",
        "market": "Crypto spot",
        "supported_assets": ["BTC"],
        "risk_class": "medium",
        "cadence": "Every hour",
        "monthly_price": 0,
        "status": "published",
        "current_version": "v1.0",
        "evidence_class": "backtested",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "published_at": datetime.now(timezone.utc).isoformat(),
    }
    repository.save_strategy(strategy)
    version = repository.save_strategy_version(
        strategy["id"],
        "v1.0",
        {"executable_strategy": {"symbol": "BTCUSDT", "interval": "1h", "fast_window": 2, "slow_window": 3, "risk": {"allocation_pct": 10, "stop_loss_pct": 2, "take_profit_pct": 4}}},
        None,
        None,
        "hash",
        strategy["created_at"],
    )
    repository.save_subscription(strategy["id"], "follower-accept", "sandbox", version["id"])
    repository.save_subscription(strategy["id"], "follower-reject", "sandbox", version["id"])
    repository.save_policy("follower-accept", {"capital": 10_000, "max_trade": 2_000, "max_position": 2_500, "max_loss": 500, "max_slippage_bps": 30, "approved_assets": ["BTC"], "paused": False})
    repository.save_policy("follower-reject", {"capital": 10_000, "max_trade": 100, "max_position": 2_500, "max_loss": 500, "max_slippage_bps": 30, "approved_assets": ["BTC"], "paused": False})

    completed_candles = candles_for_cross()

    def market_fetcher(symbol: str, interval: str, limit: int):
        assert symbol == "BTCUSDT"
        assert interval == "1h"
        return completed_candles, {"source": "test-market", "provider": "test"}

    first = run_autonomous_evaluations(repository, market_fetcher=market_fetcher)
    second = run_autonomous_evaluations(repository, market_fetcher=market_fetcher)

    assert first["evaluated"] == 1
    assert first["signals"] == 1
    assert first["paper_decisions"] == 2
    assert second["evaluated"] == 0
    assert second["skipped"] == 1
    accepted = repository.list_executions("follower-accept")
    rejected = repository.list_executions("follower-reject")
    assert len(accepted) == 1
    assert accepted[0]["strategy_id"] == strategy["id"]
    assert accepted[0]["strategy_version_id"] == version["id"]
    assert len(rejected) == 1
    assert rejected[0]["decision"]["status"] == "rejected"
