"""THE APEX BOUNDARY IS UNCHANGED. Proof, not assertion.

This file exists to make the refactor falsifiable. If any of it fails, the
signer is receiving something different from what it received before, and the
refactor is not safe to deploy.

Three layers are pinned:

  1. The worker's order-intent body — exact keys, exact types, exact values
     for the ratified policy fields (TP ladder, order type, purpose, venue,
     margin implication). The intent is what the worker hands to the broker.
  2. The broker's forwardBody — the field list the edge function builds and
     posts to `/v1/orders`. The worker cannot change this, but a stray extra
     key in the intent could reach it, so the mapping is pinned too.
  3. The signer's `OrdersMinimalBody` — the fields and types the signer
     actually validates.

The intent snapshot below is transcribed from the PRE-REFACTOR bridges
(bot_worker §5a/§5b/§5c as of commit 7f4200d). It is deliberately a literal:
deriving it from the current code would prove nothing.

The separately named campaign fields below are the intentional additive
extension for five-rung execution. Legacy field values remain pinned.
"""
import ast
import os
import re
import sys
from decimal import Decimal
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_worker as bw


# --- 1. The order-intent body -------------------------------------------

# Transcribed verbatim from the pre-refactor Accumulator bridge.
PRE_REFACTOR_ACCUM_INTENT_KEYS = {
    "user_id", "connection_id", "venue", "symbol", "side", "order_type",
    "size", "leverage", "purpose", "idempotency_key", "stop_pct", "tp_tiers",
}
CAMPAIGN_INTENT_KEYS = {
    "campaign_rung_count", "campaign_margin_usd", "campaign_margin_per_rung_usd",
}
# Hunter/Sweep carried NO leverage key. That is not an oversight to tidy up:
# the signer applies its own ratified clamp when leverage is absent.
# Hunter/Sweep canary intents NOW CARRY LEVERAGE, so the key set matches the
# accumulator's exactly.
#
# This was `- {"leverage"}`: those legs omitted the field and the signer chose
# its own. `safety_checks._order_params_check` now refuses an absent leverage
# outright — "a missing value used to mean 'Hunter/Sweep, let the signer
# decide', which is how `leverage: null` intents reached the venue." Deciding
# it in the worker and sending it explicitly is what closed that.
#
# Deliberate boundary change, not drift: the signer still clamps to 1..100, so
# an explicit value can only ever be honoured or reduced.
PRE_REFACTOR_CANARY_INTENT_KEYS = PRE_REFACTOR_ACCUM_INTENT_KEYS

PRE_REFACTOR_TP_TIERS = [
    {"rr_multiple": 1.75, "size_frac": 0.5},
    {"rr_multiple": 2.0, "size_frac": 0.3},
    {"rr_multiple": 2.5, "size_frac": 0.2},
]


def _bot() -> bw.RailwayTurtleBot:
    bot = bw.RailwayTurtleBot.__new__(bw.RailwayTurtleBot)
    bot.ingest = None
    bot._decision_inflight = set()
    bot._venue_contract_cache = {}
    return bot


class _Plan:
    size = Decimal("0.05")
    leverage = 100
    notional_usd = Decimal("1500")
    margin_usd = Decimal("15")
    rung_count = 1
    margin_per_rung_usd = Decimal("15")


def _capture_intent(strategy: str, chosen) -> dict:
    """Run the real execution path and capture exactly what would be sent."""
    bot = _bot()
    captured = {}

    def fake_submit(intent):
        captured.update(intent)
        return {"status": "submitted", "exchange_order_id": "x", "exchange_status": "accepted"}

    decision = {"decision_id": "dec_v1_" + "a" * 32, "symbol": "ETH-USDT"}
    with patch.object(bot, "submit_order_intent", side_effect=fake_submit), \
         patch.object(bot, "_accum_available_equity_usd", return_value=5000.0), \
         patch.object(bot, "_venue_contract_config", return_value={"x": 1}), \
         patch.object(bot, "log_event"), \
         patch.object(bw, "LIVE_TRADING_ENABLED", True), \
         patch.object(bw.accumulator_live_size, "plan_entry_size", return_value=_Plan()):
        bot._execute_decision(
            cfg={"mode": "live", "status": "verified", "exchange_type": "apex_omni",
                 "permissions_verified": True, "permission_trade": True},
            user_id="11111111-2222-3333-4444-555555555555",
            connection_id="22222222-3333-4444-5555-666666666666",
            symbol="ETH-USDT", normalized="ETHUSDT", decision=decision,
            strategy=strategy, chosen=chosen, gate={}, feed=MagicMock(),
            feed_client=None, now=1753920012000,
        )
    return captured


def _chosen(direction: str, idem: str):
    import decision_reducer as dr
    return dr.DirectionInput(
        direction=direction, confirmed=True, entry_price=3000.0,
        entry_zone={"low": 2990.0, "high": 3010.0}, invalidation=2950.0,
        take_profits=[3100.0], stop_pct=0.0166,
        confirmation_ref="break:1|retest:2", idempotency_key=idem,
    )


def test_accumulator_intent_body_is_unchanged():
    intent = _capture_intent("accumulator", _chosen("long", "accum:c:ETHUSDT:long:1:2"))
    assert set(intent) == PRE_REFACTOR_ACCUM_INTENT_KEYS | CAMPAIGN_INTENT_KEYS
    assert intent["venue"] == "apex_omni"
    assert intent["order_type"] == "MARKET"
    assert intent["purpose"] == "CREATE_ORDER"
    assert intent["side"] == "BUY"
    assert intent["idempotency_key"] == "accum:c:ETHUSDT:long:1:2"
    assert intent["tp_tiers"] == PRE_REFACTOR_TP_TIERS
    assert intent["stop_pct"] == round(0.0166, 6)
    assert intent["size"] == 0.05
    assert intent["leverage"] == 100
    assert intent["campaign_rung_count"] == 1
    assert intent["campaign_margin_usd"] == 15.0
    assert intent["campaign_margin_per_rung_usd"] == 15.0
    # No new field may appear — every extra key the intent grows is a field
    # the broker's fingerprint and the signer's validator never agreed to.
    assert "decision_id" not in intent
    assert "candidate_id" not in intent
    assert "reduce_only" not in intent
    assert "price_or_trigger" not in intent


def test_short_maps_to_SELL_exactly_as_before():
    intent = _capture_intent("accumulator", _chosen("short", "accum:c:ETHUSDT:short:1:2"))
    assert intent["side"] == "SELL"


def test_hunter_intent_matches_the_accumulator_shape_and_sweep_stays_blocked():
    """Hunter shares the sizing authority; Sweep stays blocked until the live
    signer supports the complete five-rung Zen lifecycle.

    This asserted a separate "canary shape": Hunter and Sweep fell through to
    the fixed CANARY_ORDER_SIZE with no leverage. Per bot_worker, that was a
    bug wearing a venue rejection's clothes — on ETH and every non-BTC
    contract it produced a one-step size and a null leverage, which the signer
    refused as SIZE_TOO_SMALL. All legs now derive size and leverage from the
    ratified plan and refuse with the sizer's own code when they cannot.

    What this test still guards is what it always guarded: no leg invents a
    key, drops one, or rewrites the idempotency formula or the TP ladder."""
    for strategy, idem in (("hunter", "hunter:c:ETHUSDT:long:9"),):
        intent = _capture_intent(strategy, _chosen("long", idem))
        assert set(intent) == PRE_REFACTOR_ACCUM_INTENT_KEYS | CAMPAIGN_INTENT_KEYS, strategy
        # Size is DERIVED, never a constant. The specific number belongs to
        # the sizing tests; here it only has to be a real positive size rather
        # than the old hardcoded floor.
        assert isinstance(intent["size"], float) and intent["size"] > 0, strategy
        assert intent["size"] != 0.001, strategy
        # Leverage is now present on every leg and inside the ratified range.
        assert isinstance(intent["leverage"], int), strategy
        assert 1 <= intent["leverage"] <= 100, strategy
        # Unchanged, and the reason this suite exists.
        assert intent["idempotency_key"] == idem, strategy
        assert intent["tp_tiers"] == PRE_REFACTOR_TP_TIERS, strategy

    # A single MARKET intent with the older TP tiers is not equivalent to the
    # owner-approved five-rung Sweep campaign. Refuse rather than trade a
    # different strategy with real funds.
    assert _capture_intent("sweep", _chosen("long", "sweep:c:ETHUSDT:long:k")) == {}


def test_idempotency_key_formulas_are_unchanged():
    """The broker's duplicate protection is keyed on these strings. Changing
    a formula would silently re-arm every historical confirmation."""
    src = open("bot_worker.py").read()
    assert 'f"accum:{connection_id}:{normalized}:{direction}:{break_ts}:{retest_ts}"' in src
    assert 'f"hunter:{connection_id}:{normalized}:{direction}:{plan.fvg_confirm_ts}"' in src
    assert 'f"sweep:{connection_id}:{normalized}:{direction}:{plan.dedup_key}"' in src


def test_tp_ladder_policy_literal_is_unchanged():
    assert [dict(t) for t in bw.STRATEGY_TP_TIERS] == PRE_REFACTOR_TP_TIERS


def test_submit_order_intent_targets_the_worker_safe_railway_route():
    """Replay-protected HMAC, no user Authorization header, Railway route."""
    src = open("bot_worker.py").read()
    body = src[src.index("def submit_order_intent"):src.index("def _signal_feed")]
    assert 'json.dumps(body, sort_keys=True, separators=(",", ":"))' in body
    assert 'hmac.new(secret.encode("utf-8"), signed, hashlib.sha256)' in body
    assert 'path = "/v1/automation/orders"' in body
    assert '"x-worker-signature": sig' in body
    assert '"x-worker-timestamp": timestamp' in body
    assert '"x-worker-nonce": nonce' in body
    # No Authorization header is ever set (the comment saying so may stay).
    assert '"authorization"' not in body.lower().replace("# no authorization header", "")
    assert 'body["is_live"] = LIVE_TRADING_ENABLED' in body


# --- 2. The broker's forwardBody ----------------------------------------

BROKER = "supabase/functions/execution-broker/index.ts"

EXPECTED_FORWARD_FIELDS = [
    "user_id", "exchange_connection_id", "client_order_id", "symbol", "side",
    "order_type", "size", "price", "leverage", "reduce_only", "environment",
    "purpose", "venue",
]


def test_broker_forward_body_field_list_is_unchanged():
    src = open(BROKER).read()
    block = src[src.index("const forwardBody: Record<string, unknown> = {"):]
    block = block[:block.index("};")]
    fields = re.findall(r"^\s{6}(\w+)[,:]", block, re.M)
    assert fields == EXPECTED_FORWARD_FIELDS


def test_broker_forwards_tp_and_stop_only_when_present():
    src = open(BROKER).read()
    assert "if (tp_tiers) forwardBody.tp_tiers = tp_tiers;" in src
    assert "if (stop_pct !== null) forwardBody.stop_pct = stop_pct;" in src


def test_broker_still_targets_the_same_signer_path():
    shared = open("supabase/functions/_shared/signer-client.ts").read()
    assert 'export const SIGNER_CREATE_ORDER_PATH = "/v1/orders";' in shared
    # HMAC message shape the signer's security.py enforces.
    assert "`${ts}\\n${nonce}\\n${path}\\n${bodyStr}`" in shared
    assert '"x-signer-timestamp": ts' in shared
    assert '"x-signer-nonce": nonce' in shared
    assert '"x-signer-signature": sig' in shared


def test_the_refactor_touched_no_apex_credential_or_wallet_code():
    """Files that own credentials, signing, sizing and protections must be
    byte-identical to their pre-refactor state; this asserts the refactor
    added no import or call into them from the worker."""
    src = open("bot_worker.py").read()
    for forbidden in (
        "apex_signing", "exchange_creds", "decrypt", "l2_key", "stark",
        "wallet_address", "sub_account", "APEX_API_KEY", "omni_seed",
    ):
        assert forbidden not in src, forbidden


# --- 3. The signer's own validator --------------------------------------

SIGNER_MAIN = "signer/app/main.py"

EXPECTED_SIGNER_FIELDS = {
    "user_id": "str",
    "exchange_connection_id": "str",
    "client_order_id": "str",
    "symbol": "str",
    "side": "str",
    "order_type": "str",
    "size": "float | None",
    "price": "float | None",
    "leverage": "int | None",
    "reduce_only": "bool",
    "environment": "str",
    "purpose": "str | None",
    "venue": "str | None",
    "tp_tiers": "list[TpTierBody] | None",
    "stop_pct": "float | None",
    # Added by the post-only signer fix (2026-08-0x, via Lovable). A
    # maker-only resting entry (LIMIT + POST_ONLY); `ExecutionRequest`
    # documents it as off for every strategy path. Additive — every field
    # above is unchanged, so the strategy intent this suite pins is
    # byte-identical and nothing the worker sends is affected.
    "post_only": "bool",
    "campaign_rung_count": "int | None",
    "campaign_margin_usd": "float | None",
    "campaign_margin_per_rung_usd": "float | None",
}


def _annotations(class_name: str, path: str) -> dict:
    tree = ast.parse(open(path).read())
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                stmt.target.id: ast.unparse(stmt.annotation)
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            }
    raise AssertionError(f"{class_name} not found in {path}")


def test_signer_orders_body_fields_and_types_are_unchanged():
    """The signer's contract. If this drifts, the boundary moved."""
    assert _annotations("OrdersMinimalBody", SIGNER_MAIN) == EXPECTED_SIGNER_FIELDS


def test_signer_tp_tier_shape_is_unchanged():
    assert _annotations("TpTierBody", SIGNER_MAIN) == {
        "rr_multiple": "float", "size_frac": "float",
    }


def test_signer_preflight_and_clamps_are_unchanged():
    src = open(SIGNER_MAIN).read()
    # Authoritative sizing contract: worker sizes, signer quantizes and caps.
    assert "size_override = format(decimal.Decimal(str(body.size)), \"f\")" in src
    assert "leverage = max(1, min(100, leverage))" in src
    assert 'DEFAULT_STOP_PCT = decimal.Decimal("0.05")' in src
    execution = open("signer/app/execution.py").read()
    for code in (
        "KILL_SWITCH_ACTIVE", "EQUITY_UNAVAILABLE", "EQUITY_INVALID",
        # EQUITY_BELOW_MIN is deliberately ABSENT: there is no wallet-size
        # minimum. The reserve floor below is what remains.
        "EQUITY_BELOW_FLOOR",
        "EXISTING_OPEN_ORDER", "EXISTING_OPEN_POSITION",
    ):
        assert code in execution, code
