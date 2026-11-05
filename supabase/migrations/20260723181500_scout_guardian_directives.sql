-- Scout Guardian (Position Monitoring Layer).
--
-- The Railway worker runs a deterministic, always-on supervisory loop that
-- monitors every open paper position. When a rule fires an action, the worker
-- records a DIRECTIVE here (via the signed worker-ingest edge function, service
-- role). The TypeScript paper engine consumes pending directives at the start of
-- its manage phase and enforces them atomically (cancel unfilled ladder rungs /
-- force-close the position). The worker never signs or touches an exchange; it
-- only writes deterministic decisions (onyx_decisions / ops_events) and these
-- directives. The sealed-envelope signer architecture is unchanged.

-- 1. Directive queue: worker writes, engine consumes.
CREATE TABLE IF NOT EXISTS public.scout_guardian_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES public.paper_positions(id) ON DELETE CASCADE,
  wallet_key text,
  symbol text NOT NULL,
  -- cancel_unfilled_rungs: void pending ladder rungs + arm the hard stop now.
  -- close_position: force-close every filled lot at the current mark.
  -- reduce_position: reserved for a future partial-derisk rule.
  directive_type text NOT NULL CHECK (directive_type IN ('cancel_unfilled_rungs','close_position','reduce_position')),
  reason_code text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','superseded')),
  correlation_id uuid,
  guardian_cycle_ts_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by text
);

-- One live directive per (position, type). Re-emitting the same directive on
-- the next 15s worker cycle is idempotent (INSERT ... ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS scout_guardian_directives_pending_uniq
  ON public.scout_guardian_directives (position_id, directive_type)
  WHERE status = 'pending';

-- Engine consumption scan: pending directives for a user.
CREATE INDEX IF NOT EXISTS scout_guardian_directives_user_status_idx
  ON public.scout_guardian_directives (user_id, status, created_at);

GRANT SELECT ON public.scout_guardian_directives TO authenticated;
GRANT ALL ON public.scout_guardian_directives TO service_role;
ALTER TABLE public.scout_guardian_directives ENABLE ROW LEVEL SECURITY;
-- Owners can read their own directives (dashboard). All writes go through the
-- service role (worker-ingest emits; the engine consumes with supabaseAdmin).
CREATE POLICY "scout_guardian_directives select own"
  ON public.scout_guardian_directives
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 2. Allow the paper engine to record a Guardian-driven close on the trade.
--    Existing set: tp_touch | stop | floor | scout_bos | paper_reset.
ALTER TABLE public.paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE public.paper_trades ADD CONSTRAINT paper_trades_exit_reason_check CHECK (
  exit_reason = ANY (ARRAY[
    'tp_touch','stop','floor','scout_bos','paper_reset',
    'scout_guardian_bos','scout_guardian_cluster'
  ])
);
