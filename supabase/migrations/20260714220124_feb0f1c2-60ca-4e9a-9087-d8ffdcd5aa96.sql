
-- 1) milestone_definitions (global catalog)
CREATE TABLE IF NOT EXISTS public.milestone_definitions (
  code text PRIMARY KEY,
  label text NOT NULL,
  description text,
  points int NOT NULL CHECK (points >= 0),
  is_repeatable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.milestone_definitions TO authenticated;
GRANT ALL ON public.milestone_definitions TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.milestone_definitions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.milestone_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS milestone_definitions_read ON public.milestone_definitions;
CREATE POLICY milestone_definitions_read ON public.milestone_definitions
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.milestone_definitions (code, label, description, points, is_repeatable) VALUES
  ('obligation_created',      'Organizer',          'Added a bill or obligation',           5,  true),
  ('obligation_funded',       'Funded Ahead',       'Fully funded an obligation ahead',    10,  true),
  ('obligation_paid',         'Paid On Time',       'Marked an obligation paid',           15,  true),
  ('overdue_cleared',         'Back On Track',      'Cleared an overdue obligation',       20,  true),
  ('category_month_complete', 'Category Complete',  'Completed a category for the month',  50,  true),
  ('streak_month',            'Steady Month',       'Maintained a full-month streak',      25,  true)
ON CONFLICT (code) DO NOTHING;

-- 2) point_awards (immutable ledger)
CREATE TABLE IF NOT EXISTS public.point_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone_code text NOT NULL REFERENCES public.milestone_definitions(code) ON DELETE RESTRICT,
  points int NOT NULL CHECK (points >= 0),
  idempotency_key text NOT NULL,
  source_history_id uuid NULL REFERENCES public.life_obligation_history(id) ON DELETE SET NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS point_awards_user_idx ON public.point_awards (user_id);
GRANT SELECT ON public.point_awards TO authenticated;
GRANT ALL ON public.point_awards TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.point_awards FROM authenticated;
ALTER TABLE public.point_awards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS point_awards_own_select ON public.point_awards;
CREATE POLICY point_awards_own_select ON public.point_awards
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
COMMENT ON TABLE public.point_awards IS
  'Immutable points ledger. Points have NO cash value, never imply investment returns, and MUST NOT influence Risk Capital, leverage, order size, or execution. Written only by award_points_from_history() trigger on life_obligation_history (which is itself trigger-only).';

-- 3) user_turtle_progress (cosmetic only)
CREATE TABLE IF NOT EXISTS public.user_turtle_progress (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES public.strategies(id) ON DELETE RESTRICT,
  level int NOT NULL DEFAULT 1 CHECK (level >= 1),
  unlocked_cosmetics jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy_id)
);
GRANT SELECT ON public.user_turtle_progress TO authenticated;
GRANT ALL ON public.user_turtle_progress TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.user_turtle_progress FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.user_turtle_progress FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_turtle_progress FROM authenticated;
ALTER TABLE public.user_turtle_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_turtle_progress_own_select ON public.user_turtle_progress;
CREATE POLICY user_turtle_progress_own_select ON public.user_turtle_progress
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
COMMENT ON TABLE public.user_turtle_progress IS
  'Cosmetic progression only — unlocks suits/effects/badges/themes. Never gates Life Map access and never affects trading (order size, leverage, risk capital, execution).';

-- 4) award trigger — only writer of point_awards
CREATE OR REPLACE FUNCTION public.award_points_from_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_code text;
  v_key  text;
BEGIN
  v_code := CASE NEW.event
    WHEN 'created' THEN 'obligation_created'
    WHEN 'funded'  THEN 'obligation_funded'
    WHEN 'paid'    THEN 'obligation_paid'
    ELSE NULL
  END;
  IF v_code IS NULL THEN
    RETURN NEW;
  END IF;

  v_key := NEW.user_id::text || ':' || v_code || ':' || NEW.obligation_id::text
        || ':' || to_char(NEW.occurred_at, 'YYYY-MM');

  INSERT INTO public.point_awards (user_id, milestone_code, points, idempotency_key, source_history_id)
  SELECT NEW.user_id, md.code, md.points, v_key, NEW.id
    FROM public.milestone_definitions md
   WHERE md.code = v_code
  ON CONFLICT (user_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS award_points_from_history_trg ON public.life_obligation_history;
CREATE TRIGGER award_points_from_history_trg
AFTER INSERT ON public.life_obligation_history
FOR EACH ROW EXECUTE FUNCTION public.award_points_from_history();

-- 5) read RPCs (user-scoped, auth.uid() only)
CREATE OR REPLACE FUNCTION public.my_points_total()
RETURNS int
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN 0;
  END IF;
  RETURN COALESCE((SELECT sum(points)::int FROM public.point_awards WHERE user_id = uid), 0);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.my_points_total() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_points_total() TO authenticated;

CREATE OR REPLACE FUNCTION public.my_point_awards(p_limit int DEFAULT 50)
RETURNS SETOF public.point_awards
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT * FROM public.point_awards
     WHERE user_id = uid
     ORDER BY awarded_at DESC
     LIMIT GREATEST(COALESCE(p_limit, 50), 0);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.my_point_awards(int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_point_awards(int) TO authenticated;

-- 6) reaffirm essentials are never tier/points-gated
COMMENT ON TABLE public.life_categories IS
  'Life Map categories. Essential Life Map functionality (categories, obligations, history) MUST remain reachable regardless of subscription tier, points, or turtle level. Do NOT add tier/points/level checks to policies on this table or on life_obligations / life_obligation_history.';
