UPDATE public.exchange_connections
SET environment = 'production',
    updated_at = now()
WHERE exchange = 'apex_omni'
  AND environment IN ('test', 'testnet', 'mainnet', 'prod', 'live');

UPDATE public.exchange_connections
SET environment = 'testnet',
    updated_at = now()
WHERE exchange = 'apex_omni_testnet'
  AND environment <> 'testnet';

WITH active_apex AS (
  SELECT DISTINCT ON (ec.user_id, ec.id)
         ec.user_id,
         ec.id AS connection_id
  FROM public.exchange_connections ec
  JOIN public.apex_execution_credentials aec
    ON aec.exchange_connection_id = ec.id
   AND aec.user_id = ec.user_id
   AND aec.active = true
   AND aec.revoked_at IS NULL
   AND aec.environment = 'mainnet'
  WHERE ec.exchange = 'apex_omni'
)
UPDATE public.exchange_connections ec
SET status = 'verified',
    permission_read = true,
    permission_trade = true,
    permissions_verified = true,
    permission_verified_at = COALESCE(ec.permission_verified_at, now()),
    last_verified_at = COALESCE(ec.last_verified_at, now()),
    last_health_check_at = COALESCE(ec.last_health_check_at, now()),
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM active_apex aa
WHERE ec.id = aa.connection_id;

WITH active_apex AS (
  SELECT DISTINCT ec.user_id, ec.id AS connection_id
  FROM public.exchange_connections ec
  JOIN public.apex_execution_credentials aec
    ON aec.exchange_connection_id = ec.id
   AND aec.user_id = ec.user_id
   AND aec.active = true
   AND aec.revoked_at IS NULL
   AND aec.environment = 'mainnet'
  WHERE ec.exchange = 'apex_omni'
)
UPDATE public.user_strategy us
SET enabled = true,
    mode = 'live',
    cross_margin = true,
    margin_mode = 'cross',
    updated_at = now()
FROM active_apex aa
WHERE us.user_id = aa.user_id
  AND us.connection_id = aa.connection_id;