
DELETE FROM paper_rung_fills;
DELETE FROM paper_trades;
DELETE FROM paper_order_intents;
DELETE FROM paper_authorizations;
DELETE FROM paper_positions;
DELETE FROM paper_engine_operations;
DELETE FROM paper_execution_slot_audit;
DELETE FROM onyx_decisions;
DELETE FROM scout_state_transitions;
DELETE FROM scout_signal_state;
DELETE FROM scout_signals;
DELETE FROM scout_evidence;
DELETE FROM scout_outcomes;
DELETE FROM scout_scans;
DELETE FROM scout_symbol_rankings;
DELETE FROM scout_universe_snapshots;
UPDATE paper_execution_slots
   SET state='unassigned', assigned_symbol=NULL, assigned_direction=NULL,
       position_id=NULL, reservation_expires_at=NULL, updated_at=now();
UPDATE paper_wallets SET balance=3600, updated_at=now();
