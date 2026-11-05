ALTER TABLE public.exchange_credentials
  ADD COLUMN IF NOT EXISTS encrypted_omni_seed text;

COMMENT ON COLUMN public.exchange_credentials.encrypted_omni_seed
  IS 'AES-GCM v1 encrypted ApeX Omni Key seed used for zkLink/L2 order signing. Same encryption scheme as encrypted_api_secret. Only decrypted in-memory inside the execution-broker edge function for a single order-signing call. Never returned to clients.';