
CREATE TABLE IF NOT EXISTS public.paper_engine_authority (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mode        text NOT NULL DEFAULT 'legacy'
              CHECK (mode IN ('legacy', 'dynamic_universe')),
  enabled_at  timestamptz NOT NULL DEFAULT now(),
  notes       text
);

REVOKE ALL ON public.paper_engine_authority FROM PUBLIC, anon;
GRANT SELECT ON public.paper_engine_authority TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_engine_authority TO service_role;

ALTER TABLE public.paper_engine_authority ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_engine_authority_owner_read ON public.paper_engine_authority;
CREATE POLICY paper_engine_authority_owner_read
  ON public.paper_engine_authority
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS slot_id uuid
  REFERENCES public.paper_execution_slots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS paper_positions_slot_id_idx
  ON public.paper_positions(slot_id) WHERE slot_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._paper_positions_authority_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
AS $fn$
DECLARE
  v_mode text;
  v_slot record;
BEGIN
  SELECT mode INTO v_mode
    FROM public.paper_engine_authority
    WHERE user_id = NEW.user_id;

  IF v_mode IS DISTINCT FROM 'dynamic_universe' THEN
    RETURN NEW;
  END IF;

  IF NEW.slot_id IS NULL THEN
    RAISE EXCEPTION
      'paper_authority_violation: dynamic_universe user % attempted paper_positions insert with NULL slot_id (symbol=%, direction=%, strategy=%)',
      NEW.user_id, NEW.symbol, NEW.direction, NEW.strategy
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, user_id, state, assigned_symbol, assigned_direction, position_id
    INTO v_slot
    FROM public.paper_execution_slots
    WHERE id = NEW.slot_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'paper_authority_violation: slot % not found for user % (symbol=%)',
      NEW.slot_id, NEW.user_id, NEW.symbol
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_slot.user_id <> NEW.user_id THEN
    RAISE EXCEPTION
      'paper_authority_violation: slot % owned by %, not %',
      NEW.slot_id, v_slot.user_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_slot.state NOT IN ('reserved', 'committed', 'active') THEN
    RAISE EXCEPTION
      'paper_authority_violation: slot % in state % is not open for entry (symbol=%)',
      NEW.slot_id, v_slot.state, NEW.symbol
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_slot.assigned_symbol IS DISTINCT FROM NEW.symbol
     OR v_slot.assigned_direction IS DISTINCT FROM NEW.direction THEN
    RAISE EXCEPTION
      'paper_authority_violation: slot % assigned (%/%) does not match insert (%/%)',
      NEW.slot_id, v_slot.assigned_symbol, v_slot.assigned_direction,
      NEW.symbol, NEW.direction
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_slot.position_id IS NOT NULL AND v_slot.position_id <> NEW.id THEN
    RAISE EXCEPTION
      'paper_authority_violation: slot % already correlated to position %',
      NEW.slot_id, v_slot.position_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS paper_positions_authority_guard_trg ON public.paper_positions;
CREATE TRIGGER paper_positions_authority_guard_trg
  BEFORE INSERT ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public._paper_positions_authority_guard();

REVOKE ALL ON FUNCTION public._paper_positions_authority_guard() FROM PUBLIC, anon, authenticated;

INSERT INTO public.paper_engine_authority (user_id, mode, notes)
VALUES (
  '0b7b1651-b3a5-4370-b89f-0deeaba4ea3f',
  'dynamic_universe',
  'C4: sole-authority soak test. Slot correlation mandatory for all new paper_positions inserts.'
)
ON CONFLICT (user_id) DO UPDATE
  SET mode = EXCLUDED.mode,
      enabled_at = now(),
      notes = EXCLUDED.notes;
