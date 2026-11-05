"""The worker <-> edge contract for the decision ledger.

SUBJECT: the PROPOSED Supabase changes in `docs/supabase-proposals/`, not the
live `supabase/` tree. Supabase is owned and controlled by Lovable; this
repository's `supabase/` directory is left untouched by this work, and these
tests exist so the proposal Lovable receives is already verified rather than
merely written.

The two sides are separate deployments. Anything that must agree between them
is asserted here, because a silent drift shows up in production as decisions
that vanish — and a decision the worker cannot record is a decision it will
refuse to execute.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import worker_ingest_client as wic

PROPOSALS = "docs/supabase-proposals"
EDGE = f"{PROPOSALS}/002_worker_ingest_index.proposed.ts"
MIGRATION = f"{PROPOSALS}/001_strategy_decisions.proposed.sql"
LIVE_EDGE = "supabase/functions/worker-ingest/index.ts"


def _edge() -> str:
    return open(EDGE).read()


def test_client_and_edge_operation_allowlists_agree_on_the_new_ops():
    src = _edge()
    for op in ("DECISION_UPSERT", "DECISION_EXECUTION_UPDATE"):
        assert f'"{op}"' in src, op
        assert f'if (op === "{op}")' in src, op


def test_client_and_edge_event_allowlists_still_match():
    """The generic parity test lives in test_worker_ingest.py; this pins the
    one code the refactor added."""
    assert "STRATEGY_DECISION" in wic.ALLOWED_EVENT_CODES
    assert '"STRATEGY_DECISION"' in _edge()


def test_the_live_supabase_function_carries_what_lovable_applied():
    """Supabase is Lovable's to apply, and on 2026-08-01 it did.

    This assertion used to be the inverse — that the live edge function
    carried NONE of the proposed ops, proving nothing could reach production
    without Lovable. That guard did its job for the whole review period and
    is now spent: keeping it would mean a correctly applied migration reads
    as a failing build.

    What is worth holding afterwards is the other direction: the worker
    client and the deployed function must agree about these operations, or
    the worker emits an op the server 400s on."""
    live = open(LIVE_EDGE).read()
    for op in ("DECISION_UPSERT", "DECISION_EXECUTION_UPDATE", "STRATEGY_DECISION"):
        assert op in live, op


def test_no_migration_was_added_to_the_live_migrations_directory():
    added = [f for f in os.listdir("supabase/migrations") if "strategy_decisions" in f]
    assert added == [], added


def test_both_new_ops_are_rate_limited():
    src = _edge()
    assert re.search(r"DECISION_UPSERT:\s*\{\s*perMinute:\s*\d+", src)
    assert re.search(r"DECISION_EXECUTION_UPDATE:\s*\{\s*perMinute:\s*\d+", src)


def test_the_upsert_is_idempotent_and_returns_the_stored_state():
    """This is the duplicate-submission guard. If the handler ever stops
    ignoring duplicates, or stops reading the row back, a redeploy mid-candle
    can submit a second order."""
    src = _edge()
    assert 'onConflict: "decision_id", ignoreDuplicates: true' in src
    assert "DECISION_READBACK_FAILED" in src
    assert "execution_state: stored.execution_state ?? \"not_reached\"" in src


def test_execution_state_moves_forward_only():
    src = _edge()
    assert "const EXECUTION_RANK" in src
    assert "if (EXECUTION_RANK[state] <= currentRank)" in src
    # Ranks must be strictly ordered, or "forward only" means nothing.
    ranks = dict(re.findall(r"^\s{2}(\w+): (\d+),$", src, re.M))
    ordered = ["not_reached", "blocked", "intent_created", "submitted",
               "ambiguous", "rejected", "filled"]
    values = [int(ranks[name]) for name in ordered]
    assert values == sorted(values)
    assert len(set(values)) == len(values)


def test_the_upsert_validates_every_identity_field():
    src = _edge()
    for code in ("BAD_DECISION_ID", "BAD_DECISION_USER", "BAD_DECISION_CONNECTION",
                 "BAD_DECISION_SYMBOL", "BAD_DECISION_DIRECTION",
                 "BAD_DECISION_REASON", "BAD_DECISION_CANDLE", "BAD_DECISION_EVIDENCE"):
        assert code in src, code
    # The id shape is pinned so a caller cannot invent an identity format.
    assert "/^dec_v1_[0-9a-f]{32}$/" in src


def test_the_execution_update_cannot_rewrite_the_decision():
    src = _edge()
    block = src[src.index("async function handleDecisionExecutionUpdate"):]
    block = block[:block.index("// ---------------------------------------------------------------------------\n// SHADOW_LEDGER_INSERT")]
    patch_keys = re.findall(r"patch(?:\.|\[\")(\w+)", block)
    allowed = {"execution_state", "execution_updated_at", "execution_reason_code"}
    for key in patch_keys:
        assert key in allowed, key
    # The three jsonb payload columns are set via the mapping table only.
    assert '["safety", "safety_checks"]' in block
    assert '["intent", "order_intent"]' in block
    assert '["apex_result", "apex_result"]' in block


def test_neither_op_can_reach_a_credential_or_the_signer():
    src = _edge()
    block = src[src.index("async function handleDecisionUpsert"):src.index("async function handleShadowLedgerInsert")]
    lower = block.lower()
    # `apex_result` is a COLUMN — recording an outcome, not producing one.
    for forbidden in ("credential", "signer", "decrypt", "order_audit", "order_intents", "fetch("):
        assert forbidden not in lower, forbidden
    # The only tables these handlers touch.
    tables = set(re.findall(r'\.from\("(\w+)"\)', block))
    assert tables == {"strategy_decisions"}


def test_the_migration_enforces_one_decision_per_candle():
    sql = open(MIGRATION).read()
    assert "UNIQUE (connection_id, symbol, candle_close_at)" in sql
    assert "decision_id text PRIMARY KEY" in sql


def test_the_migration_makes_the_decision_fields_immutable():
    sql = open(MIGRATION).read()
    guard = sql[sql.index("CREATE OR REPLACE FUNCTION public.strategy_decisions_guard"):]
    for column in ("direction", "reason_code", "evidence_hash", "candle_close_at", "symbol"):
        assert f"NEW.{column}" in guard, column
    assert "decision fields are immutable" in guard


def test_the_migration_is_additive_only():
    """Rollback must be a worker revert, not a data migration."""
    sql = open(MIGRATION).read().upper()
    for destructive in ("DROP TABLE", "DELETE FROM", "TRUNCATE", "ALTER TABLE PUBLIC.ORDER_INTENTS",
                        "ALTER TABLE PUBLIC.STRATEGY_CANDIDATES", "ALTER TABLE PUBLIC.ORDER_AUDIT"):
        assert destructive not in sql, destructive


def test_ai_opinions_can_never_be_marked_authoritative():
    sql = open(MIGRATION).read()
    assert "ai_decision_opinions_advisory_only CHECK (advisory IS TRUE)" in sql
    # An unavailable provider cannot carry a direction — silence is never
    # storable as agreement.
    assert "status = 'unavailable' AND direction IS NULL" in sql


def test_ai_opinions_are_read_only_from_the_browser():
    sql = open(MIGRATION).read()
    assert "GRANT SELECT ON public.ai_decision_opinions TO authenticated;" in sql
    assert "GRANT SELECT ON public.strategy_decisions TO authenticated;" in sql
    # No INSERT/UPDATE grant to authenticated anywhere in this migration.
    assert not re.search(r"GRANT [^;]*INSERT[^;]*TO authenticated", sql)


def test_the_client_ops_are_retry_safe_where_they_claim_to_be():
    src = open("worker_ingest_client.py").read()
    upsert = src[src.index("def upsert_decision"):src.index("def update_decision_execution")]
    assert "idempotent=True" in upsert
    update = src[src.index("def update_decision_execution"):src.index("def insert_shadow_ledger")]
    assert "idempotent=True" in update
