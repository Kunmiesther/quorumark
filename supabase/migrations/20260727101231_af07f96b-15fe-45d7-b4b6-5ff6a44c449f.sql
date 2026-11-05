-- 1) bill_allocations: add source column + widen unique index
ALTER TABLE public.bill_allocations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'paper';

ALTER TABLE public.bill_allocations
  DROP CONSTRAINT IF EXISTS bill_allocations_source_check;
ALTER TABLE public.bill_allocations
  ADD CONSTRAINT bill_allocations_source_check
  CHECK (source IN ('paper','live'));

DROP INDEX IF EXISTS public.bill_allocations_trade_bill_uidx;
CREATE UNIQUE INDEX bill_allocations_trade_bill_uidx
  ON public.bill_allocations (user_id, source, trade_id, bill_id)
  WHERE trade_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bill_allocations_user_source_period_idx
  ON public.bill_allocations (user_id, source, period_key);

-- 2) bill_sync_cursor: promote to per-(user, source) PK
ALTER TABLE public.bill_sync_cursor
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'paper';

ALTER TABLE public.bill_sync_cursor
  DROP CONSTRAINT IF EXISTS bill_sync_cursor_source_check;
ALTER TABLE public.bill_sync_cursor
  ADD CONSTRAINT bill_sync_cursor_source_check
  CHECK (source IN ('paper','live'));

ALTER TABLE public.bill_sync_cursor
  DROP CONSTRAINT IF EXISTS bill_sync_cursor_pkey;
ALTER TABLE public.bill_sync_cursor
  ADD CONSTRAINT bill_sync_cursor_pkey PRIMARY KEY (user_id, source);
