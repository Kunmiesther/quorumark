
-- P2 — Kill switches + connection cap index fix

-- 1) Drop the one-active-per-venue unique index (six-per-user trigger remains the sole cap).
DROP INDEX IF EXISTS public.exchange_connections_one_active_per_exchange;

-- 2) Preserve any existing kill_switches rows in a legacy table (idempotent).
CREATE TABLE IF NOT EXISTS public.kill_switches_legacy (
  scope text,
  active boolean,
  updated_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.kill_switches_legacy TO service_role;
ALTER TABLE public.kill_switches_legacy ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

-- Snapshot existing rows into legacy (nothing today, but be safe).
INSERT INTO public.kill_switches_legacy (scope, active, updated_at)
SELECT scope, active, updated_at FROM public.kill_switches;

-- Capture rows that will migrate cleanly to scope='global'.
CREATE TEMP TABLE _ks_migrate ON COMMIT DROP AS
SELECT active, updated_at
FROM public.kill_switches
WHERE scope IS NOT NULL;

-- Drop and recreate with the new shape.
DROP TABLE public.kill_switches;

CREATE TABLE public.kill_switches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global','user','connection')),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kill_switches_scope_shape CHECK (
    (scope = 'global'     AND user_id IS NULL     AND connection_id IS NULL) OR
    (scope = 'user'       AND user_id IS NOT NULL AND connection_id IS NULL) OR
    (scope = 'connection' AND user_id IS NOT NULL AND connection_id IS NOT NULL)
  )
);

-- Grants: users read (RLS narrows); no client writes.
GRANT SELECT ON public.kill_switches TO authenticated;
GRANT ALL ON public.kill_switches TO service_role;

-- Partial unique indexes: at most one global, one per user, one per connection.
CREATE UNIQUE INDEX kill_switches_one_global
  ON public.kill_switches ((true)) WHERE scope = 'global';
CREATE UNIQUE INDEX kill_switches_one_per_user
  ON public.kill_switches (user_id) WHERE scope = 'user';
CREATE UNIQUE INDEX kill_switches_one_per_connection
  ON public.kill_switches (connection_id) WHERE scope = 'connection';

-- Migrate preserved rows — collapse any pre-existing rows into a single global row.
INSERT INTO public.kill_switches (scope, active, updated_at, reason)
SELECT 'global', bool_or(active), max(updated_at), 'migrated from legacy kill_switches'
FROM _ks_migrate
HAVING count(*) > 0;

-- RLS: enabled, SELECT-only policy for authenticated users.
ALTER TABLE public.kill_switches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own or global kill switches"
  ON public.kill_switches
  FOR SELECT
  TO authenticated
  USING (scope = 'global' OR user_id = auth.uid());

-- updated_at trigger
CREATE TRIGGER kill_switches_updated_at
  BEFORE UPDATE ON public.kill_switches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Helper: is_execution_halted
CREATE OR REPLACE FUNCTION public.is_execution_halted(
  p_user_id uuid,
  p_connection_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.kill_switches
    WHERE active = true
      AND (
        scope = 'global'
        OR (scope = 'user'       AND user_id = p_user_id)
        OR (scope = 'connection' AND user_id = p_user_id AND connection_id = p_connection_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_execution_halted(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) TO authenticated, service_role;
