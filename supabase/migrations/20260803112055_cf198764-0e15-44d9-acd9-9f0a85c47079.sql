CREATE OR REPLACE FUNCTION public.trading_communities_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _privileged boolean;
BEGIN
  _privileged := public.has_role(auth.uid(), 'admin')
                 OR coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
                 OR coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '') = 'service_role'
                 OR current_user IN ('service_role','postgres','supabase_admin');
  IF TG_OP = 'INSERT' THEN
    IF NOT _privileged THEN
      NEW.status := 'applied';
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.seat_limit := 0;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT _privileged THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
       OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
       OR NEW.leader_user_id IS DISTINCT FROM OLD.leader_user_id
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'COMMUNITY_ADMIN_ONLY_FIELD';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;