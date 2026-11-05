
-- =========================================================================
-- C2 — Paper execution slots (authoritative capacity model)
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE public.paper_slot_state AS ENUM (
    'unassigned',
    'reserved',
    'committed',
    'active',
    'hedge_reserved',
    'recovery_reserved'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Slots ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.paper_execution_slots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NULL,
  exchange TEXT NOT NULL,
  environment public.scout_environment NOT NULL,
  market_type public.scout_market_type NOT NULL,
  slot_index INT NOT NULL,
  state public.paper_slot_state NOT NULL DEFAULT 'unassigned',
  assigned_symbol TEXT NULL,
  assigned_direction TEXT NULL,               -- 'long' | 'short' | null
  position_id UUID NULL,                      -- optional link to paper_positions when active
  reservation_expires_at TIMESTAMPTZ NULL,
  capacity_version INT NOT NULL DEFAULT 1,
  correlation_id UUID NULL,                   -- last correlation that touched the slot
  last_transition_at TIMESTAMPTZ NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paper_slot_index_range CHECK (slot_index BETWEEN 1 AND 10),
  CONSTRAINT paper_slot_symbol_when_assigned CHECK (
    (state = 'unassigned' AND assigned_symbol IS NULL AND assigned_direction IS NULL)
    OR (state <> 'unassigned' AND assigned_symbol IS NOT NULL)
  ),
  CONSTRAINT paper_slot_direction_valid CHECK (
    assigned_direction IS NULL OR assigned_direction IN ('long','short')
  ),
  UNIQUE (user_id, exchange, environment, market_type, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_paper_execution_slots_scope
  ON public.paper_execution_slots (user_id, exchange, environment, market_type, state);
CREATE INDEX IF NOT EXISTS idx_paper_execution_slots_symbol
  ON public.paper_execution_slots (user_id, assigned_symbol) WHERE assigned_symbol IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_execution_slots TO authenticated;
GRANT ALL ON public.paper_execution_slots TO service_role;

ALTER TABLE public.paper_execution_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage execution slots"
  ON public.paper_execution_slots FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_paper_execution_slots_updated_at
  BEFORE UPDATE ON public.paper_execution_slots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Audit ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.paper_execution_slot_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slot_id UUID NOT NULL REFERENCES public.paper_execution_slots(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  event TEXT NOT NULL,                       -- 'created' | 'state_change' | 'symbol_change' | 'position_link'
  old_state public.paper_slot_state NULL,
  new_state public.paper_slot_state NULL,
  old_symbol TEXT NULL,
  new_symbol TEXT NULL,
  correlation_id UUID NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_execution_slot_audit_slot
  ON public.paper_execution_slot_audit (slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_execution_slot_audit_user
  ON public.paper_execution_slot_audit (user_id, created_at DESC);

GRANT SELECT ON public.paper_execution_slot_audit TO authenticated;
GRANT ALL ON public.paper_execution_slot_audit TO service_role;

ALTER TABLE public.paper_execution_slot_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read slot audit"
  ON public.paper_execution_slot_audit FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Block direct mutation from authenticated role; only trigger via service_role writes.
CREATE POLICY "Deny direct slot audit writes"
  ON public.paper_execution_slot_audit FOR INSERT TO authenticated
  WITH CHECK (false);

-- Trigger: append audit on insert/update ------------------------------

CREATE OR REPLACE FUNCTION public.paper_execution_slots_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'created';
    INSERT INTO public.paper_execution_slot_audit
      (slot_id, user_id, event, old_state, new_state, old_symbol, new_symbol, correlation_id, detail)
    VALUES
      (NEW.id, NEW.user_id, v_event, NULL, NEW.state, NULL, NEW.assigned_symbol, NEW.correlation_id, NEW.detail);
    RETURN NEW;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO public.paper_execution_slot_audit
      (slot_id, user_id, event, old_state, new_state, old_symbol, new_symbol, correlation_id, detail)
    VALUES
      (NEW.id, NEW.user_id, 'state_change', OLD.state, NEW.state, OLD.assigned_symbol, NEW.assigned_symbol, NEW.correlation_id, NEW.detail);
  ELSIF NEW.assigned_symbol IS DISTINCT FROM OLD.assigned_symbol THEN
    INSERT INTO public.paper_execution_slot_audit
      (slot_id, user_id, event, old_state, new_state, old_symbol, new_symbol, correlation_id, detail)
    VALUES
      (NEW.id, NEW.user_id, 'symbol_change', OLD.state, NEW.state, OLD.assigned_symbol, NEW.assigned_symbol, NEW.correlation_id, NEW.detail);
  ELSIF NEW.position_id IS DISTINCT FROM OLD.position_id THEN
    INSERT INTO public.paper_execution_slot_audit
      (slot_id, user_id, event, old_state, new_state, old_symbol, new_symbol, correlation_id, detail)
    VALUES
      (NEW.id, NEW.user_id, 'position_link', OLD.state, NEW.state, OLD.assigned_symbol, NEW.assigned_symbol, NEW.correlation_id,
       jsonb_build_object('old_position_id', OLD.position_id, 'new_position_id', NEW.position_id));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_paper_execution_slots_audit ON public.paper_execution_slots;
CREATE TRIGGER trg_paper_execution_slots_audit
  AFTER INSERT OR UPDATE ON public.paper_execution_slots
  FOR EACH ROW EXECUTE FUNCTION public.paper_execution_slots_audit();
