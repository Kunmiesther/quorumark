import base64
import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient

from app.main import app


def signed_session(secret: str, *, exp: int, subject: str = "00000000-0000-0000-0000-000000000001") -> str:
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    header = encode(b'{"alg":"HS256","typ":"JWT"}')
    payload = encode(json.dumps({"aud": "quorumark", "sub": subject, "exp": exp}).encode())
    signature = encode(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def test_missing_invalid_tampered_and_expired_sessions_are_distinguishable(monkeypatch):
    secret = "test-session-secret"
    monkeypatch.setenv("QUORUMARK_SESSION_SECRET", secret)
    client = TestClient(app)
    assert client.get("/v1/strategies/mine").json()["detail"] == "Verified application session required"
    invalid = client.get("/v1/strategies/mine", headers={"Authorization": "Bearer not-a-token"})
    assert invalid.json()["detail"] == "Invalid application session"
    tampered = signed_session(secret, exp=int(time.time()) + 300)[:-1] + "x"
    assert client.get("/v1/strategies/mine", headers={"Authorization": f"Bearer {tampered}"}).json()["detail"] == "Invalid application session"
    expired = signed_session(secret, exp=int(time.time()) - 1)
    assert client.get("/v1/strategies/mine", headers={"Authorization": f"Bearer {expired}"}).json()["detail"] == "Expired application session"


def test_valid_session_is_accepted(monkeypatch):
    secret = "test-session-secret"
    monkeypatch.setenv("QUORUMARK_SESSION_SECRET", secret)
    token = signed_session(secret, exp=int(time.time()) + 300)
    response = TestClient(app).get("/v1/strategies/mine", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
