-- P3: Life Map normalization + Risk Capital designation
-- Idempotent, non-destructive. No synthetic data inserted.

------------------------------------------------------------------
-- 1) life_categories
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.life_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  icon text,
  is_custom boolean NOT NULL DEFAULT false,
  is_essential boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.life_categories TO authenticated;
GRANT ALL ON public.life_categories TO service_role;
ALTER TABLE public.life_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "life_categories_own_select" ON public.life_categories;
DROP POLICY IF EXISTS "life_categories_own_insert" ON public.life_categories;
DROP POLICY IF EXISTS "life_categories_own_update" ON public.life_categories;
DROP POLICY IF EXISTS "life_categories_own_delete" ON public.life_categories;
CREATE POLICY "life_categories_own_select" ON public.life_categories FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "life_categories_own_insert" ON public.life_categories FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "life_categories_own_update" ON public.life_categories FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "life_categories_own_delete" ON public.life_categories FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_life_categories_updated_at ON public.life_categories;
CREATE TRIGGER update_life_categories_updated_at BEFORE UPDATE ON public.life_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

------------------------------------------------------------------
-- 2) life_obligations
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.life_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.life_categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill','goal')),
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  due_date date NULL,
  recurrence text NULL CHECK (recurrence IS NULL OR recurrence IN ('once','weekly','biweekly','monthly','quarterly','annually')),
  is_essential boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('paid','funded','upcoming','overdue')),
  monthly_funding_target numeric NOT NULL DEFAULT 0,
  reminder_schedule jsonb NULL,
  notes text NULL,
  legacy_item_id text NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS life_obligations_user_cat_legacy_uniq
  ON public.life_obligations (user_id, category_id, legacy_item_id)
  WHERE legacy_item_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.life_obligations TO authenticated;
GRANT ALL ON public.life_obligations TO service_role;
ALTER TABLE public.life_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "life_obligations_own_select" ON public.life_obligations;
DROP POLICY IF EXISTS "life_obligations_own_insert" ON public.life_obligations;
DROP POLICY IF EXISTS "life_obligations_own_update" ON public.life_obligations;
DROP POLICY IF EXISTS "life_obligations_own_delete" ON public.life_obligations;
CREATE POLICY "life_obligations_own_select" ON public.life_obligations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "life_obligations_own_insert" ON public.life_obligations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "life_obligations_own_update" ON public.life_obligations FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "life_obligations_own_delete" ON public.life_obligations FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_life_obligations_updated_at ON public.life_obligations;
CREATE TRIGGER update_life_obligations_updated_at BEFORE UPDATE ON public.life_obligations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

------------------------------------------------------------------
-- 3) life_obligation_history (append-only)
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.life_obligation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL REFERENCES public.life_obligations(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('created','updated','funded','paid','skipped','overdue','deleted')),
  amount numeric NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NULL
);

GRANT SELECT, INSERT ON public.life_obligation_history TO authenticated;
GRANT ALL ON public.life_obligation_history TO service_role;
ALTER TABLE public.life_obligation_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "life_obligation_history_own_select" ON public.life_obligation_history;
DROP POLICY IF EXISTS "life_obligation_history_own_insert" ON public.life_obligation_history;
CREATE POLICY "life_obligation_history_own_select" ON public.life_obligation_history FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "life_obligation_history_own_insert" ON public.life_obligation_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
-- No UPDATE/DELETE policies: append-only.

------------------------------------------------------------------
-- 4) Seed 8 canonical categories for EXISTING users only
------------------------------------------------------------------
WITH seed(key, label, icon, is_essential, sort_order) AS (
  VALUES
    ('roof',     'Roof',     'home',    true,  1),
    ('ride',     'Ride',     'car',     true,  2),
    ('memories', 'Memories', 'camera',  false, 3),
    ('escape',   'Escape',   'plane',   false, 4),
    ('body',     'Body',     'heart',   true,  5),
    ('family',   'Family',   'users',   false, 6),
    ('debt',     'Debt',     'credit-card', true, 7),
    ('future',   'Future',   'sparkles', false, 8)
)
INSERT INTO public.life_categories (user_id, key, label, icon, is_custom, is_essential, sort_order)
SELECT p.id, s.key, s.label, s.icon, false, s.is_essential, s.sort_order
FROM public.profiles p
CROSS JOIN seed s
ON CONFLICT (user_id, key) DO NOTHING;

------------------------------------------------------------------
-- 5) JSON migration of profiles.target_budget_items -> obligations
------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS life_map_migrated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS target_budget_items_backup jsonb NULL;

-- Back up original JSON (only when backup is NULL, so re-runs never overwrite).
UPDATE public.profiles
   SET target_budget_items_backup = target_budget_items
 WHERE target_budget_items_backup IS NULL;

-- Insert obligations from JSON. Idempotent via unique (user_id, category_id, legacy_item_id).
INSERT INTO public.life_obligations
  (user_id, category_id, name, kind, amount, currency, is_essential, legacy_item_id)
SELECT
  p.id AS user_id,
  c.id AS category_id,
  COALESCE(item->>'label', 'Item') AS name,
  'bill' AS kind,
  COALESCE((item->>'amount')::numeric, 0) AS amount,
  'USD' AS currency,
  (bucket.key IN ('roof','ride')) AS is_essential,
  item->>'id' AS legacy_item_id
FROM public.profiles p
CROSS JOIN LATERAL (
  SELECT key, value
  FROM jsonb_each(p.target_budget_items)
  WHERE jsonb_typeof(p.target_budget_items) = 'object'
) AS bucket(key, value)
JOIN public.life_categories c
  ON c.user_id = p.id AND c.key = bucket.key
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(bucket.value->'items') = 'array'
       THEN bucket.value->'items'
       ELSE '[]'::jsonb END
) AS item
WHERE bucket.key IN ('roof','ride','memories','escape')
  AND item->>'id' IS NOT NULL
ON CONFLICT (user_id, category_id, legacy_item_id) WHERE legacy_item_id IS NOT NULL DO NOTHING;

-- Map BucketState.target -> category's obligation monthly_funding_target on the FIRST matching obligation
-- (idempotent: only sets when currently 0 and JSON has a positive target).
UPDATE public.life_obligations o
   SET monthly_funding_target = (bucket.value->>'target')::numeric
  FROM public.profiles p,
       LATERAL jsonb_each(p.target_budget_items) AS bucket(key, value)
 WHERE o.user_id = p.id
   AND jsonb_typeof(p.target_budget_items) = 'object'
   AND bucket.key IN ('roof','ride','memories','escape')
   AND o.category_id = (SELECT id FROM public.life_categories c WHERE c.user_id = p.id AND c.key = bucket.key)
   AND o.monthly_funding_target = 0
   AND COALESCE((bucket.value->>'target')::numeric, 0) > 0
   AND o.id = (
     SELECT id FROM public.life_obligations
      WHERE user_id = p.id
        AND category_id = o.category_id
      ORDER BY created_at, id
      LIMIT 1
   );

UPDATE public.profiles
   SET life_map_migrated_at = now()
 WHERE life_map_migrated_at IS NULL;

-- NOTE: target_budget_items is intentionally PRESERVED. Backup column retains the original too.

------------------------------------------------------------------
-- 6) Risk Capital allocations
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.risk_capital_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'USD',
  source text NOT NULL DEFAULT 'legacy_profile' CHECK (source IN ('legacy_profile','user_designated','exchange_balance')),
  status text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed','confirmed','revoked')),
  designated_at timestamptz NULL,
  confirmed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one confirmed allocation per user.
CREATE UNIQUE INDEX IF NOT EXISTS risk_capital_allocations_one_confirmed_per_user
  ON public.risk_capital_allocations (user_id)
  WHERE status = 'confirmed';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.risk_capital_allocations TO authenticated;
GRANT ALL ON public.risk_capital_allocations TO service_role;
ALTER TABLE public.risk_capital_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_capital_own_select" ON public.risk_capital_allocations;
DROP POLICY IF EXISTS "risk_capital_own_insert" ON public.risk_capital_allocations;
DROP POLICY IF EXISTS "risk_capital_own_update" ON public.risk_capital_allocations;
DROP POLICY IF EXISTS "risk_capital_own_delete" ON public.risk_capital_allocations;
CREATE POLICY "risk_capital_own_select" ON public.risk_capital_allocations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "risk_capital_own_insert" ON public.risk_capital_allocations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "risk_capital_own_update" ON public.risk_capital_allocations FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "risk_capital_own_delete" ON public.risk_capital_allocations FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_risk_capital_allocations_updated_at ON public.risk_capital_allocations;
CREATE TRIGGER update_risk_capital_allocations_updated_at BEFORE UPDATE ON public.risk_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- New profiles default to $0 risk capital. Existing rows are untouched.
ALTER TABLE public.profiles ALTER COLUMN active_wallet_usd SET DEFAULT 0;

-- Legacy backfill: one unconfirmed row per existing profile with positive legacy value.
-- Idempotent: skip if a legacy_profile row already exists for that user.
INSERT INTO public.risk_capital_allocations (user_id, amount, currency, source, status)
SELECT p.id, p.active_wallet_usd, 'USD', 'legacy_profile', 'unconfirmed'
  FROM public.profiles p
 WHERE p.active_wallet_usd > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.risk_capital_allocations r
      WHERE r.user_id = p.id AND r.source = 'legacy_profile'
   );

-- SECURITY NOTE:
-- Unconfirmed/revoked allocations MUST NOT size or authorize orders.
-- Revoking a confirmed allocation prevents NEW order sizing and never touches
-- existing exchange positions. Life Map money NEVER automatically becomes Risk Capital.

------------------------------------------------------------------
-- Helper functions
------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirmed_risk_capital(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(amount), 0)::numeric
    FROM public.risk_capital_allocations
   WHERE user_id = p_user_id AND status = 'confirmed'
$$;

REVOKE ALL ON FUNCTION public.confirmed_risk_capital(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.my_confirmed_risk_capital()
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN 0;
  END IF;
  RETURN public.confirmed_risk_capital(uid);
END;
$$;

REVOKE ALL ON FUNCTION public.my_confirmed_risk_capital() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_confirmed_risk_capital() TO authenticated;
