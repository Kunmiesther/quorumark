-- Additive auth hardening; no destructive operations.
alter table public.wallet_connection_challenges
  add column if not exists recipient text,
  add column if not exists network text not null default 'testnet';

create index if not exists wallet_connection_challenges_address_idx
  on public.wallet_connection_challenges (chain, public_address, expires_at);

create policy "followers create own subscriptions" on public.strategy_exchange_subscriptions
  for insert with check (follower_id = auth.uid());
create policy "followers cancel own subscriptions" on public.strategy_exchange_subscriptions
  for update using (follower_id = auth.uid()) with check (follower_id = auth.uid());
create policy "followers create own decisions" on public.strategy_exchange_decisions
  for insert with check (follower_id = auth.uid());
