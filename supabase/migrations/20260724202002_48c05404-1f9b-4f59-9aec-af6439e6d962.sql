
-- reset_paper_environment(): admin-only "fresh season" wipe.
-- SECURITY DEFINER, callable only by service_role. Not exposed to
-- authenticated/anon. Preserves auth users, profiles, bills, bot
-- configs (paper_test_symbols, paper_engine_authority), kill switches.

CREATE OR REPLACE FUNCTION public.reset_paper_environment()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  -- Bill linkage (must go before paper_trades due to FK-by-value, no hard FK but conceptual)
  WITH d AS (DELETE FROM public.bill_allocations RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_allocations', v_n);

  WITH d AS (DELETE FROM public.bill_sync_cursor RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_sync_cursor', v_n);

  -- Paper trading history / open state
  WITH d AS (DELETE FROM public.paper_rung_fills RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_rung_fills', v_n);

  WITH d AS (DELETE FROM public.paper_trades RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_trades', v_n);

  WITH d AS (DELETE FROM public.paper_positions RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_positions', v_n);

  WITH d AS (DELETE FROM public.paper_authorizations RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_authorizations', v_n);

  WITH d AS (DELETE FROM public.paper_order_intents RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_order_intents', v_n);

  -- Dynamic-universe pipeline state (currently disabled but wipe stale rows)
  WITH d AS (DELETE FROM public.paper_execution_slot_audit RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_execution_slot_audit', v_n);

  WITH d AS (DELETE FROM public.paper_execution_slots RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_execution_slots', v_n);

  WITH d AS (DELETE FROM public.paper_wallet_legs RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_wallet_legs', v_n);

  WITH d AS (DELETE FROM public.paper_symbol_pods RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_symbol_pods', v_n);

  WITH d AS (DELETE FROM public.paper_epochs RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_epochs', v_n);

  -- Engine op ledger + tick leases (safe to wipe: replay/dedup only)
  WITH d AS (DELETE FROM public.paper_engine_operations RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_engine_operations', v_n);

  WITH d AS (DELETE FROM public.paper_tick_leases RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('paper_tick_leases', v_n);

  -- Onyx / Scout decision & intel state
  WITH d AS (DELETE FROM public.onyx_decisions RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('onyx_decisions', v_n);

  WITH d AS (DELETE FROM public.scout_evidence RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_evidence', v_n);

  WITH d AS (DELETE FROM public.scout_state_transitions RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_state_transitions', v_n);

  WITH d AS (DELETE FROM public.scout_signal_state RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_signal_state', v_n);

  WITH d AS (DELETE FROM public.scout_signals RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_signals', v_n);

  WITH d AS (DELETE FROM public.scout_scans RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_scans', v_n);

  WITH d AS (DELETE FROM public.scout_outcomes RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_outcomes', v_n);

  WITH d AS (DELETE FROM public.scout_corrections RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_corrections', v_n);

  WITH d AS (DELETE FROM public.scout_bias_state RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_bias_state', v_n);

  WITH d AS (DELETE FROM public.scout_ranking_state RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_ranking_state', v_n);

  WITH d AS (DELETE FROM public.scout_rotation_state RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_rotation_state', v_n);

  WITH d AS (DELETE FROM public.scout_symbol_rankings RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_symbol_rankings', v_n);

  WITH d AS (DELETE FROM public.scout_universe_snapshots RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_universe_snapshots', v_n);

  WITH d AS (DELETE FROM public.scout_rule_proposals RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_rule_proposals', v_n);

  WITH d AS (DELETE FROM public.scout_guardian_directives RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('scout_guardian_directives', v_n);

  -- Telemetry
  WITH d AS (DELETE FROM public.bot_events RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bot_events', v_n);

  WITH d AS (DELETE FROM public.bot_status_events RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bot_status_events', v_n);

  WITH d AS (DELETE FROM public.ops_events RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('ops_events', v_n);

  WITH d AS (DELETE FROM public.ops_health_snapshots RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('ops_health_snapshots', v_n);

  -- Reset wallets to base equity, clear counters and cursors.
  UPDATE public.paper_wallets
     SET balance = 600,
         realized_pnl = 0,
         open_position_id = NULL,
         floor_hit = false,
         trades_count = 0,
         wins_count = 0,
         losses_count = 0,
         last_tick_at = NULL,
         last_processed_candle_ts_ms = NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('paper_wallets_reset', v_n);

  -- Reset shared cross-margin accounts to STARTING_ACCOUNT_BALANCE.
  UPDATE public.paper_accounts
     SET balance = 3600,
         realized_pnl = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('paper_accounts_reset', v_n);

  RETURN jsonb_build_object(
    'reset_at', to_jsonb(now()),
    'counts', v_counts
  );
END;
$$;

-- Lock it down: admin/service only. Not callable by authenticated users.
REVOKE ALL ON FUNCTION public.reset_paper_environment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_paper_environment() FROM anon;
REVOKE ALL ON FUNCTION public.reset_paper_environment() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_paper_environment() TO service_role;

COMMENT ON FUNCTION public.reset_paper_environment() IS
  'Admin-only fresh-season paper wipe. Deletes all paper positions/trades/rung fills, all engine/onyx/scout/telemetry state, all bill_allocations and bill_sync_cursor rows; resets paper_wallets to $600 base and paper_accounts to $3600. Preserves auth users, profiles, bills, paper_test_symbols, paper_engine_authority, kill_switches. service_role only.';
