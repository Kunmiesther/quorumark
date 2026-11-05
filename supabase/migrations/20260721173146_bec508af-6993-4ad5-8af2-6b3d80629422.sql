
-- =====================================================================
-- CROSS-MARGIN POLICY LOCK
-- Adds explicit margin_mode enforcement, backfills history truthfully,
-- and blocks any future isolated/unknown mode at the database layer.
-- Corrected: user_strategy has composite PK (user_id, connection_id).
-- =====================================================================

-- 1. Audit table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.margin_policy_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  scope_id       UUID,
  event          TEXT NOT NULL,
  from_value     TEXT,
  to_value       TEXT,
  reason_code    TEXT NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.margin_policy_events TO authenticated;
GRANT ALL ON public.margin_policy_events TO service_role;
ALTER TABLE public.margin_policy_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own margin policy events" ON public.margin_policy_events;
CREATE POLICY "Users read own margin policy events"
  ON public.margin_policy_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL);

CREATE INDEX IF NOT EXISTS margin_policy_events_user_idx
  ON public.margin_policy_events(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.margin_policy_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'margin_policy_events is append-only';
END; $$;

DROP TRIGGER IF EXISTS margin_policy_events_no_update ON public.margin_policy_events;
CREATE TRIGGER margin_policy_events_no_update
  BEFORE UPDATE OR DELETE ON public.margin_policy_events
  FOR EACH ROW EXECUTE FUNCTION public.margin_policy_events_append_only();

-- 2. user_strategy: add margin_mode, backfill, lock ---------------------
ALTER TABLE public.user_strategy
  ADD COLUMN IF NOT EXISTS margin_mode TEXT NOT NULL DEFAULT 'cross';

-- Backfill + audit. Composite PK (user_id, connection_id); persist
-- connection_id as scope_id and keep user_id/strategy_id in detail.
WITH updated AS (
  UPDATE public.user_strategy
     SET cross_margin = true,
         margin_mode  = 'cross'
   WHERE margin_mode IS DISTINCT FROM 'cross'
      OR cross_margin IS DISTINCT FROM true
  RETURNING user_id, connection_id, strategy_id
)
INSERT INTO public.margin_policy_events
  (user_id, scope, scope_id, event, from_value, to_value, reason_code, detail)
SELECT user_id, 'user_strategy', connection_id,
       'migrated_to_cross', 'legacy', 'cross', 'CROSS_MARGIN_POLICY_LOCK',
       jsonb_build_object('strategy_id', strategy_id)
  FROM updated;

INSERT INTO public.margin_policy_events (user_id, scope, event, reason_code, detail)
VALUES (NULL, 'system', 'migrated_to_cross', 'CROSS_MARGIN_POLICY_LOCK',
        jsonb_build_object('note','user_strategy locked to cross'));

ALTER TABLE public.user_strategy
  DROP CONSTRAINT IF EXISTS user_strategy_margin_mode_cross_only;
ALTER TABLE public.user_strategy
  ADD CONSTRAINT user_strategy_margin_mode_cross_only
  CHECK (margin_mode = 'cross' AND cross_margin = true);

CREATE OR REPLACE FUNCTION public.user_strategy_enforce_cross()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.margin_mode IS NULL OR NEW.margin_mode <> 'cross' OR COALESCE(NEW.cross_margin, false) <> true THEN
    INSERT INTO public.margin_policy_events
      (user_id, scope, scope_id, event, from_value, to_value, reason_code, detail)
    VALUES (NEW.user_id, 'user_strategy', NEW.connection_id,
            CASE WHEN NEW.margin_mode = 'isolated' THEN 'blocked_isolated' ELSE 'blocked_unknown' END,
            COALESCE(NEW.margin_mode, 'null'), 'cross', 'CROSS_MARGIN_REQUIRED',
            jsonb_build_object('cross_margin', NEW.cross_margin));
    RAISE EXCEPTION 'CROSS_MARGIN_REQUIRED: margin_mode must be cross (got %, cross_margin=%)',
      COALESCE(NEW.margin_mode,'null'), COALESCE(NEW.cross_margin::text,'null');
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS user_strategy_enforce_cross_trg ON public.user_strategy;
CREATE TRIGGER user_strategy_enforce_cross_trg
  BEFORE INSERT OR UPDATE ON public.user_strategy
  FOR EACH ROW EXECUTE FUNCTION public.user_strategy_enforce_cross();

-- 3. paper_positions: opened_margin_mode (history-preserving) ----------
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS opened_margin_mode TEXT NOT NULL DEFAULT 'cross';

WITH backfilled AS (
  UPDATE public.paper_positions
     SET opened_margin_mode = 'cross'
   WHERE opened_margin_mode IS DISTINCT FROM 'cross'
  RETURNING id, user_id
)
INSERT INTO public.margin_policy_events
  (user_id, scope, scope_id, event, from_value, to_value, reason_code)
SELECT user_id, 'paper_position', id,
       'migrated_to_cross', 'implicit', 'cross', 'CROSS_MARGIN_POLICY_LOCK'
  FROM backfilled;

ALTER TABLE public.paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_opened_margin_mode_check;
ALTER TABLE public.paper_positions
  ADD CONSTRAINT paper_positions_opened_margin_mode_check
  CHECK (opened_margin_mode IN ('cross'));

CREATE OR REPLACE FUNCTION public.paper_positions_opened_margin_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.opened_margin_mode IS DISTINCT FROM OLD.opened_margin_mode THEN
    RAISE EXCEPTION 'opened_margin_mode is immutable';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS paper_positions_opened_margin_immutable_trg ON public.paper_positions;
CREATE TRIGGER paper_positions_opened_margin_immutable_trg
  BEFORE UPDATE ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_opened_margin_immutable();

-- 4. Seeder default so new connections come up cross -------------------
CREATE OR REPLACE FUNCTION public.seed_user_strategy_for_connection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  default_strategy_id uuid;
BEGIN
  SELECT id INTO default_strategy_id FROM public.strategies WHERE slug = 'dca' LIMIT 1;
  IF default_strategy_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_strategy
    (user_id, connection_id, strategy_id, market_type, cross_margin, enabled, mode, params, hedge_guard, margin_mode)
  VALUES
    (NEW.user_id, NEW.id, default_strategy_id, 'spot', true, false, 'paper', '{}'::jsonb, '{}'::jsonb, 'cross')
  ON CONFLICT (user_id, connection_id) DO NOTHING;

  RETURN NEW;
END; $$;

-- 5. order_intents: enforce cross at insert -----------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='order_intents' AND column_name='margin_mode') THEN
    EXECUTE 'ALTER TABLE public.order_intents DROP CONSTRAINT IF EXISTS order_intents_margin_mode_cross_only';
    EXECUTE 'ALTER TABLE public.order_intents ADD CONSTRAINT order_intents_margin_mode_cross_only CHECK (margin_mode = ''cross'')';
  ELSE
    EXECUTE 'ALTER TABLE public.order_intents ADD COLUMN margin_mode TEXT NOT NULL DEFAULT ''cross''';
    EXECUTE 'ALTER TABLE public.order_intents ADD CONSTRAINT order_intents_margin_mode_cross_only CHECK (margin_mode = ''cross'')';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.order_intents_enforce_cross()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.margin_mode IS NULL OR NEW.margin_mode <> 'cross' THEN
    INSERT INTO public.margin_policy_events
      (user_id, scope, scope_id, event, from_value, to_value, reason_code)
    VALUES (NEW.user_id, 'order_intent', NEW.id,
            CASE WHEN NEW.margin_mode = 'isolated' THEN 'blocked_isolated' ELSE 'blocked_unknown' END,
            COALESCE(NEW.margin_mode,'null'), 'cross', 'CROSS_MARGIN_REQUIRED');
    RAISE EXCEPTION 'CROSS_MARGIN_REQUIRED: order intent margin_mode must be cross';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS order_intents_enforce_cross_trg ON public.order_intents;
CREATE TRIGGER order_intents_enforce_cross_trg
  BEFORE INSERT OR UPDATE ON public.order_intents
  FOR EACH ROW EXECUTE FUNCTION public.order_intents_enforce_cross();

-- 6. External real-position reconciliation marker (system audit) --------
INSERT INTO public.margin_policy_events (user_id, scope, event, reason_code, detail)
VALUES (NULL, 'system', 'migrated_to_cross', 'CROSS_MARGIN_POLICY_LOCK',
        jsonb_build_object(
          'note','Cross-margin policy lock applied; live/external positions require exchange reconciliation before any margin-mode change.',
          'live_open_positions_blocked_from_auto_change', true
        ));
