ALTER TABLE public.exchange_connections
  ADD COLUMN market_type public.account_mode NOT NULL DEFAULT 'futures';

COMMENT ON COLUMN public.exchange_connections.market_type IS
  'What this connection trades. One market per connection; use separate connections for spot vs futures on the same venue. Backfill default is futures because every existing connection on this account is a perps venue (verified: only apex_omni exists).';
