-- Explicit follower signal access and cancellation metadata. Additive only.
alter table public.strategy_exchange_subscriptions
  add column if not exists cancelled_at timestamptz;

create policy "creators manage own signals" on public.strategy_exchange_signals
  for all using (
    exists (
      select 1 from public.strategy_exchange_strategies s
      where s.id = strategy_id and s.creator_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.strategy_exchange_strategies s
      where s.id = strategy_id and s.creator_id = auth.uid()
    )
  );

create policy "active followers see subscribed signals" on public.strategy_exchange_signals
  for select using (
    exists (
      select 1 from public.strategy_exchange_subscriptions sub
      where sub.strategy_id = strategy_exchange_signals.strategy_id
        and sub.follower_id = auth.uid()
        and sub.status = 'active'
        and (sub.expires_at is null or sub.expires_at > now())
    )
  );
