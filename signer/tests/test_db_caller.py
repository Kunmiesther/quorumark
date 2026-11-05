from app.db_caller import CallerScopedDbClient


class FakePostgrest:
    def __init__(self):
        self.calls = []

    def request(self, method, table, **kwargs):
        self.calls.append((method, table, kwargs))
        return [{"id": "credential-1", "user_id": "user-1"}]


def test_insert_credential_returns_only_non_secret_columns():
    client = FakePostgrest()
    db = CallerScopedDbClient("caller-jwt", client=client)

    inserted = db.insert_credential({
        "user_id": "user-1",
        "encrypted_credentials": "must-never-be-selected",
    })

    assert inserted["id"] == "credential-1"
    method, table, kwargs = client.calls[0]
    assert method == "POST"
    assert table == "apex_execution_credentials"
    assert kwargs["prefer"] == "return=representation"
    assert "encrypted_credentials" not in kwargs["params"]["select"]
    assert kwargs["body"]["encrypted_credentials"] == "must-never-be-selected"


def test_revoke_credential_returns_only_non_secret_columns():
    client = FakePostgrest()
    db = CallerScopedDbClient("caller-jwt", client=client)

    assert db.revoke_credential("credential-1") is True

    method, table, kwargs = client.calls[0]
    assert method == "PATCH"
    assert table == "apex_execution_credentials"
    assert kwargs["prefer"] == "return=representation"
    assert kwargs["params"]["select"] == "id,active,revoked_at,updated_at"
    assert "encrypted_credentials" not in kwargs["params"]["select"]
