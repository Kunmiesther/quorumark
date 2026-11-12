import base64
import json
from fastapi.testclient import TestClient
import pytest
from pathlib import Path

from app.main import app
from app import main
from app.repository import PaperRepository
from app import ai


def test_health_is_paper_only():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["paper_only"] is True


def test_health_reports_sanitized_near_ai_configuration(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "near_ai")
    monkeypatch.setenv("NEAR_AI_API_KEY", "server-only-test-key")
    monkeypatch.delenv("NEAR_AI_MODEL", raising=False)
    body = TestClient(app).get("/health").json()
    assert body["ai"] == {
        "provider": "near_ai",
        "model": "google/gemini-2.5-flash-lite",
        "credential_configured": True,
        "credential_variable": "NEAR_AI_API_KEY",
        "model_variable": "NEAR_AI_MODEL",
        "ready": True,
    }
    assert "test-key" not in str(body)


def test_near_ai_does_not_use_gemini_credentials_or_model(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "near_ai")
    monkeypatch.delenv("NEAR_AI_API_KEY", raising=False)
    monkeypatch.setenv("AI_API_KEY", "unrelated-gemini-key")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash")
    with pytest.raises(ai.AIUnavailableError, match="provider credentials"):
        ai._config()


def test_evidence_deployment_status_requires_authorized_creator(monkeypatch):
    monkeypatch.setenv("QUORUMARK_EVIDENCE_DEPLOYMENT_ENABLED", "true")
    response = TestClient(app).post(
        "/v1/admin/evidence-deployment/status",
        headers={"x-quorumark-identity": "near:not-the-owner.testnet"},
        json={"public_key": "ed25519:unused"},
    )
    assert response.status_code == 403


def test_evidence_deployment_status_is_disabled_by_default(monkeypatch):
    monkeypatch.setenv("QUORUMARK_EVIDENCE_DEPLOYMENT_ENABLED", "false")
    response = TestClient(app).post(
        "/v1/admin/evidence-deployment/status",
        headers={"x-quorumark-identity": "near:estarkunmi.testnet"},
        json={"public_key": "ed25519:unused"},
    )
    assert response.status_code == 404


def test_browser_auth_preflight_allows_authorization_header():
    response = TestClient(app).options(
        "/v1/ai/strategy-proposals",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert "authorization" in response.headers.get("access-control-allow-headers", "").lower()


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


def test_ai_routes_fail_closed_when_provider_is_unavailable(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    response = TestClient(app).post(
        "/v1/ai/strategy-proposals",
        headers={"x-quorumark-identity": "near:creator.testnet"},
        json={"prompt": "Build a conservative BTC trend strategy."},
    )
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"].lower()


def test_gemini_provider_parses_structured_output_without_exposing_key(monkeypatch):
    proposal = {
        "name": "BTC Trend",
        "description": "A conservative trend-following strategy for BTC.",
        "thesis": "Follow confirmed medium-term momentum while limiting risk.",
        "instruments": ["BTCUSDT"],
        "timeframe": "1h",
        "indicators": [{"name": "EMA", "parameters": {"fast": 20, "slow": 50}, "purpose": "Trend direction"}],
        "entry_conditions": ["Fast EMA is above slow EMA"],
        "exit_conditions": ["Fast EMA crosses below slow EMA"],
        "stop_loss": "Use a fixed 2 percent stop.",
        "take_profit": "Use a fixed 4 percent target.",
        "position_sizing": "Risk at most 0.5 percent of paper equity.",
        "risk_constraints": ["No leverage", "Maximum one open position"],
        "unsupported_assumptions": [],
        "rationale": "The proposal translates the creator request into inspectable rules.",
    }

    class FakeResponse:
        status_code = 200
        is_success = True

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": __import__("json").dumps(proposal)}]}}]}

    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("AI_API_KEY", "server-only-test-key")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setattr(ai.httpx, "post", lambda *args, **kwargs: FakeResponse())
    result, provenance = ai.generate_strategy_proposal("Build a conservative BTC trend strategy.")
    assert result.name == "BTC Trend"
    assert provenance == {"provider": "gemini", "model": "gemini-3.5-flash-lite"}


def test_near_ai_provider_uses_openai_compatible_chat_response(monkeypatch):
    proposal = {
        "name": "NEAR Trend",
        "description": "A cautious trend strategy for a paper portfolio.",
        "thesis": "Follow confirmed momentum while limiting downside risk.",
        "instruments": ["BTCUSDT"],
        "timeframe": "1h",
        "indicators": [],
        "entry_conditions": ["Price is rising with confirmation"],
        "exit_conditions": ["The trend weakens"],
        "stop_loss": "Use a defined protective stop.",
        "take_profit": "Take gains at a predefined target.",
        "position_sizing": "Risk a small portion of paper equity.",
        "risk_constraints": ["No leverage"],
        "unsupported_assumptions": [],
        "rationale": "The proposal keeps the paper strategy simple and risk-aware.",
        "simple_explanation": "It waits for a clearer rise and avoids large practice losses.",
    }

    class FakeResponse:
        status_code = 200
        is_success = True

        def json(self):
            return {"choices": [{"message": {"content": __import__("json").dumps(proposal)}}]}

    monkeypatch.setenv("AI_PROVIDER", "near_ai")
    monkeypatch.setenv("NEAR_AI_API_KEY", "server-only-near-test-key")
    monkeypatch.setenv("AI_MODEL", "Qwen/Qwen3.8-27B")
    monkeypatch.setenv("NEAR_AI_MODEL", "Qwen/Qwen3.8-27B")
    monkeypatch.setenv("AI_API_URL", "https://cloud-api.near.ai/v1")
    calls = []
    monkeypatch.setattr(ai.httpx, "post", lambda *args, **kwargs: (calls.append((args, kwargs)) or FakeResponse()))
    result, provenance = ai.generate_strategy_proposal("Build a cautious BTC trend strategy.")
    assert result.name == "NEAR Trend"
    assert provenance == {"provider": "near_ai", "model": "Qwen/Qwen3.8-27B"}
    assert calls[0][0][0] == "https://cloud-api.near.ai/v1/chat/completions"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer server-only-near-test-key"
    assert calls[0][1]["json"]["max_tokens"] == 1200
    assert calls[0][1]["json"]["response_format"]["type"] == "json_schema"


def test_near_ai_model_override_and_blank_limits_use_safe_defaults(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "near_ai")
    monkeypatch.setenv("NEAR_AI_API_KEY", "server-only-near-test-key")
    monkeypatch.setenv("AI_MODEL", "z-ai/glm-5.3-flash")
    monkeypatch.setenv("NEAR_AI_MODEL", "google/gemini-2.5-flash-lite")
    monkeypatch.setenv("NEAR_AI_API_URL", "https://cloud-api.near.ai/v1")
    monkeypatch.setenv("AI_RATE_LIMIT_PER_MINUTE", "")
    monkeypatch.setenv("AI_REQUEST_TIMEOUT_SECONDS", "")
    monkeypatch.setenv("AI_MAX_OUTPUT_TOKENS", "")
    monkeypatch.setenv("AI_MAX_RETRIES", "")
    _, url, model, limit, timeout, max_output_tokens, max_retries = ai._config()
    assert url == "https://cloud-api.near.ai/v1"
    assert model == "google/gemini-2.5-flash-lite"
    assert (limit, timeout, max_output_tokens, max_retries) == (10, 30.0, 1200, 2)


@pytest.mark.parametrize(
    ("status_code", "payload", "message"),
    [
        (401, {"error": {"status": "UNAUTHENTICATED"}}, "not authorized"),
        (429, {"error": {"status": "RESOURCE_EXHAUSTED"}}, "busy"),
        (404, {"error": {"status": "NOT_FOUND", "message": "model not found"}}, "model is unavailable"),
        (503, {"error": {"status": "UNAVAILABLE"}}, "temporarily unavailable"),
    ],
)
def test_gemini_provider_maps_provider_failures_without_leaking_response_body(monkeypatch, status_code, payload, message):
    class FakeResponse:
        is_success = False

        def __init__(self):
            self.status_code = status_code

        def json(self):
            return payload

    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("AI_API_KEY", "server-only-test-key")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setattr(ai.httpx, "post", lambda *args, **kwargs: FakeResponse())
    with pytest.raises(ai.AIUnavailableError, match=message):
        ai._request("test", {"type": "object"}, "test")


def test_gemini_provider_maps_network_failure(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("AI_API_KEY", "server-only-test-key")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setattr(ai.httpx, "post", lambda *args, **kwargs: (_ for _ in ()).throw(ai.httpx.ConnectError("offline")))
    with pytest.raises(ai.AIUnavailableError, match="could not be reached"):
        ai._request("test", {"type": "object"}, "test")


def test_historical_data_rejects_invalid_symbols_without_provider_call():
    response = TestClient(app).get("/v1/market-data/historical?symbol=bad-symbol&interval=1h&limit=10")
    assert response.status_code == 502
    assert "symbol" in response.json()["detail"].lower()


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
    assert client.post(f"/v1/strategies/{strategy_id}/versions", headers=headers, json={
        "version": "v1.0",
        "definition": {"type": "reference_crossover"},
        "backtest_metrics": {"trade_count": 0},
    }).status_code == 201
    assert client.post(f"/v1/strategies/{strategy_id}/publish", headers=headers).status_code == 200
    assert client.get("/v1/strategies").json()[0]["id"] == strategy_id
    assert client.post("/v1/subscriptions", headers={"x-quorumark-identity": "near:follower.testnet"}, json={"strategy_id": strategy_id, "environment": "sandbox"}).status_code == 201
    assert client.post(f"/v1/strategies/{strategy_id}/publish", headers={"x-quorumark-identity": "near:other.testnet"}).status_code == 404


def test_publication_evidence_resolves_hosted_wallet_identity(tmp_path: Path, monkeypatch):
    repository = PaperRepository(str(tmp_path / "publication.db"))
    monkeypatch.setattr(main, "repository", repository)
    user_id = "9b7d8c2e-9d66-4ab0-9d0f-7d6f4d1b6d2a"
    monkeypatch.setattr(main, "resolve_near_account", lambda identity: "estarkunmi.testnet" if identity == user_id else None)
    client = TestClient(app)
    headers = {"x-quorumark-identity": user_id}
    created = client.post("/v1/strategies", headers=headers, json={
        "name": "Verified Bitcoin Practice",
        "thesis": "A hosted publication test strategy with safe paper-only rules.",
        "market": "Crypto spot",
        "supported_assets": ["BTCUSDT"],
        "risk_class": "low",
        "definition": {"type": "reference_crossover"},
    })
    assert created.status_code == 201
    strategy_id = created.json()["id"]
    version = client.post(f"/v1/strategies/{strategy_id}/versions", headers=headers, json={
        "version": "v1.0",
        "definition": {"type": "reference_crossover"},
        "backtest_metrics": {"trade_count": 1},
    })
    assert version.status_code == 201
    assert client.post(f"/v1/strategies/{strategy_id}/publish", headers=headers).status_code == 200
    prepared = client.post(f"/v1/strategies/{strategy_id}/publication-evidence", headers=headers, json={"version": "v1.0"})
    assert prepared.status_code == 201
    assert prepared.json()["creator_near_account"] == "estarkunmi.testnet"


def test_publication_confirmation_requires_dedicated_contract_owner(tmp_path: Path, monkeypatch):
    repository = PaperRepository(str(tmp_path / "publication-owner.db"))
    monkeypatch.setattr(main, "repository", repository)
    monkeypatch.setenv("QUORUMARK_NEAR_EVIDENCE_CONTRACT_ID", "quorumark-evidence-dedicated.testnet")
    monkeypatch.setenv("QUORUMARK_NEAR_EVIDENCE_OWNER_ID", "quorumark-evidence-dedicated.testnet")
    user_id = "creator-user"
    monkeypatch.setattr(main, "resolve_near_account", lambda identity: "estarkunmi.testnet" if identity == user_id else None)
    client = TestClient(app)
    headers = {"x-quorumark-identity": user_id}
    created = client.post("/v1/strategies", headers=headers, json={
        "name": "Owner signer test",
        "thesis": "A publication authorization regression test strategy.",
        "market": "Crypto spot",
        "supported_assets": ["BTCUSDT"],
        "risk_class": "low",
        "definition": {},
    })
    strategy_id = created.json()["id"]
    version = client.post(f"/v1/strategies/{strategy_id}/versions", headers=headers, json={"version": "v1.0", "definition": {}})
    version_id = version.json()["id"]
    client.post(f"/v1/strategies/{strategy_id}/publish", headers=headers)
    prepared = client.post(f"/v1/strategies/{strategy_id}/publication-evidence", headers=headers, json={"version": "v1.0"}).json()
    tx_hash = "A" * 44

    class RpcResponse:
        def json(self):
            args = base64.b64encode(json.dumps({"commitment": prepared["commitment"], "strategy_id": strategy_id, "version_id": version_id}).encode()).decode()
            return {"result": {"transaction": {"signer_id": "quorumark-evidence-dedicated.testnet", "receiver_id": "quorumark-evidence-dedicated.testnet", "actions": [{"FunctionCall": {"args": args}}]}, "status": {"SuccessValue": ""}}}

    def fake_post(url, **kwargs):
        assert kwargs["json"]["params"][1] == "quorumark-evidence-dedicated.testnet"
        return RpcResponse()

    monkeypatch.setattr(main.httpx, "post", fake_post)
    confirmed = client.post(f"/v1/strategies/{strategy_id}/publication-evidence/{version_id}/confirm", headers=headers, json={"transaction_hash": tx_hash})
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "confirmed"
