from shared.orchestration_policy import (
    DECISION_INTERVAL_MIN,
    HEALTH_INTERVAL_MIN,
    MAX_ACTIVE_OPPORTUNITIES,
    SCAN_UNIVERSE_SIZE,
    PortfolioCandidate,
    health_bucket_ms,
    is_confirmed_protective_reversal,
    rank_cycle_symbols,
)


def candidate(symbol: str, grade: str, momentum: float):
    return PortfolioCandidate(
        symbol=symbol,
        wallet="long",
        side="long",
        source="break_retest",
        grade=grade,
        momentum_ratio=momentum,
    )


def test_shared_orchestration_contract():
    assert SCAN_UNIVERSE_SIZE == 20
    assert MAX_ACTIVE_OPPORTUNITIES == 5
    assert HEALTH_INTERVAL_MIN == 5
    assert DECISION_INTERVAL_MIN == 15


def test_whole_cycle_rank_is_quality_first_not_input_order():
    symbols, ranks, scores = rank_cycle_symbols(
        [candidate("WEAK-USDT", "A", 0.8), candidate("STRONG-USDT", "A", 1.4)],
        ["WEAK-USDT", "STRONG-USDT", "EMPTY-USDT"],
    )
    assert symbols == ["STRONG-USDT", "WEAK-USDT", "EMPTY-USDT"]
    assert ranks == {"STRONG-USDT": 1, "WEAK-USDT": 2}
    assert scores["STRONG-USDT"] > scores["WEAK-USDT"]


def test_hedge_requires_confirmed_1h_opposition_inside_live_4h_thesis():
    assert is_confirmed_protective_reversal(
        "long", "bearish_bos", "bullish_bos",
    )
    assert not is_confirmed_protective_reversal(
        "long", "bullish_bos", "bullish_bos",
    )
    assert not is_confirmed_protective_reversal(
        "long", "bearish_bos", "bearish_bos",
    )
    assert health_bucket_ms(14 * 60_000 + 59_999) == 10 * 60_000
