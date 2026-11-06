from fastapi.testclient import TestClient

from app.main import app


def test_health_is_paper_only():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["paper_only"] is True


def test_backtest_api_validates_and_returns_metrics():
    candles = [{"timestamp": f"2026-01-01T{i:02d}:00:00Z", "open": 10 + i, "high": 11 + i, "low": 9 + i, "close": 10 + i} for i in range(12)]
    response = TestClient(app).post("/v1/backtests/reference", json={"candles": candles})
    assert response.status_code == 200
    body = response.json()
    assert body["evidence_class"] == "backtested"
    assert "equity_curve" in body and "performance" in body
