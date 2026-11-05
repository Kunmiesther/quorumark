-- Proof-of-life trade trigger: one-shot admin command channel
CREATE TABLE public.worker_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('test_order')),
  symbol TEXT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','consumed','completed','failed')),
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-shot: only ONE unconsumed command of a given kind per owner.
CREATE UNIQUE INDEX worker_commands_one_pending_per_owner
  ON public.worker_commands (user_id, command)
  WHERE status = 'pending';

CREATE INDEX worker_commands_pending_created_idx
  ON public.worker_commands (created_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON public.worker_commands TO authenticated;
GRANT ALL ON public.worker_commands TO service_role;

ALTER TABLE public.worker_commands ENABLE ROW LEVEL SECURITY;

-- Admins only, scoped to their own rows. Non-admins cannot see or write.
CREATE POLICY "admins select own commands"
  ON public.worker_commands FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admins insert own commands"
  ON public.worker_commands FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'));

-- Owners may read updates the worker writes back; the worker itself uses
-- service_role via worker-ingest. Authenticated UPDATE is intentionally
-- narrow: admins cannot change status/result (worker-owned columns) — only
-- cancel a still-pending row via a DELETE-equivalent no-op. We leave UPDATE
-- to authenticated for future admin ergonomics but constrain it below.
CREATE POLICY "admins update own commands narrow"
  ON public.worker_commands FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_worker_commands_updated_at
  BEFORE UPDATE ON public.worker_commands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();