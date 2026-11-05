# Paper Environment Reset ("Fresh Season")

`public.reset_paper_environment()` is an admin-only SECURITY DEFINER function
that wipes all per-run paper-trading data and returns wallets/accounts to base
equity. Use it whenever the engine configuration changes materially (regime
routing, sizing, arming policy, etc.) so the new season's dataset is not
contaminated by pre-change trades.

## How to run

Service-role only. `EXECUTE` is revoked from `PUBLIC`, `anon`, and
`authenticated`. Call from a trusted admin context:

```sql
SELECT public.reset_paper_environment();
```

Returns a `jsonb` payload with `reset_at` and per-table `counts` of rows
deleted plus `paper_wallets_reset` / `paper_accounts_reset` update counts.

## What it wipes

All rows in:

- `paper_positions`, `paper_trades`, `paper_rung_fills`
- `paper_authorizations`, `paper_order_intents`
- `paper_symbol_pods`, `paper_wallet_legs`, `paper_execution_slots`,
  `paper_execution_slot_audit`, `paper_epochs`
- `paper_engine_operations`, `paper_tick_leases`
- `onyx_decisions`
- `scout_signals`, `scout_evidence`, `scout_scans`, `scout_signal_state`,
  `scout_state_transitions`, `scout_outcomes`, `scout_bias_state`,
  `scout_corrections`, `scout_ranking_state`, `scout_rotation_state`,
  `scout_symbol_rankings`, `scout_universe_snapshots`,
  `scout_rule_proposals`, `scout_guardian_directives`
- `bot_events`, `bot_status_events`, `ops_events`, `ops_health_snapshots`
- `bill_allocations`, `bill_sync_cursor` (Life-Map coverage restarts at $0
  for the new season)

## What it resets

- `paper_wallets` — `balance` → `WALLET_BASE` (600), `realized_pnl` → 0,
  counters/cursors cleared, `open_position_id` nulled, `floor_hit` false.
- `paper_accounts` — `balance` → `STARTING_ACCOUNT_BALANCE` (3600),
  `realized_pnl` → 0.

## What it preserves

- `auth.users`, `profiles`, `user_roles`
- `bills` (user-entered Life-Map obligations)
- `paper_test_symbols` (per-user symbol allowlist / tick / leverage caps)
- `paper_engine_authority` (system authority row)
- `kill_switches`, `venue_capabilities`, wallet/exchange configs, all
  strategy toggles

## Guards

- Does not change engine logic, guardian, worker, signer/broker, or parity
  constants.
- `is_live` stays `false`; `SIGN_ORDER` stays disabled.
- Preserves all schema; only DML.

## Season boundary

The `reset_at` timestamp in the returned payload is the canonical start of
the new season. Compare `paper_trades.opened_at >= reset_at` when analysing
season-scoped performance.
