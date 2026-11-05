# Supabase change proposals — for Lovable to review and apply

Supabase is owned and controlled by Lovable. **Nothing in this directory has
been applied.** No migration was executed, no Edge Function was deployed, no
RLS policy, secret, or project setting was changed. The repository's live
`supabase/` tree is byte-identical to `main`.

These are reviewable files. Lovable applies, tests, and deploys them.

## What is proposed

| File | Target | What it does |
| --- | --- | --- |
| `001_strategy_decisions.proposed.sql` | `supabase/migrations/<timestamp>_strategy_decisions.sql` | Creates `strategy_decisions` and `ai_decision_opinions` |
| `002_worker_ingest_decision_ops.proposed.diff` | `supabase/functions/worker-ingest/index.ts` | Unified diff against current `main` |
| `002_worker_ingest_index.proposed.ts` | `supabase/functions/worker-ingest/index.ts` | The same change as a complete file, if a diff apply is inconvenient |

Rename `001_*.sql` to whatever timestamp is correct when you apply it; nothing
references the filename.

## Deploy order: preferred, but NOT required

**Recording is an audit trail, not an authority.** If these changes are not
applied, `DECISION_UPSERT` returns `400 UNKNOWN_OPERATION`, the worker logs a
warning, and **trading continues exactly as it did before.** No decision rows
are written and the flow panel shows nothing, but no trade is blocked.

Duplicate submission is still prevented, in the place it always was: the
broker's fingerprint plus fail-closed audit reservation and the signer's
idempotency store, both keyed on the unchanged `idempotency_key`. Those are
durable across restarts and redeploys and do not depend on this ledger.

Preferred sequence, purely so the UI has data from the first candle:

1. Lovable applies `001` (migration).
2. Lovable deploys `002` (edge function).
3. Verify: `DECISION_UPSERT` returns `{ok: true, execution_state: "not_reached"}`.
4. Deploy the Railway worker.

Any other order is safe. Rolling back is safe in either direction: reverting
the worker alone restores the previous behaviour, and the two new tables are
unread by the old code.

`tests/test_decision_pipeline.py::test_an_undeployed_ledger_op_does_not_block_the_trade`
pins this — it simulates exactly the not-yet-applied case and asserts the
order still reaches the broker.

## What the migration does and does not touch

**Additive only.** It creates two tables and one trigger function. It does not
alter, drop, or backfill `strategy_candidates`, `order_intents`, `order_audit`,
`ai_committee_evaluations`, `bot_events`, or any other existing object.
`tests/test_decision_ingest_contract.py::test_the_migration_is_additive_only`
asserts this by scanning for destructive statements.

- `strategy_decisions` — one immutable row per completed 5m candle per verified
  live connection and symbol, including WAIT. `UNIQUE (connection_id, symbol,
  candle_close_at)` is the same tuple `decision_id` hashes, so the database —
  not the worker — guarantees one decision per candle. A `BEFORE UPDATE`
  trigger makes the decision fields write-once; only the execution columns
  move, and only forward.
- `ai_decision_opinions` — advisory AI opinions keyed to a decision. `advisory
  IS TRUE` is a CHECK constraint, and a CHECK forbids an `unavailable` row from
  carrying a direction, so provider silence can never be stored as agreement.

**RLS:** both tables enable RLS with a SELECT-only policy scoped to
`auth.uid() = user_id`. `GRANT SELECT` to `authenticated`, `GRANT ALL` to
`service_role`. No INSERT/UPDATE/DELETE grant to `authenticated` — the browser
can read decisions and never fabricate one. Writes arrive only through the
existing signed `worker-ingest` path.

## What the Edge Function change does

Adds two operations to the existing `worker-ingest` allowlist and one event
code. It writes exactly one table (`strategy_decisions`), holds no credential,
and has no path to the signer, the broker, or a venue — asserted by
`test_neither_op_can_reach_a_credential_or_the_signer`.

- `DECISION_UPSERT` — idempotent on `decision_id` with `ignoreDuplicates`, then
  **always reads the row back** and returns the stored `execution_state`. That
  read-back is the durable duplicate-submission guard: a worker restarting
  mid-candle learns from the server that the candle was already acted on,
  which an in-memory set could never tell it. If the read-back is ever removed,
  a redeploy mid-candle can submit a second order.
- `DECISION_EXECUTION_UPDATE` — moves the execution record forward only, via a
  strict rank table. A late or out-of-order retry cannot turn a recorded
  rejection back into "in flight". It can write only `execution_state`,
  `execution_updated_at`, `execution_reason_code`, and three JSONB payload
  columns; it cannot touch any decision field.

Both are rate-limited, validate every identity field, reject secret-looking
payloads, and cap detail size — the same guards the existing ops use.

## Verification already run against these files

`tests/test_decision_ingest_contract.py` (16 tests) runs against **this
directory**, not the live tree, so the proposal is verified before you receive
it: op allowlist and dispatch wiring, rate limits, upsert idempotency and
read-back, strict monotonic execution ranks, identity validation, the immutable
decision fields, the advisory-only constraints, the SELECT-only grants, and the
additive-only property.

Two tests assert the boundary itself held —
`test_the_live_supabase_function_is_untouched_by_this_work` and
`test_no_migration_was_added_to_the_live_migrations_directory`.
