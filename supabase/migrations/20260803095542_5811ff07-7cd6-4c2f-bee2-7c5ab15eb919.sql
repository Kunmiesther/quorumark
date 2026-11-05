-- =====================================================================
-- 1. PAPER-FIRST: canonical, idempotent paper readiness for every client
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ensure_paper_ready(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _user_id IS NULL THEN RETURN; END IF;

  -- Canonical active-state source for paper. 'legacy' = active engine mode.
  INSERT INTO public.paper_engine_authority (user_id, mode, notes)
  VALUES (_user_id, 'legacy', 'auto-provisioned: paper-first client flow')
  ON CONFLICT (user_id) DO NOTHING;

  -- Paper account + wallets. Idempotent by construction.
  PERFORM public.ensure_paper_wallets(_user_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_paper_ready(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_paper_ready(uuid) TO service_role;

-- Self-service: a signed-in client can only ever provision THEMSELVES.
CREATE OR REPLACE FUNCTION public.my_ensure_paper_ready()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  PERFORM public.ensure_paper_ready(auth.uid());
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_ensure_paper_ready() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_ensure_paper_ready() TO service_role;

-- New clients: provisioned the moment onboarding completes.
CREATE OR REPLACE FUNCTION public.profiles_paper_ready_on_onboarding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.onboarding_complete_v2, false)
     AND COALESCE(OLD.onboarding_complete_v2, false) IS DISTINCT FROM true THEN
    PERFORM public.ensure_paper_ready(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_paper_ready_on_onboarding ON public.profiles;
CREATE TRIGGER profiles_paper_ready_on_onboarding
AFTER UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.profiles_paper_ready_on_onboarding();

-- Reconcile the contradictory state: the owner's row was left 'disabled'
-- while the engine kept running. 'legacy' is the truthful active mode.
UPDATE public.paper_engine_authority
   SET mode = 'legacy',
       notes = 're-enabled 2026-08-03: paper-first client flow'
 WHERE mode = 'disabled';

-- Backfill every already-onboarded account.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles WHERE COALESCE(onboarding_complete_v2, false) LOOP
    PERFORM public.ensure_paper_ready(r.id);
  END LOOP;
END;
$$;

-- =====================================================================
-- 2. LIVE TRADING IS OWNER-ONLY — enforced at the database boundary
-- =====================================================================
CREATE OR REPLACE FUNCTION public.enforce_owner_only_live()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.mode = 'live' AND NOT public.has_role(NEW.user_id, 'admin') THEN
    RAISE EXCEPTION 'LIVE_TRADING_OWNER_ONLY: live strategy configuration is restricted to the owner account'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_strategy_owner_only_live ON public.user_strategy;
CREATE TRIGGER user_strategy_owner_only_live
BEFORE INSERT OR UPDATE ON public.user_strategy
FOR EACH ROW EXECUTE FUNCTION public.enforce_owner_only_live();

CREATE OR REPLACE FUNCTION public.enforce_owner_only_order_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(NEW.user_id, 'admin') THEN
    RAISE EXCEPTION 'LIVE_TRADING_OWNER_ONLY: real-money order intents are restricted to the owner account'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_intents_owner_only ON public.order_intents;
CREATE TRIGGER order_intents_owner_only
BEFORE INSERT ON public.order_intents
FOR EACH ROW EXECUTE FUNCTION public.enforce_owner_only_order_intent();

-- Revoke eligibility for any non-owner live row. History and credentials kept.
UPDATE public.user_strategy us
   SET enabled = false
 WHERE us.mode = 'live'
   AND NOT public.has_role(us.user_id, 'admin');