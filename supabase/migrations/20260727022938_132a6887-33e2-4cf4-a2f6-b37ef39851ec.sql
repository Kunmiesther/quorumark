UPDATE public.apex_execution_credentials
SET apex_account_id = NULL, updated_at = now()
WHERE id = '1e9169c2-6924-41b9-9bf4-4e4d4fa5e196'
  AND environment = 'mainnet';