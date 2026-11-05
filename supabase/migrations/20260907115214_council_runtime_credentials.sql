-- Service-only bridge from a user's saved Council configuration to trusted
-- server runtime. Plaintext keys never enter a public table or browser role.
create or replace function public.get_user_ai_council_runtime(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', c.enabled,
    'seats', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'provider', seat.value ->> 'provider',
          'model', seat.value ->> 'model',
          'api_key', secret.decrypted_secret
        ) order by seat.ordinality
      ),
      '[]'::jsonb
    )
  )
  from public.user_ai_council c
  cross join lateral jsonb_array_elements(c.seats) with ordinality as seat(value, ordinality)
  left join public.user_llm_credentials credential
    on credential.user_id = c.user_id
   and credential.provider = seat.value ->> 'provider'
  left join vault.decrypted_secrets secret
    on secret.id = credential.vault_secret_id
  where c.user_id = p_user_id
  group by c.enabled;
$$;

revoke all on function public.get_user_ai_council_runtime(uuid) from public, anon, authenticated;
grant execute on function public.get_user_ai_council_runtime(uuid) to service_role;

comment on function public.get_user_ai_council_runtime(uuid) is
  'Service-role-only resolver for user-selected Council models and Vault credentials.';
