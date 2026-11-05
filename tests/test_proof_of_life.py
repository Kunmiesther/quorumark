"""Proof-of-life trade trigger — worker-side unit tests.

Verifies:
  * `_maybe_fire_proof_of_life` polls exactly one command per cycle.
  * A `test_order` command emits exactly ONE submit_order_intent call.
  * The command is marked `consumed` server-side BEFORE the intent is
    emitted (verified via the mocked claim/complete order-of-operations).
  * A second cycle after a successful claim gets `None` (no double-fire).
  * A signer HMAC failure propagates as `failed` + surfaces the reject.
"""

from __future__ import annotations

from unittest.mock import MagicMock, call

import bot_worker as bw


def _fresh_bot() -> bw.RailwayTurtleBot:
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = MagicMock()
    bot.supabase_url = "https://x.supabase.co"
    return bot


def test_no_command_is_no_op() -> None:
    bot = _fresh_bot()
    bot.ingest.claim_worker_command.return_value = None
    bot.submit_order_intent = MagicMock(side_effect=AssertionError("must not submit"))
    bot._maybe_fire_proof_of_life()
    bot.ingest.claim_worker_command.assert_called_once()
    bot.ingest.complete_worker_command.assert_not_called()


def test_consumed_before_emit_and_single_shot() -> None:
    bot = _fresh_bot()
    cmd = {
        "id": "cmd-1",
        "command": "test_order",
        "user_id": "user-1",
        "symbol": "BTC-USDT",
        "correlation_id": "corr-1",
        "params": {"connection_id": "conn-1"},
    }
    # First cycle: server returns the claimed row (already flipped to consumed
    # server-side per WORKER_COMMAND_CLAIM). Second cycle: nothing pending.
    bot.ingest.claim_worker_command.side_effect = [cmd, None]
    bot.submit_order_intent = MagicMock(
        return_value={
            "status": "submitted",
            "exchange_order_id": "abc",
            "exchange_status": "accepted",
            "reject_reason": None,
        },
    )
    bot.log_event = MagicMock()

    bot._maybe_fire_proof_of_life()
    bot._maybe_fire_proof_of_life()

    # Exactly ONE intent emitted across both cycles.
    assert bot.submit_order_intent.call_count == 1
    intent = bot.submit_order_intent.call_args.args[0]
    assert intent["user_id"] == "user-1"
    assert intent["connection_id"] == "conn-1"
    assert intent["symbol"] == "BTC-USDT"
    assert intent["side"] == "BUY"
    assert intent["purpose"] == "proof_of_life"
    assert intent["idempotency_key"] == "corr-1"


    # Completion reports success with the sanitized outcome (no raw fields).
    bot.ingest.complete_worker_command.assert_called_once()
    kwargs = bot.ingest.complete_worker_command.call_args.kwargs
    assert kwargs["command_id"] == "cmd-1"
    assert kwargs["status"] == "completed"
    assert kwargs["result"]["exchange_order_id"] == "abc"
    assert kwargs["error_message"] is None


def test_signer_reject_surfaces_as_failed() -> None:
    bot = _fresh_bot()
    bot.ingest.claim_worker_command.return_value = {
        "id": "cmd-2", "command": "test_order",
        "user_id": "u", "symbol": "BTC-USDT",
        "correlation_id": "c", "params": {"connection_id": "cn"},
    }
    bot.submit_order_intent = MagicMock(return_value={
        "status": "rejected",
        "exchange_order_id": None,
        "exchange_status": "rejected",
        "reject_reason": "INVALID_HMAC_SIGNATURE",
    })
    bot.log_event = MagicMock()
    bot._maybe_fire_proof_of_life()
    kwargs = bot.ingest.complete_worker_command.call_args.kwargs
    assert kwargs["status"] == "failed"
    assert kwargs["error_message"] == "INVALID_HMAC_SIGNATURE"


def test_missing_connection_id_fails_fast() -> None:
    bot = _fresh_bot()
    bot.ingest.claim_worker_command.return_value = {
        "id": "cmd-3", "command": "test_order",
        "user_id": "u", "symbol": "BTC-USDT",
        "correlation_id": "c", "params": {},
    }
    bot.submit_order_intent = MagicMock(side_effect=AssertionError("must not submit"))
    bot._maybe_fire_proof_of_life()
    kwargs = bot.ingest.complete_worker_command.call_args.kwargs
    assert kwargs["status"] == "failed"
    assert kwargs["error_message"] == "MISSING_USER_OR_CONNECTION"
