-- Owner-scoped Autopilot updates. Both tables already have authenticated
-- SELECT policies restricted by auth.uid() = user_id.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'positions'
  ) then
    alter publication supabase_realtime add table public.positions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_tp_council_reviews'
  ) then
    alter publication supabase_realtime add table public.live_tp_council_reviews;
  end if;
end $$;
