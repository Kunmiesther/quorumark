
-- Worker identity registry.
CREATE TABLE public.worker_registry (
  worker_id text PRIMARY KEY,
  environment text NOT NULL DEFAULT 'production',
  key_version text NOT NULL DEFAULT 'v1',
  active boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.worker_registry TO service_role;
ALTER TABLE public.worker_registry ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated → default-deny.

CREATE TRIGGER trg_worker_registry_updated_at
  BEFORE UPDATE ON public.worker_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Nonce replay cache. PRIMARY KEY provides the uniqueness guarantee that
-- makes replay attempts fail closed at insert time.
CREATE TABLE public.worker_ingest_nonces (
  nonce text PRIMARY KEY,
  worker_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_worker_ingest_nonces_expires ON public.worker_ingest_nonces (expires_at);
GRANT ALL ON public.worker_ingest_nonces TO service_role;
ALTER TABLE public.worker_ingest_nonces ENABLE ROW LEVEL SECURITY;

-- Per-worker heartbeat row.
CREATE TABLE public.worker_heartbeats (
  worker_id text PRIMARY KEY REFERENCES public.worker_registry(worker_id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'production',
  status text NOT NULL DEFAULT 'unknown',
  mode text NOT NULL DEFAULT 'demo',
  version text,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.worker_heartbeats TO service_role;
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_worker_heartbeats_updated_at
  BEFORE UPDATE ON public.worker_heartbeats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed the expected worker id so provisioning is a single Railway env change.
INSERT INTO public.worker_registry (worker_id, environment, key_version, description)
  VALUES ('railway-turtlebot-primary', 'production', 'v1', 'Primary Railway TurtleBot worker')
  ON CONFLICT (worker_id) DO NOTHING;
