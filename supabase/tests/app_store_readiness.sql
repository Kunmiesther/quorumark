begin;

do $$
declare
  profile_update_check text;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'ai_data_consent_at'
  ) then
    raise exception 'profiles.ai_data_consent_at is missing';
  end if;

  select with_check
    into profile_update_check
  from pg_policies
  where schemaname = 'public'
    and tablename = 'profiles'
    and policyname = 'Users update own profile';

  if profile_update_check is null or profile_update_check not like '%auth.uid()%' then
    raise exception 'profile UPDATE policy must enforce ownership with WITH CHECK';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'strategy_decisions'
      and roles @> array['authenticated']::name[]
      and qual like '%auth.uid()%user_id%'
  ) then
    raise exception 'strategy_decisions owner SELECT policy is missing';
  end if;
end
$$;

rollback;
