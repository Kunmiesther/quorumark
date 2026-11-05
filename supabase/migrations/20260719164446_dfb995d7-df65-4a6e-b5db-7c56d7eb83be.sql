DO $$
DECLARE
  v_user_id uuid := '0b7b1651-b3a5-4370-b89f-0deeaba4ea3f';
BEGIN
  DELETE FROM public.paper_trades
   WHERE user_id = v_user_id;

  DELETE FROM public.paper_positions
   WHERE user_id = v_user_id;

  UPDATE public.paper_wallets
     SET balance = 600,
         realized_pnl = 0,
         open_position_id = NULL,
         floor_hit = false,
         trades_count = 0,
         wins_count = 0,
         losses_count = 0,
         last_tick_at = NULL,
         updated_at = now()
   WHERE user_id = v_user_id;
END $$;