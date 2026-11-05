
-- 1. paper_epochs
CREATE TABLE IF NOT EXISTS public.paper_epochs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  reason text NOT NULL,
  reconciled_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, run_id)
);

GRANT SELECT ON public.paper_epochs TO authenticated;
GRANT ALL ON public.paper_epochs TO service_role;
ALTER TABLE public.paper_epochs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners view epochs" ON public.paper_epochs FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 2. Relax slot symbol constraint: allow hedge/recovery reserved with NULL symbol
ALTER TABLE public.paper_execution_slots DROP CONSTRAINT IF EXISTS paper_slot_symbol_when_assigned;
ALTER TABLE public.paper_execution_slots ADD CONSTRAINT paper_slot_symbol_when_assigned CHECK (
  (state = 'unassigned' AND assigned_symbol IS NULL AND assigned_direction IS NULL)
  OR (state IN ('hedge_reserved','recovery_reserved'))
  OR (state IN ('reserved','committed','active') AND assigned_symbol IS NOT NULL)
);

-- 3. Extend exit_reason to allow archival reason
ALTER TABLE public.paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE public.paper_trades ADD CONSTRAINT paper_trades_exit_reason_check CHECK (
  exit_reason = ANY (ARRAY['tp_touch','stop','floor','scout_bos','paper_reset'])
);

-- 4. Reset RPC — idempotent by (user_id, run_id)
CREATE OR REPLACE FUNCTION public.paper_reset_epoch(
  p_run_id text,
  p_reason text DEFAULT 'dynamic_universe_autonomous_soak_test',
  p_hedge_reserve int DEFAULT 1,
  p_recovery_reserve int DEFAULT 1
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_epoch_id uuid;
  v_positions_closed int := 0;
  v_ops_cancelled int := 0;
  v_slots_cleared int := 0;
  v_wallets_detached int := 0;
  v_reserve_marked int := 0;
  v_corr uuid := gen_random_uuid();
  v_pos record;
  v_slot_ids uuid[];
  v_existing_status text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  -- Idempotent epoch insert
  INSERT INTO public.paper_epochs(user_id, run_id, reason)
  VALUES (v_user, p_run_id, p_reason)
  ON CONFLICT (user_id, run_id) DO NOTHING
  RETURNING id INTO v_epoch_id;

  IF v_epoch_id IS NULL THEN
    SELECT id, status INTO v_epoch_id, v_existing_status
    FROM public.paper_epochs WHERE user_id = v_user AND run_id = p_run_id;
    IF v_existing_status = 'completed' THEN
      RETURN jsonb_build_object(
        'run_id', p_run_id, 'idempotent', true, 'status','completed',
        'epoch_id', v_epoch_id
      );
    END IF;
  END IF;

  -- Archive open positions at their own entry price (fees already recorded on open)
  FOR v_pos IN
    SELECT * FROM public.paper_positions
    WHERE user_id = v_user AND status = 'open'
    FOR UPDATE
  LOOP
    INSERT INTO public.paper_trades(
      user_id, wallet_key, symbol, direction,
      entry_price, exit_price, exit_reason,
      size_qty, size_notional, margin, leverage,
      pnl_gross, fees, slippage_cost, pnl_net,
      hold_seconds, opened_at, closed_at, position_id
    ) VALUES (
      v_user, v_pos.wallet_key, v_pos.symbol, v_pos.direction,
      v_pos.entry_price, v_pos.entry_price, 'paper_reset',
      v_pos.size_qty, v_pos.size_notional, v_pos.margin, v_pos.leverage,
      0, 0, 0, 0,
      GREATEST(0, EXTRACT(EPOCH FROM (now() - v_pos.entry_ts))::int),
      v_pos.entry_ts, now(), v_pos.id
    );
    UPDATE public.paper_positions
      SET status = 'closed', updated_at = now()
      WHERE id = v_pos.id;
    v_positions_closed := v_positions_closed + 1;
  END LOOP;

  -- Detach wallets from positions
  UPDATE public.paper_wallets
     SET open_position_id = NULL, updated_at = now()
   WHERE user_id = v_user AND open_position_id IS NOT NULL;
  GET DIAGNOSTICS v_wallets_detached = ROW_COUNT;

  -- Complete any lingering claimed engine operations
  UPDATE public.paper_engine_operations
     SET state = 'completed',
         completed_at = now(),
         result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('cancelled_by','paper_reset_epoch','run_id',p_run_id)
   WHERE user_id = v_user AND state = 'claimed';
  GET DIAGNOSTICS v_ops_cancelled = ROW_COUNT;

  -- Clear all execution slots to unassigned
  UPDATE public.paper_execution_slots
     SET state = 'unassigned',
         assigned_symbol = NULL,
         assigned_direction = NULL,
         position_id = NULL,
         reservation_expires_at = NULL,
         correlation_id = v_corr,
         last_transition_at = now(),
         detail = jsonb_build_object('run_id', p_run_id, 'reset_reason', p_reason)
   WHERE user_id = v_user;
  GET DIAGNOSTICS v_slots_cleared = ROW_COUNT;

  -- Materialize reserve slots (highest-indexed slots) with NULL symbol
  IF p_hedge_reserve > 0 THEN
    WITH tgt AS (
      SELECT id FROM public.paper_execution_slots
       WHERE user_id = v_user AND state = 'unassigned'
       ORDER BY slot_index DESC
       LIMIT p_hedge_reserve
    )
    UPDATE public.paper_execution_slots s
       SET state = 'hedge_reserved', last_transition_at = now()
     WHERE s.id IN (SELECT id FROM tgt);
    GET DIAGNOSTICS v_reserve_marked = ROW_COUNT;
  END IF;
  IF p_recovery_reserve > 0 THEN
    WITH tgt AS (
      SELECT id FROM public.paper_execution_slots
       WHERE user_id = v_user AND state = 'unassigned'
       ORDER BY slot_index DESC
       LIMIT p_recovery_reserve
    )
    UPDATE public.paper_execution_slots s
       SET state = 'recovery_reserved', last_transition_at = now()
     WHERE s.id IN (SELECT id FROM tgt);
    v_reserve_marked := v_reserve_marked + (SELECT count(*) FROM public.paper_execution_slots WHERE user_id=v_user AND state='recovery_reserved');
  END IF;

  -- Audit event
  INSERT INTO public.ops_events(user_id, correlation_id, stage, component, severity, message, detail)
  VALUES (
    v_user, v_corr, 'paper_intent', 'paper_reset_epoch', 'info',
    'paper epoch reset: ' || p_reason,
    jsonb_build_object(
      'run_id', p_run_id,
      'positions_closed', v_positions_closed,
      'ops_cancelled', v_ops_cancelled,
      'slots_cleared', v_slots_cleared,
      'wallets_detached', v_wallets_detached,
      'reserve_marked', v_reserve_marked
    )
  );

  UPDATE public.paper_epochs
     SET status = 'completed',
         completed_at = now(),
         reconciled_counts = jsonb_build_object(
           'positions_closed', v_positions_closed,
           'ops_cancelled', v_ops_cancelled,
           'slots_cleared', v_slots_cleared,
           'wallets_detached', v_wallets_detached,
           'reserve_marked', v_reserve_marked
         )
   WHERE id = v_epoch_id;

  RETURN jsonb_build_object(
    'run_id', p_run_id,
    'epoch_id', v_epoch_id,
    'reason', p_reason,
    'positions_closed', v_positions_closed,
    'ops_cancelled', v_ops_cancelled,
    'slots_cleared', v_slots_cleared,
    'wallets_detached', v_wallets_detached,
    'reserve_marked', v_reserve_marked,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.paper_reset_epoch(text, text, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.paper_reset_epoch(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.paper_reset_epoch(text, text, int, int) TO service_role;
