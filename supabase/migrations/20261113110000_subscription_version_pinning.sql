-- Followers follow an immutable published version, not a moving strategy alias.
alter table public.strategy_exchange_subscriptions
  add column if not exists version_id uuid references public.strategy_exchange_versions(id);

update public.strategy_exchange_subscriptions sub
set version_id = v.id
from public.strategy_exchange_strategies s
join public.strategy_exchange_versions v
  on v.strategy_id = s.id and v.version = s.current_version
where sub.strategy_id = s.id and sub.version_id is null;

create index if not exists strategy_exchange_subscriptions_version_idx
  on public.strategy_exchange_subscriptions(strategy_id, version_id, follower_id);
