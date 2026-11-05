-- ============ ENUMS ============
DO $$ BEGIN CREATE TYPE public.community_status AS ENUM ('applied','approved','suspended','revoked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.community_member_role AS ENUM ('member','leader'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.community_member_status AS ENUM ('active','suspended','removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.entitlement_source AS ENUM ('grandfathered','invitation','admin_grant'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.commission_kind AS ENUM ('fixed_amount','percent_of_revenue'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ TABLES ============
CREATE TABLE IF NOT EXISTS public.trading_communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  logo_url text,
  status public.community_status NOT NULL DEFAULT 'applied',
  plan_key text NOT NULL DEFAULT 'free_paper_trial',
  seat_limit integer NOT NULL DEFAULT 0 CHECK (seat_limit >= 0),
  leader_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  applicant_email text NOT NULL,
  applicant_note text,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.community_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.community_member_role NOT NULL DEFAULT 'member',
  status public.community_member_status NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.community_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email text,
  plan_key text NOT NULL DEFAULT 'free_paper_trial',
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_invitations_uses_within_max CHECK (uses <= max_uses)
);
CREATE INDEX IF NOT EXISTS community_invitations_community_idx ON public.community_invitations(community_id);

CREATE TABLE IF NOT EXISTS public.invitation_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES public.community_invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.community_commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  kind public.commission_kind NOT NULL,
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  percent_bps integer CHECK (percent_bps IS NULL OR (percent_bps >= 0 AND percent_bps <= 10000)),
  active boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rule_shape CHECK (
    (kind = 'fixed_amount' AND amount_cents IS NOT NULL AND percent_bps IS NULL)
    OR (kind = 'percent_of_revenue' AND percent_bps IS NOT NULL AND amount_cents IS NULL)
  ),
  CONSTRAINT commission_rule_active_requires_approval CHECK (active = false OR approved_by IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.community_commission_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.community_commission_rules(id) ON DELETE SET NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  source text NOT NULL DEFAULT 'pending_provider',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.access_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_key text NOT NULL,
  source public.entitlement_source NOT NULL,
  community_id uuid REFERENCES public.trading_communities(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, plan_key)
);

CREATE TABLE IF NOT EXISTS public.community_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid REFERENCES public.trading_communities(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_audit_events_community_idx ON public.community_audit_events(community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.user_strategy_market_type_backfill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  symbol text NOT NULL,
  mode text NOT NULL,
  previous_market_type text NOT NULL,
  new_market_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, connection_id, symbol)
);

-- ============ GRANTS ============
GRANT SELECT, INSERT ON public.trading_communities TO anon;
GRANT SELECT, INSERT, UPDATE ON public.trading_communities TO authenticated;
GRANT ALL ON public.trading_communities TO service_role;
GRANT SELECT ON public.community_memberships TO authenticated;
GRANT ALL ON public.community_memberships TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.community_invitations TO authenticated;
GRANT ALL ON public.community_invitations TO service_role;
GRANT SELECT ON public.invitation_redemptions TO authenticated;
GRANT ALL ON public.invitation_redemptions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.community_commission_rules TO authenticated;
GRANT ALL ON public.community_commission_rules TO service_role;
GRANT SELECT ON public.community_commission_ledger TO authenticated;
GRANT ALL ON public.community_commission_ledger TO service_role;
GRANT SELECT ON public.access_entitlements TO authenticated;
GRANT ALL ON public.access_entitlements TO service_role;
GRANT SELECT ON public.community_audit_events TO authenticated;
GRANT ALL ON public.community_audit_events TO service_role;
GRANT SELECT ON public.user_strategy_market_type_backfill TO authenticated;
GRANT ALL ON public.user_strategy_market_type_backfill TO service_role;

-- ============ HELPERS ============
CREATE OR REPLACE FUNCTION public.is_community_leader(_community_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.trading_communities c
    WHERE c.id = _community_id AND c.leader_user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.community_memberships m
    WHERE m.community_id = _community_id AND m.user_id = auth.uid()
      AND m.role = 'leader' AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_community_member(_community_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_memberships m
    WHERE m.community_id = _community_id AND m.user_id = auth.uid() AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.community_seats_used(_community_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.community_memberships m
  WHERE m.community_id = _community_id AND m.status = 'active';
$$;

-- Applications always start as 'applied'; only admins may change status/seats/plan.
CREATE OR REPLACE FUNCTION public.trading_communities_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      NEW.status := 'applied';
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.seat_limit := 0;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT public.has_role(auth.uid(), 'admin') THEN
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
DROP TRIGGER IF EXISTS trading_communities_guard_trg ON public.trading_communities;
CREATE TRIGGER trading_communities_guard_trg BEFORE INSERT OR UPDATE ON public.trading_communities
FOR EACH ROW EXECUTE FUNCTION public.trading_communities_guard();

CREATE OR REPLACE FUNCTION public.commission_rules_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.active := false; NEW.approved_by := NULL; NEW.approved_at := NULL;
    ELSE
      IF NEW.active IS DISTINCT FROM OLD.active
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION 'COMMISSION_APPROVAL_ADMIN_ONLY';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_rules_guard_trg ON public.community_commission_rules;
CREATE TRIGGER commission_rules_guard_trg BEFORE INSERT OR UPDATE ON public.community_commission_rules
FOR EACH ROW EXECUTE FUNCTION public.commission_rules_guard();

CREATE OR REPLACE FUNCTION public.commission_ledger_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'COMMISSION_LEDGER_APPEND_ONLY'; END $$;
DROP TRIGGER IF EXISTS commission_ledger_append_only_trg ON public.community_commission_ledger;
CREATE TRIGGER commission_ledger_append_only_trg BEFORE UPDATE OR DELETE ON public.community_commission_ledger
FOR EACH ROW EXECUTE FUNCTION public.commission_ledger_append_only();

DROP TRIGGER IF EXISTS community_memberships_touch ON public.community_memberships;
CREATE TRIGGER community_memberships_touch BEFORE UPDATE ON public.community_memberships
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS community_invitations_touch ON public.community_invitations;
CREATE TRIGGER community_invitations_touch BEFORE UPDATE ON public.community_invitations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS access_entitlements_touch ON public.access_entitlements;
CREATE TRIGGER access_entitlements_touch BEFORE UPDATE ON public.access_entitlements
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ RLS ============
ALTER TABLE public.trading_communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_commission_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_strategy_market_type_backfill ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can apply for a community" ON public.trading_communities;
CREATE POLICY "Anyone can apply for a community" ON public.trading_communities
FOR INSERT TO anon, authenticated WITH CHECK (char_length(applicant_email) BETWEEN 3 AND 320);
DROP POLICY IF EXISTS "Admins manage communities" ON public.trading_communities;
CREATE POLICY "Admins manage communities" ON public.trading_communities
FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Leaders and members read their community" ON public.trading_communities;
CREATE POLICY "Leaders and members read their community" ON public.trading_communities
FOR SELECT TO authenticated USING (public.is_community_leader(id) OR public.is_community_member(id));
DROP POLICY IF EXISTS "Leaders update own community profile" ON public.trading_communities;
CREATE POLICY "Leaders update own community profile" ON public.trading_communities
FOR UPDATE TO authenticated USING (public.is_community_leader(id)) WITH CHECK (public.is_community_leader(id));

DROP POLICY IF EXISTS "Admins manage memberships" ON public.community_memberships;
CREATE POLICY "Admins manage memberships" ON public.community_memberships
FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Members read own membership" ON public.community_memberships;
CREATE POLICY "Members read own membership" ON public.community_memberships
FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_community_leader(community_id));

DROP POLICY IF EXISTS "Admins manage invitations" ON public.community_invitations;
CREATE POLICY "Admins manage invitations" ON public.community_invitations
FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Leaders read own invitations" ON public.community_invitations;
CREATE POLICY "Leaders read own invitations" ON public.community_invitations
FOR SELECT TO authenticated USING (public.is_community_leader(community_id));
DROP POLICY IF EXISTS "Leaders create invitations for own community" ON public.community_invitations;
CREATE POLICY "Leaders create invitations for own community" ON public.community_invitations
FOR INSERT TO authenticated WITH CHECK (
  public.is_community_leader(community_id)
  AND EXISTS (SELECT 1 FROM public.trading_communities c WHERE c.id = community_id AND c.status = 'approved')
);
DROP POLICY IF EXISTS "Leaders revoke own invitations" ON public.community_invitations;
CREATE POLICY "Leaders revoke own invitations" ON public.community_invitations
FOR UPDATE TO authenticated USING (public.is_community_leader(community_id)) WITH CHECK (public.is_community_leader(community_id));

DROP POLICY IF EXISTS "Admins read redemptions" ON public.invitation_redemptions;
CREATE POLICY "Admins read redemptions" ON public.invitation_redemptions
FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR user_id = auth.uid() OR public.is_community_leader(community_id));

DROP POLICY IF EXISTS "Admins manage commission rules" ON public.community_commission_rules;
CREATE POLICY "Admins manage commission rules" ON public.community_commission_rules
FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Leaders read own commission rules" ON public.community_commission_rules;
CREATE POLICY "Leaders read own commission rules" ON public.community_commission_rules
FOR SELECT TO authenticated USING (public.is_community_leader(community_id));

DROP POLICY IF EXISTS "Admins read commission ledger" ON public.community_commission_ledger;
CREATE POLICY "Admins read commission ledger" ON public.community_commission_ledger
FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.is_community_leader(community_id));

DROP POLICY IF EXISTS "Admins manage entitlements" ON public.access_entitlements;
CREATE POLICY "Admins manage entitlements" ON public.access_entitlements
FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Users read own entitlements" ON public.access_entitlements;
CREATE POLICY "Users read own entitlements" ON public.access_entitlements
FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins and leaders read audit events" ON public.community_audit_events;
CREATE POLICY "Admins and leaders read audit events" ON public.community_audit_events
FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.is_community_leader(community_id));
DROP POLICY IF EXISTS "Admins write audit events" ON public.community_audit_events;
CREATE POLICY "Admins write audit events" ON public.community_audit_events
FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));

DROP POLICY IF EXISTS "Admins read market type backfill" ON public.user_strategy_market_type_backfill;
CREATE POLICY "Admins read market type backfill" ON public.user_strategy_market_type_backfill
FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- ============ ATOMIC REDEMPTION ============
CREATE OR REPLACE FUNCTION public.redeem_community_invitation(_token_hash text, _email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _inv public.community_invitations%ROWTYPE;
  _com public.trading_communities%ROWTYPE;
  _seats int;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'NOT_AUTHENTICATED'); END IF;

  SELECT * INTO _inv FROM public.community_invitations WHERE token_hash = _token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_NOT_FOUND'); END IF;
  IF _inv.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_REVOKED'); END IF;
  IF _inv.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_EXPIRED'); END IF;
  IF _inv.email IS NOT NULL AND lower(coalesce(_email,'')) <> lower(_inv.email) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_EMAIL_MISMATCH');
  END IF;

  SELECT * INTO _com FROM public.trading_communities WHERE id = _inv.community_id FOR UPDATE;
  IF _com.status <> 'approved' THEN RETURN jsonb_build_object('ok', false, 'reason', 'COMMUNITY_NOT_ACTIVE'); END IF;

  IF EXISTS (SELECT 1 FROM public.invitation_redemptions r WHERE r.invitation_id = _inv.id AND r.user_id = _uid) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'ALREADY_REDEEMED', 'community_id', _com.id, 'plan_key', _inv.plan_key);
  END IF;

  IF _inv.uses >= _inv.max_uses THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVITE_EXHAUSTED'); END IF;

  SELECT count(*)::int INTO _seats FROM public.community_memberships m
    WHERE m.community_id = _com.id AND m.status = 'active';
  IF _seats >= _com.seat_limit THEN RETURN jsonb_build_object('ok', false, 'reason', 'SEAT_LIMIT_REACHED'); END IF;

  UPDATE public.community_invitations SET uses = uses + 1, updated_at = now() WHERE id = _inv.id;
  INSERT INTO public.invitation_redemptions (invitation_id, user_id, community_id)
    VALUES (_inv.id, _uid, _com.id);
  INSERT INTO public.community_memberships (community_id, user_id, role, status)
    VALUES (_com.id, _uid, 'member', 'active')
    ON CONFLICT (community_id, user_id) DO UPDATE SET status = 'active', updated_at = now();
  INSERT INTO public.access_entitlements (user_id, plan_key, source, community_id, status)
    VALUES (_uid, _inv.plan_key, 'invitation', _com.id, 'active')
    ON CONFLICT (user_id, plan_key) DO UPDATE
      SET status = 'active', community_id = EXCLUDED.community_id, updated_at = now();
  INSERT INTO public.community_audit_events (community_id, actor_user_id, action, detail)
    VALUES (_com.id, _uid, 'invitation.redeemed', jsonb_build_object('invitation_id', _inv.id, 'plan_key', _inv.plan_key));

  RETURN jsonb_build_object('ok', true, 'reason', 'REDEEMED', 'community_id', _com.id, 'plan_key', _inv.plan_key);
END $$;
REVOKE ALL ON FUNCTION public.redeem_community_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_community_invitation(text, text) TO authenticated;

-- ============ MARKET TYPE NORMALIZATION (idempotent, history preserved) ============
INSERT INTO public.user_strategy_market_type_backfill (user_id, connection_id, symbol, mode, previous_market_type, new_market_type)
SELECT us.user_id, us.connection_id, us.symbol, us.mode, us.market_type::text, 'spot'
FROM public.user_strategy us
WHERE us.mode = 'paper' AND us.market_type = 'futures'
ON CONFLICT (user_id, connection_id, symbol) DO NOTHING;

UPDATE public.user_strategy SET market_type = 'spot'
WHERE mode = 'paper' AND market_type = 'futures';