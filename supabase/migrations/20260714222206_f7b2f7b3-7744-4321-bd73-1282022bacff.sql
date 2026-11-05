
-- =====================================================================
-- P4-CLEANUP: anti-farming for Points + Turtle progression
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. life_obligations: series identity, soft-delete, paid tracking
-- ---------------------------------------------------------------------
ALTER TABLE public.life_obligations
  ADD COLUMN IF NOT EXISTS series_id uuid,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS billing_period text NULL;

-- Backfill any NULL series_id (currently zero rows, but keep it safe/idempotent)
UPDATE public.life_obligations SET series_id = gen_random_uuid() WHERE series_id IS NULL;

ALTER TABLE public.life_obligations
  ALTER COLUMN series_id SET NOT NULL,
  ALTER COLUMN series_id SET DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS life_obligations_user_series_idx
  ON public.life_obligations (user_id, series_id);

COMMENT ON COLUMN public.life_obligations.series_id IS
  'Immutable award identity. Recurring monthly periods MUST share the same series_id. '
  'Deleting and recreating an obligation cannot mint new points — reuse the series_id or use archived_at.';
COMMENT ON COLUMN public.life_obligations.archived_at IS
  'Soft delete. Archived obligations earn no points and are ignored by award eligibility.';

-- Immutable series_id trigger
CREATE OR REPLACE FUNCTION public.life_obligations_series_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.series_id IS DISTINCT FROM OLD.series_id THEN
    RAISE EXCEPTION 'series_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS life_obligations_series_immutable_trg ON public.life_obligations;
CREATE TRIGGER life_obligations_series_immutable_trg
  BEFORE UPDATE ON public.life_obligations
  FOR EACH ROW EXECUTE FUNCTION public.life_obligations_series_immutable();

-- Auto-derive billing_period from due_date
CREATE OR REPLACE FUNCTION public.life_obligations_set_billing_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.due_date IS NOT NULL THEN
    NEW.billing_period := to_char(NEW.due_date, 'YYYY-MM');
  ELSIF NEW.billing_period IS NULL THEN
    NEW.billing_period := to_char(current_date, 'YYYY-MM');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS life_obligations_set_billing_period_trg ON public.life_obligations;
CREATE TRIGGER life_obligations_set_billing_period_trg
  BEFORE INSERT OR UPDATE ON public.life_obligations
  FOR EACH ROW EXECUTE FUNCTION public.life_obligations_set_billing_period();

-- ---------------------------------------------------------------------
-- 2. life_obligation_history: enrichment columns (append-only, 0 rows)
-- ---------------------------------------------------------------------
ALTER TABLE public.life_obligation_history
  ADD COLUMN IF NOT EXISTS old_status text NULL,
  ADD COLUMN IF NOT EXISTS new_status text NULL,
  ADD COLUMN IF NOT EXISTS series_id uuid NULL,
  ADD COLUMN IF NOT EXISTS billing_period text NULL,
  ADD COLUMN IF NOT EXISTS category_id uuid NULL;

CREATE OR REPLACE FUNCTION public.life_obligations_write_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
  v_user  uuid;
  v_oid   uuid;
  v_amt   numeric;
  v_old   text;
  v_new   text;
  v_series uuid;
  v_period text;
  v_cat    uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event  := 'created';
    v_user   := NEW.user_id;
    v_oid    := NEW.id;
    v_amt    := NEW.amount;
    v_old    := NULL;
    v_new    := NEW.status;
    v_series := NEW.series_id;
    v_period := NEW.billing_period;
    v_cat    := NEW.category_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_event  := 'deleted';
    v_user   := OLD.user_id;
    v_oid    := OLD.id;
    v_amt    := OLD.amount;
    v_old    := OLD.status;
    v_new    := NULL;
    v_series := OLD.series_id;
    v_period := OLD.billing_period;
    v_cat    := OLD.category_id;
  ELSE
    v_user   := NEW.user_id;
    v_oid    := NEW.id;
    v_amt    := NEW.amount;
    v_old    := OLD.status;
    v_new    := NEW.status;
    v_series := NEW.series_id;
    v_period := NEW.billing_period;
    v_cat    := NEW.category_id;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('paid','funded','overdue') THEN
      v_event := NEW.status;
    ELSE
      v_event := 'updated';
    END IF;
  END IF;

  INSERT INTO public.life_obligation_history
    (user_id, obligation_id, event, amount, old_status, new_status, series_id, billing_period, category_id)
  VALUES
    (v_user, v_oid, v_event, v_amt, v_old, v_new, v_series, v_period, v_cat);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Milestone catalog: remove farmable, add scoped controlled milestones
-- ---------------------------------------------------------------------
-- Verified 0 awards reference the removed codes; safe to delete.
DELETE FROM public.milestone_definitions WHERE code IN ('obligation_created','obligation_paid');

ALTER TABLE public.milestone_definitions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'series_period';

ALTER TABLE public.milestone_definitions
  DROP CONSTRAINT IF EXISTS milestone_definitions_scope_check;
ALTER TABLE public.milestone_definitions
  ADD CONSTRAINT milestone_definitions_scope_check
  CHECK (scope IN ('once_per_user','once_per_user_category','series_period'));

INSERT INTO public.milestone_definitions (code, label, description, points, is_repeatable, scope) VALUES
  ('first_obligation',        'Life Started',       'First obligation created',                  25,  false, 'once_per_user'),
  ('first_roof_setup',        'Roof Secured',       'First Roof obligation set up',              50,  false, 'once_per_user'),
  ('first_ride_setup',        'Ride Secured',       'First Ride obligation set up',              50,  false, 'once_per_user'),
  ('first_category_setup',    'Category Set Up',    'First obligation in a category',            20,  false, 'once_per_user_category'),
  ('lifemap_complete',        'Life Map Complete',  'All 8 canonical categories have obligations', 100, false, 'once_per_user'),
  ('obligation_paid_on_time', 'Paid On Time',       'Obligation paid on or before due date',     15,  true,  'series_period'),
  ('obligation_funded',       'Funded Ahead',       'Obligation fully funded before due date',   10,  true,  'series_period'),
  ('overdue_cleared',         'Back On Track',      'Overdue obligation cleared',                20,  true,  'series_period')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  points = EXCLUDED.points,
  is_repeatable = EXCLUDED.is_repeatable,
  scope = EXCLUDED.scope;

-- Ensure existing kept milestones are series_period scoped
UPDATE public.milestone_definitions SET scope='series_period'
 WHERE code IN ('category_month_complete','streak_month');

-- ---------------------------------------------------------------------
-- 4. point_awards: append-only ledger + adjustments + enrichment
-- ---------------------------------------------------------------------
ALTER TABLE public.point_awards
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'award',
  ADD COLUMN IF NOT EXISTS category_id uuid NULL,
  ADD COLUMN IF NOT EXISTS billing_period text NULL;

ALTER TABLE public.point_awards
  DROP CONSTRAINT IF EXISTS point_awards_entry_type_check;
ALTER TABLE public.point_awards
  ADD CONSTRAINT point_awards_entry_type_check
  CHECK (entry_type IN ('award','adjustment'));

-- Replace non-negative check with entry-type-aware version
ALTER TABLE public.point_awards
  DROP CONSTRAINT IF EXISTS point_awards_points_check;
ALTER TABLE public.point_awards
  DROP CONSTRAINT IF EXISTS point_awards_points_nonneg;
ALTER TABLE public.point_awards
  ADD CONSTRAINT point_awards_points_signed_check
  CHECK ((entry_type = 'award' AND points >= 0) OR entry_type = 'adjustment');

-- Re-assert append-only grants (defense in depth)
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM authenticated;
GRANT SELECT ON public.point_awards TO authenticated;
GRANT ALL ON public.point_awards TO service_role;

COMMENT ON TABLE public.point_awards IS
  'Append-only ledger. Corrections MUST be new rows with entry_type=''adjustment'' (may be negative). '
  'Never UPDATE/DELETE. Points have NO cash value and never affect Risk Capital, leverage, position size, or trading access.';

-- ---------------------------------------------------------------------
-- 5. Award trigger: strict anti-farming eligibility
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.award_points_from_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_obl        public.life_obligations%ROWTYPE;
  v_now_period text := to_char(now(), 'YYYY-MM');
  v_cat_key    text;
  v_period     text;
  v_series     uuid;
  v_cat        uuid;

  -- helper inline award blocks below reference these
  v_key      text;
  v_points   int;
  v_ceiling_used int;
BEGIN
  -- Load underlying obligation (may be gone on DELETE — then skip)
  SELECT * INTO v_obl FROM public.life_obligations WHERE id = NEW.obligation_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Gate: archived
  IF v_obl.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Gate: real economic content
  IF NOT (COALESCE(v_obl.amount, 0) > 0 OR COALESCE(v_obl.monthly_funding_target, 0) > 0) THEN
    RETURN NEW;
  END IF;

  v_series := COALESCE(NEW.series_id, v_obl.series_id);
  v_period := COALESCE(NEW.billing_period, v_obl.billing_period);
  v_cat    := COALESCE(NEW.category_id, v_obl.category_id);

  SELECT key INTO v_cat_key FROM public.life_categories WHERE id = v_cat;

  -- Reusable insert with per-category monthly 200-point ceiling.
  --   award_key_type: 'once_per_user' | 'once_per_user_category' | 'series_period'
  -- Implemented as an anonymous PERFORM block per milestone below.

  -- ---- event: created ----
  IF NEW.event = 'created' THEN
    -- first_obligation (once_per_user, 25)
    v_key := NEW.user_id::text || ':first_obligation';
    SELECT points INTO v_points FROM public.milestone_definitions WHERE code='first_obligation';
    IF v_points IS NOT NULL THEN
      SELECT COALESCE(sum(points),0) INTO v_ceiling_used
        FROM public.point_awards
       WHERE user_id = NEW.user_id AND category_id = v_cat
         AND billing_period = v_period AND entry_type='award';
      IF v_ceiling_used + v_points <= 200 THEN
        INSERT INTO public.point_awards
          (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
        VALUES (NEW.user_id, 'first_obligation', v_points, v_key, NEW.id, v_cat, v_period, 'award')
        ON CONFLICT (user_id, idempotency_key) DO NOTHING;
      END IF;
    END IF;

    -- first_category_setup (once_per_user_category, 20)
    IF v_cat IS NOT NULL THEN
      v_key := NEW.user_id::text || ':first_category_setup:' || v_cat::text;
      SELECT points INTO v_points FROM public.milestone_definitions WHERE code='first_category_setup';
      IF v_points IS NOT NULL THEN
        SELECT COALESCE(sum(points),0) INTO v_ceiling_used
          FROM public.point_awards
         WHERE user_id = NEW.user_id AND category_id = v_cat
           AND billing_period = v_period AND entry_type='award';
        IF v_ceiling_used + v_points <= 200 THEN
          INSERT INTO public.point_awards
            (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
          VALUES (NEW.user_id, 'first_category_setup', v_points, v_key, NEW.id, v_cat, v_period, 'award')
          ON CONFLICT (user_id, idempotency_key) DO NOTHING;
        END IF;
      END IF;
    END IF;

    -- first_roof_setup / first_ride_setup (once_per_user, 50)
    -- Require at least one non-archived obligation in that category with amount>0 (the current one qualifies).
    IF v_cat_key IN ('roof','ride') THEN
      DECLARE v_code text := 'first_' || v_cat_key || '_setup';
      BEGIN
        v_key := NEW.user_id::text || ':' || v_code;
        SELECT points INTO v_points FROM public.milestone_definitions WHERE code = v_code;
        IF v_points IS NOT NULL THEN
          IF EXISTS (
            SELECT 1 FROM public.life_obligations
             WHERE user_id = NEW.user_id AND category_id = v_cat
               AND archived_at IS NULL AND amount > 0
          ) THEN
            SELECT COALESCE(sum(points),0) INTO v_ceiling_used
              FROM public.point_awards
             WHERE user_id = NEW.user_id AND category_id = v_cat
               AND billing_period = v_period AND entry_type='award';
            IF v_ceiling_used + v_points <= 200 THEN
              INSERT INTO public.point_awards
                (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
              VALUES (NEW.user_id, v_code, v_points, v_key, NEW.id, v_cat, v_period, 'award')
              ON CONFLICT (user_id, idempotency_key) DO NOTHING;
            END IF;
          END IF;
        END IF;
      END;
    END IF;

  -- ---- event: funded ----
  ELSIF NEW.event = 'funded'
        AND NEW.new_status = 'funded'
        AND NEW.old_status IS DISTINCT FROM 'funded'
        AND v_series IS NOT NULL AND v_period IS NOT NULL THEN
    v_key := NEW.user_id::text || ':' || v_series::text || ':' || v_period || ':obligation_funded';
    SELECT points INTO v_points FROM public.milestone_definitions WHERE code='obligation_funded';
    IF v_points IS NOT NULL THEN
      SELECT COALESCE(sum(points),0) INTO v_ceiling_used
        FROM public.point_awards
       WHERE user_id = NEW.user_id AND category_id = v_cat
         AND billing_period = v_period AND entry_type='award';
      IF v_ceiling_used + v_points <= 200 THEN
        INSERT INTO public.point_awards
          (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
        VALUES (NEW.user_id, 'obligation_funded', v_points, v_key, NEW.id, v_cat, v_period, 'award')
        ON CONFLICT (user_id, idempotency_key) DO NOTHING;
      END IF;
    END IF;

  -- ---- event: paid ----
  ELSIF NEW.event = 'paid' AND v_series IS NOT NULL AND v_period IS NOT NULL THEN
    IF NEW.old_status = 'overdue' THEN
      v_key := NEW.user_id::text || ':' || v_series::text || ':' || v_period || ':overdue_cleared';
      SELECT points INTO v_points FROM public.milestone_definitions WHERE code='overdue_cleared';
      IF v_points IS NOT NULL THEN
        SELECT COALESCE(sum(points),0) INTO v_ceiling_used
          FROM public.point_awards
         WHERE user_id = NEW.user_id AND category_id = v_cat
           AND billing_period = v_period AND entry_type='award';
        IF v_ceiling_used + v_points <= 200 THEN
          INSERT INTO public.point_awards
            (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
          VALUES (NEW.user_id, 'overdue_cleared', v_points, v_key, NEW.id, v_cat, v_period, 'award')
          ON CONFLICT (user_id, idempotency_key) DO NOTHING;
        END IF;
      END IF;
    ELSE
      IF v_obl.paid_at IS NOT NULL
         AND v_obl.due_date IS NOT NULL
         AND v_obl.paid_at::date <= v_obl.due_date
         AND v_period <= v_now_period THEN
        v_key := NEW.user_id::text || ':' || v_series::text || ':' || v_period || ':obligation_paid_on_time';
        SELECT points INTO v_points FROM public.milestone_definitions WHERE code='obligation_paid_on_time';
        IF v_points IS NOT NULL THEN
          SELECT COALESCE(sum(points),0) INTO v_ceiling_used
            FROM public.point_awards
           WHERE user_id = NEW.user_id AND category_id = v_cat
             AND billing_period = v_period AND entry_type='award';
          IF v_ceiling_used + v_points <= 200 THEN
            INSERT INTO public.point_awards
              (user_id, milestone_code, points, idempotency_key, source_history_id, category_id, billing_period, entry_type)
            VALUES (NEW.user_id, 'obligation_paid_on_time', v_points, v_key, NEW.id, v_cat, v_period, 'award')
            ON CONFLICT (user_id, idempotency_key) DO NOTHING;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. my_points_total(): SUM the whole ledger (awards + adjustments)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_points_total()
RETURNS integer
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN 0;
  END IF;
  RETURN COALESCE(
    (SELECT sum(points)::int FROM public.point_awards WHERE user_id = uid),
    0
  );
END;
$$;
