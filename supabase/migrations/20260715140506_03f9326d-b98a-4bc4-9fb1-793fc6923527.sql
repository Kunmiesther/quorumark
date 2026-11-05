
CREATE TABLE public.connection_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.exchange_connections(id) ON DELETE SET NULL,
  event text NOT NULL CHECK (event IN (
    'pause','resume','disconnect_preflight','disconnect_blocked','disconnect_committed'
  )),
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX connection_audit_events_user_idx ON public.connection_audit_events (user_id, created_at DESC);
CREATE INDEX connection_audit_events_conn_idx ON public.connection_audit_events (connection_id, created_at DESC);

GRANT SELECT ON public.connection_audit_events TO authenticated;
GRANT ALL ON public.connection_audit_events TO service_role;

ALTER TABLE public.connection_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own connection audit"
  ON public.connection_audit_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Append-only: block UPDATE/DELETE with a trigger (mirrors order_audit pattern).
CREATE OR REPLACE FUNCTION public.connection_audit_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'connection_audit_events is append-only; % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER connection_audit_no_update
  BEFORE UPDATE ON public.connection_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.connection_audit_block_mutation();

CREATE TRIGGER connection_audit_no_delete
  BEFORE DELETE ON public.connection_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.connection_audit_block_mutation();
