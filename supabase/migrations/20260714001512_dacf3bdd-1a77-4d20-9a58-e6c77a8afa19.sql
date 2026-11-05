-- wallet_connections
CREATE TABLE public.wallet_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  public_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'mainnet',
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  is_active BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wallet_connections TO authenticated;
GRANT ALL ON public.wallet_connections TO service_role;

ALTER TABLE public.wallet_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own wallet connections"
  ON public.wallet_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- One active wallet per (user, chain, address)
CREATE UNIQUE INDEX wallet_connections_one_active_per_addr
  ON public.wallet_connections (user_id, chain, lower(public_address))
  WHERE is_active = true;

CREATE INDEX wallet_connections_user_idx ON public.wallet_connections (user_id);

CREATE TRIGGER wallet_connections_set_updated_at
  BEFORE UPDATE ON public.wallet_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- wallet_connection_challenges
CREATE TABLE public.wallet_connection_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  chain TEXT NOT NULL,
  public_address TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  challenge_text TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wallet_connection_challenges TO authenticated;
GRANT ALL ON public.wallet_connection_challenges TO service_role;

ALTER TABLE public.wallet_connection_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own wallet challenges"
  ON public.wallet_connection_challenges FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX wallet_challenges_user_idx ON public.wallet_connection_challenges (user_id);
CREATE INDEX wallet_challenges_expiry_idx ON public.wallet_connection_challenges (expires_at) WHERE used_at IS NULL;