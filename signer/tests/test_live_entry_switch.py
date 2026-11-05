from unittest.mock import Mock
import pytest
from app.db import WorkerIngestBackedDbClient
from app.worker_ingest_client import WorkerIngestClient, WorkerIngestAuthError

def client(response):
    c = WorkerIngestClient(supabase_url="https://example.supabase.co", worker_id="test",
                          shared_secret="x" * 32, key_version="v1")
    c._post = Mock(return_value=response)
    return c

def test_live_entry_requires_server_confirmation():
    c = client({"halted": False, "live_entry_checked": True})
    assert c.check_execution_halted(user_id="u", connection_id="c", require_live=True) is False
    assert c._post.call_args.args[0]["require_live"] is True

@pytest.mark.parametrize("response", [{"halted": False}, {"halted": False, "live_entry_checked": False}])
def test_old_reader_cannot_authorize_entry(response):
    c = client(response)
    with pytest.raises(WorkerIngestAuthError, match="LIVE_ENTRY_CHECK_UNCONFIRMED"):
        c.check_execution_halted(user_id="u", connection_id="c", require_live=True)
    assert WorkerIngestBackedDbClient(client=c).is_execution_halted("u", "c", require_live=True) is True

def test_paused_connection_is_halted_and_flag_is_forwarded():
    c = client({"halted": True, "live_entry_checked": True})
    assert WorkerIngestBackedDbClient(client=c).is_execution_halted("u", "c", require_live=True) is True
    assert c._post.call_args.args[0]["require_live"] is True

def test_exit_and_read_checks_keep_existing_behavior():
    c = client({"halted": False})
    assert c.check_execution_halted(user_id="u", connection_id="c") is False
    assert "require_live" not in c._post.call_args.args[0]
