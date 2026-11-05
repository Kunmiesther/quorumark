
-- Life Map v2 — bills, allocations, and sync cursor.

-- =========================================================================
-- 1) bills
-- =========================================================================
CREATE TABLE public.bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  amount_usd numeric(12, 2) NOT NULL CHECK (amount_usd > 0),
  cadence text NOT NULL CHECK (cadence IN ('monthly', 'weekly', 'one_time')),
  due_day int NULL,
  priority int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL
);

CREATE INDEX bills_user_active_idx
  ON public.bills (user_id, priority ASC, created_at ASC)
  WHERE archived_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bills TO authenticated;
GRANT ALL ON public.bills TO service_role;

ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bills owner read"
  ON public.bills FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "bills owner insert"
  ON public.bills FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bills owner update"
  ON public.bills FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bills owner delete"
  ON public.bills FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- =========================================================================
-- 2) bill_allocations
-- =========================================================================
CREATE TABLE public.bill_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  trade_id uuid NULL,
  amount_usd numeric(14, 4) NOT NULL,
  period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency guarantee: even if the cursor is rewound, we cannot insert
-- the same (user, trade, bill) row twice.
CREATE UNIQUE INDEX bill_allocations_trade_bill_uidx
  ON public.bill_allocations (user_id, trade_id, bill_id)
  WHERE trade_id IS NOT NULL;

CREATE INDEX bill_allocations_bill_period_idx
  ON public.bill_allocations (bill_id, period_key);

CREATE INDEX bill_allocations_user_period_idx
  ON public.bill_allocations (user_id, period_key);

CREATE INDEX bill_allocations_trade_idx
  ON public.bill_allocations (user_id, trade_id)
  WHERE trade_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_allocations TO authenticated;
GRANT ALL ON public.bill_allocations TO service_role;

ALTER TABLE public.bill_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_allocations owner read"
  ON public.bill_allocations FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "bill_allocations owner insert"
  ON public.bill_allocations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bill_allocations owner update"
  ON public.bill_allocations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bill_allocations owner delete"
  ON public.bill_allocations FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- =========================================================================
-- 3) bill_sync_cursor
-- =========================================================================
CREATE TABLE public.bill_sync_cursor (
  user_id uuid PRIMARY KEY,
  last_trade_closed_at timestamptz NULL,
  last_trade_id uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_sync_cursor TO authenticated;
GRANT ALL ON public.bill_sync_cursor TO service_role;

ALTER TABLE public.bill_sync_cursor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_sync_cursor owner read"
  ON public.bill_sync_cursor FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "bill_sync_cursor owner insert"
  ON public.bill_sync_cursor FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bill_sync_cursor owner update"
  ON public.bill_sync_cursor FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =========================================================================
-- 4) profiles: bills_prompt_dismissed_at
-- =========================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bills_prompt_dismissed_at timestamptz NULL;

-- =========================================================================
-- 5) updated_at trigger for bills / bill_sync_cursor
-- =========================================================================
CREATE OR REPLACE FUNCTION public.bills_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER bills_touch_updated_at
  BEFORE UPDATE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.bills_touch_updated_at();

CREATE TRIGGER bill_sync_cursor_touch_updated_at
  BEFORE UPDATE ON public.bill_sync_cursor
  FOR EACH ROW EXECUTE FUNCTION public.bills_touch_updated_at();
