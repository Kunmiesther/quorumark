
-- Widen the pre-existing state check
ALTER TABLE public.paper_engine_operations
  DROP CONSTRAINT IF EXISTS paper_engine_operations_state_check;
ALTER TABLE public.paper_engine_operations
  ADD CONSTRAINT paper_engine_operations_state_check
  CHECK (state IN ('claimed','completed','conflict','dead_letter','orphaned'));

ALTER TABLE public.paper_engine_operations
  ADD COLUMN IF NOT EXISTS recovery_reason  text,
  ADD COLUMN IF NOT EXISTS recovered_at     timestamptz;

-- ---------- 1. universe restore ----------
UPDATE public.paper_test_symbols
   SET enabled = false, updated_at = now()
 WHERE symbol NOT IN
   ('BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','BNB-USDT',
    'ADA-USDT','AVAX-USDT','LINK-USDT','LTC-USDT','DOGE-USDT');

WITH users AS (SELECT DISTINCT user_id FROM public.paper_test_symbols),
required(symbol,lev,ord) AS (VALUES
  ('BTC-USDT',100,1),('ETH-USDT',100,2),('SOL-USDT',50,3),
  ('XRP-USDT',50,4),('BNB-USDT',50,5),('ADA-USDT',50,6),
  ('AVAX-USDT',50,7),('LINK-USDT',50,8),('LTC-USDT',50,9),
  ('DOGE-USDT',50,10))
INSERT INTO public.paper_test_symbols
  (user_id, symbol, display_name, exchange, enabled, max_leverage,
   market_available, sort_order)
SELECT u.user_id, r.symbol, split_part(r.symbol,'-',1),
       'apex_omni', true, r.lev, true, r.ord
  FROM users u CROSS JOIN required r
ON CONFLICT (user_id, symbol) DO UPDATE
  SET enabled=true,
      max_leverage=GREATEST(public.paper_test_symbols.max_leverage,EXCLUDED.max_leverage),
      market_available=true, sort_order=EXCLUDED.sort_order, updated_at=now();

-- ---------- 2. stale-ops recovery ----------
-- 2a. orphan: position closed OR missing
WITH stale AS (
  SELECT o.id,
         split_part(o.op_key,':',1) AS kind,
         split_part(o.op_key,':',2) AS ref
    FROM public.paper_engine_operations o
   WHERE o.result IS NULL
     AND o.claimed_at < now() - interval '5 minutes'
),
resolved AS (
  SELECT s.id, (p.id IS NULL) AS pos_missing
    FROM stale s
    LEFT JOIN public.paper_positions p
      ON s.kind IN ('addrung','close') AND p.id::text = s.ref
   WHERE s.kind IN ('addrung','close')
     AND (p.id IS NULL OR p.status = 'closed')
)
UPDATE public.paper_engine_operations o
   SET state='orphaned',
       recovered_at=now(),
       recovery_reason=CASE WHEN r.pos_missing THEN 'orphaned_position_missing'
                            ELSE 'orphaned_position_closed' END,
       result=jsonb_build_object('recovered',true,
         'reason',CASE WHEN r.pos_missing THEN 'orphaned_position_missing'
                       ELSE 'orphaned_position_closed' END,
         'recovered_at',to_jsonb(now())),
       completed_at=now(), updated_at=now()
  FROM resolved r
 WHERE o.id=r.id;

-- 2b. open ops that never wrote a position
UPDATE public.paper_engine_operations
   SET state='dead_letter',
       recovered_at=now(),
       recovery_reason='open_never_wrote_position',
       result=jsonb_build_object('recovered',true,
         'reason','open_never_wrote_position','recovered_at',to_jsonb(now())),
       completed_at=now(), updated_at=now()
 WHERE result IS NULL
   AND claimed_at < now() - interval '5 minutes'
   AND split_part(op_key,':',1)='open';

-- 2c. remaining ambiguous → dead_letter
UPDATE public.paper_engine_operations
   SET state='dead_letter',
       recovered_at=now(),
       recovery_reason='ambiguous_position_open_needs_reconciliation',
       result=jsonb_build_object('recovered',false,
         'reason','ambiguous_position_open_needs_reconciliation',
         'recovered_at',to_jsonb(now())),
       completed_at=now(), updated_at=now()
 WHERE result IS NULL
   AND claimed_at < now() - interval '5 minutes';

-- ---------- 3. lease TTL prune ----------
DELETE FROM public.paper_tick_leases
 WHERE claimed_at < now() - interval '1 day';

-- ---------- 4. zombie-reclaim guard ----------
CREATE OR REPLACE FUNCTION public.paper_engine_ops_block_zombie_reclaim()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.state='dead_letter' AND NEW.state='claimed'
     AND OLD.fingerprint=NEW.fingerprint
     AND OLD.recovery_reason IS NOT NULL THEN
    RAISE EXCEPTION 'op_key % is dead_lettered (%); explicit reset required',
      OLD.op_key, OLD.recovery_reason USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS paper_engine_ops_block_zombie_reclaim_trg
  ON public.paper_engine_operations;
CREATE TRIGGER paper_engine_ops_block_zombie_reclaim_trg
  BEFORE UPDATE OF state ON public.paper_engine_operations
  FOR EACH ROW EXECUTE FUNCTION public.paper_engine_ops_block_zombie_reclaim();
