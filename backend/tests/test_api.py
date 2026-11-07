from fastapi.testclient import TestClient
from pathlib import Path

from app.main import app
from app import main
from app.repository import PaperRepository


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


def test_protected_marketplace_rejects_missing_verified_session():
    response = TestClient(app).post("/v1/strategies", json={
        "name": "Unauthenticated",
        "thesis": "This request must never be accepted without a verified session.",
        "market": "Crypto spot",
        "supported_assets": ["BTC"],
        "risk_class": "low",
    })
    assert response.status_code == 401


def test_local_marketplace_creator_lifecycle_is_owner_scoped(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(main, "repository", PaperRepository(str(tmp_path / "marketplace.db")))
    client = TestClient(app)
    headers = {"x-quorumark-identity": "near:creator.testnet"}
    created = client.post("/v1/strategies", headers=headers, json={
        "name": "Atlas Range",
        "thesis": "A deterministic range strategy for a paper marketplace test.",
        "market": "Crypto spot",
        "supported_assets": ["BTC"],
        "risk_class": "medium",
        "definition": {"type": "reference_crossover"},
    })
    assert created.status_code == 201
    strategy_id = created.json()["id"]
    assert client.post(f"/v1/strategies/{strategy_id}/publish", headers=headers).status_code == 200
    assert client.get("/v1/strategies").json()[0]["id"] == strategy_id
    assert client.post("/v1/subscriptions", headers={"x-quorumark-identity": "near:follower.testnet"}, json={"strategy_id": strategy_id, "environment": "sandbox"}).status_code == 201
    assert client.post(f"/v1/strategies/{strategy_id}/publish", headers={"x-quorumark-identity": "near:other.testnet"}).status_code == 404
