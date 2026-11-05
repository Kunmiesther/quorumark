
-- FIX 1: repair handle_new_user (remove user_strategy insert, seed 8 canonical categories)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  -- Seed 8 canonical Life Map categories (idempotent; leaves is_custom=true rows untouched)
  INSERT INTO public.life_categories (user_id, key, label, icon, is_custom, is_essential, sort_order) VALUES
    (NEW.id, 'roof',     'Roof',     'home',        false, true,  1),
    (NEW.id, 'ride',     'Ride',     'car',         false, true,  2),
    (NEW.id, 'memories', 'Memories', 'camera',      false, false, 3),
    (NEW.id, 'escape',   'Escape',   'plane',       false, false, 4),
    (NEW.id, 'body',     'Body',     'heart',       false, true,  5),
    (NEW.id, 'family',   'Family',   'users',       false, false, 6),
    (NEW.id, 'debt',     'Debt',     'credit-card', false, true,  7),
    (NEW.id, 'future',   'Future',   'sparkles',    false, false, 8)
  ON CONFLICT (user_id, key) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- FIX 2: per-connection strategy seed trigger
CREATE OR REPLACE FUNCTION public.seed_user_strategy_for_connection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  default_strategy_id uuid;
BEGIN
  SELECT id INTO default_strategy_id FROM public.strategies WHERE slug = 'dca' LIMIT 1;
  IF default_strategy_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_strategy
    (user_id, connection_id, strategy_id, market_type, cross_margin, enabled, mode, params, hedge_guard)
  VALUES
    (NEW.user_id, NEW.id, default_strategy_id, 'spot', false, false, 'paper', '{}'::jsonb, '{}'::jsonb)
  ON CONFLICT (user_id, connection_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS seed_user_strategy_on_connection ON public.exchange_connections;
CREATE TRIGGER seed_user_strategy_on_connection
AFTER INSERT ON public.exchange_connections
FOR EACH ROW EXECUTE FUNCTION public.seed_user_strategy_for_connection();

-- FIX 3: life_obligation_history append-only, trigger-only writes
DROP POLICY IF EXISTS life_obligation_history_own_insert ON public.life_obligation_history;

REVOKE INSERT, UPDATE, DELETE ON public.life_obligation_history FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.life_obligation_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.life_obligation_history FROM authenticated;
GRANT SELECT ON public.life_obligation_history TO authenticated;
GRANT INSERT ON public.life_obligation_history TO service_role;
GRANT ALL ON public.life_obligation_history TO service_role;

CREATE OR REPLACE FUNCTION public.life_obligations_write_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_event text;
  v_user  uuid;
  v_oid   uuid;
  v_amt   numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'created';
    v_user  := NEW.user_id;
    v_oid   := NEW.id;
    v_amt   := NEW.amount;
  ELSIF TG_OP = 'DELETE' THEN
    v_event := 'deleted';
    v_user  := OLD.user_id;
    v_oid   := OLD.id;
    v_amt   := OLD.amount;
  ELSE
    v_user := NEW.user_id;
    v_oid  := NEW.id;
    v_amt  := NEW.amount;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('paid','funded','overdue') THEN
      v_event := NEW.status;
    ELSE
      v_event := 'updated';
    END IF;
  END IF;

  INSERT INTO public.life_obligation_history (user_id, obligation_id, event, amount)
  VALUES (v_user, v_oid, v_event, v_amt);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS life_obligations_history_trg ON public.life_obligations;
CREATE TRIGGER life_obligations_history_trg
AFTER INSERT OR UPDATE OR DELETE ON public.life_obligations
FOR EACH ROW EXECUTE FUNCTION public.life_obligations_write_history();

-- FIX 4: disconnected/disabled connections yield $0 and are excluded from summary
CREATE OR REPLACE FUNCTION public.confirmed_risk_capital(p_user_id uuid, p_connection_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL OR p_connection_id IS NULL THEN 0::numeric
    WHEN NOT EXISTS (
      SELECT 1 FROM public.exchange_connections
       WHERE id = p_connection_id
         AND user_id = p_user_id
         AND status NOT IN ('disconnected','disabled')
    ) THEN 0::numeric
    ELSE COALESCE((
      SELECT sum(amount)
        FROM public.risk_capital_allocations
       WHERE user_id = p_user_id
         AND connection_id = p_connection_id
         AND status = 'confirmed'
    ), 0)::numeric
  END;
$function$;

CREATE OR REPLACE FUNCTION public.my_risk_capital_summary()
RETURNS TABLE(connection_id uuid, allocated numeric, status text)
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
    SELECT ec.id AS connection_id,
           COALESCE(SUM(rca.amount) FILTER (WHERE rca.status = 'confirmed'), 0)::numeric AS allocated,
           CASE
             WHEN bool_or(rca.status = 'confirmed') THEN 'confirmed'
             WHEN bool_or(rca.status IS NOT NULL)   THEN 'unconfirmed'
             ELSE 'none'
           END::text AS status
      FROM public.exchange_connections ec
      LEFT JOIN public.risk_capital_allocations rca
        ON rca.connection_id = ec.id AND rca.user_id = uid
     WHERE ec.user_id = uid
       AND ec.status NOT IN ('disconnected','disabled')
     GROUP BY ec.id;
END;
$function$;

-- FIX 5: one ACTIVE allocation (pending or confirmed) per connection
DROP INDEX IF EXISTS public.risk_capital_allocations_one_confirmed_per_connection;
CREATE UNIQUE INDEX risk_capital_allocations_one_active_per_connection
  ON public.risk_capital_allocations (user_id, connection_id)
  WHERE status IN ('unconfirmed','confirmed');

-- FIX 6: documentation of legacy backfill decision
COMMENT ON TABLE public.risk_capital_allocations IS
  'Per-connection risk capital allocations. The legacy $500 row (source=''legacy_profile'', status=''unconfirmed'') was attached to ApeX Omni connection cc3c84a5-098d-4b48-909e-6126bdacd879 by EXPLICIT USER APPROVAL of the per-connection capital policy (not merely oldest-row heuristic). It remains UNCONFIRMED and cannot size or authorize orders until the user explicitly confirms it.';
