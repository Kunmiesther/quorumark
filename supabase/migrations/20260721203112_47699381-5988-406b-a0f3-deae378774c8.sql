
CREATE TABLE IF NOT EXISTS public.bydfi_verified_universe (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  venue_symbol text NOT NULL,
  base text NOT NULL,
  quote text NOT NULL,
  tradable boolean NOT NULL DEFAULT true,
  max_leverage numeric,
  tick_size numeric,
  min_qty numeric,
  min_notional numeric,
  volume_24h_usd numeric,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bydfi_verified_universe_conn_symbol_uk UNIQUE (connection_id, symbol)
);

CREATE INDEX IF NOT EXISTS bydfi_verified_universe_user_idx
  ON public.bydfi_verified_universe(user_id);
CREATE INDEX IF NOT EXISTS bydfi_verified_universe_conn_idx
  ON public.bydfi_verified_universe(connection_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bydfi_verified_universe TO authenticated;
GRANT ALL ON public.bydfi_verified_universe TO service_role;

ALTER TABLE public.bydfi_verified_universe ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read own BYDFi universe"
  ON public.bydfi_verified_universe FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Owners can write own BYDFi universe"
  ON public.bydfi_verified_universe FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TRIGGER bydfi_verified_universe_touch
  BEFORE UPDATE ON public.bydfi_verified_universe
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
