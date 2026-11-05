UPDATE public.apex_execution_credentials
SET apex_account_id = '869372098012774449'
WHERE user_id = '0b7b1651-b3a5-4370-b89f-0deeaba4ea3f'
  AND exchange_connection_id = '4a6cec71-0f1f-423f-8979-25edf2e77b7d'
  AND active = true
  AND revoked_at IS NULL
  AND (apex_account_id IS NULL OR apex_account_id = '');