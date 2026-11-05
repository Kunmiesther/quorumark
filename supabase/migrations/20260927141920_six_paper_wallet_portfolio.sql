-- Six paper-only accounting buckets. No live tables, keys, or settings change.
-- Existing users opt in through the service-only one-time funding function;
-- a normal tick must never replenish losses or erase historical results.
create table public.paper_portfolio_funding (
  user_id uuid primary key references auth.users(id) on delete cascade,
  funded_at timestamptz not null default now(),
  previous_account_balance numeric not null,
  funded_account_balance numeric not null default 15000 check (funded_account_balance = 15000),
  wallet_seed numeric not null default 2500 check (wallet_seed = 2500),
  previous_wallets jsonb not null
);
alter table public.paper_portfolio_funding enable row level security;
revoke all on public.paper_portfolio_funding from public, anon, authenticated;
grant select on public.paper_portfolio_funding to authenticated;
grant all on public.paper_portfolio_funding to service_role;
create policy paper_funding_owner_read on public.paper_portfolio_funding
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.paper_wallet_preferences (
  user_id uuid not null,
  wallet_key text not null check (wallet_key in ('long','short','hedge','strategy','blockchain_evm','blockchain_non_evm')),
  simulated_provider text not null check (simulated_provider in ('metamask','trust','coinbase','phantom','solflare','binance','robinhood')),
  primary key(user_id,wallet_key),
  foreign key(user_id,wallet_key) references public.paper_wallets(user_id,wallet_key) on delete cascade
);
alter table public.paper_wallet_preferences enable row level security;
revoke all on public.paper_wallet_preferences from public, anon, authenticated;
grant select, insert, update on public.paper_wallet_preferences to authenticated;
grant all on public.paper_wallet_preferences to service_role;
create policy paper_wallet_preferences_read on public.paper_wallet_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy paper_wallet_preferences_insert on public.paper_wallet_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy paper_wallet_preferences_update on public.paper_wallet_preferences
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Retain the proven four-role initializer. The wrapper below adds the two
-- reserved blockchain buckets without sending them through the perp engine.
alter function public.ensure_paper_wallets(uuid) rename to ensure_paper_role_wallets_v1;

create function public.configure_six_paper_wallets(_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_before numeric; v_wallets jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('paper-six-wallets:' || _user_id::text, 0));
  if exists (select 1 from public.paper_portfolio_funding where user_id = _user_id) then return; end if;
  perform public.ensure_paper_role_wallets_v1(_user_id);
  insert into public.paper_wallets(user_id,wallet_key,direction_scope,balance,status,execution_enabled,balance_source)
    values (_user_id,'blockchain_evm','both',0,'disabled',false,'paper_allocation'),
           (_user_id,'blockchain_non_evm','both',0,'disabled',false,'paper_allocation')
    on conflict(user_id,wallet_key) do nothing;
  perform 1 from public.paper_wallets where user_id = _user_id order by wallet_key for update;
  select balance into v_before from public.paper_accounts where user_id = _user_id for update;
  if exists (select 1 from public.paper_positions where user_id = _user_id and status='open'
      group by wallet_key having sum(margin) > 2500)
    then raise exception 'paper_funding_would_underfund_open_positions'; end if;
  if exists (select 1 from public.paper_positions where user_id = _user_id and status='open'
      and wallet_key not in ('long','short','hedge','strategy'))
    then raise exception 'paper_funding_requires_legacy_position_reconciliation'; end if;
  select jsonb_agg(jsonb_build_object('wallet_key',wallet_key,'balance',balance,'realized_pnl',realized_pnl))
    into v_wallets from public.paper_wallets where user_id=_user_id;
  insert into public.paper_portfolio_funding(user_id,previous_account_balance,previous_wallets)
    values (_user_id,v_before,v_wallets);
  update public.paper_wallets set balance=2500,balance_source='paper_allocation',updated_at=now()
    where user_id=_user_id and wallet_key in ('long','short','hedge','strategy','blockchain_evm','blockchain_non_evm');
  update public.paper_accounts set balance=15000,updated_at=now() where user_id=_user_id;
  -- Realized P&L, counters, orders, open positions and historical fills are retained.
end $$;
revoke all on function public.configure_six_paper_wallets(uuid) from public,anon,authenticated;
grant execute on function public.configure_six_paper_wallets(uuid) to service_role;

create function public.ensure_paper_wallets(_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_new boolean;
begin
  v_new := not exists(select 1 from public.paper_accounts where user_id=_user_id);
  perform public.ensure_paper_role_wallets_v1(_user_id);
  insert into public.paper_wallets(user_id,wallet_key,direction_scope,balance,status,execution_enabled,balance_source)
    values (_user_id,'blockchain_evm','both',0,'disabled',false,'paper_allocation'),
           (_user_id,'blockchain_non_evm','both',0,'disabled',false,'paper_allocation')
    on conflict(user_id,wallet_key) do nothing;
  if v_new then perform public.configure_six_paper_wallets(_user_id); end if;
end $$;
revoke all on function public.ensure_paper_wallets(uuid) from public,anon,authenticated;
grant execute on function public.ensure_paper_wallets(uuid) to service_role;

-- An account-level balance is not permission to borrow another wallet's
-- allocation. Serialize reservations per destination wallet, including rungs.
create function public.guard_paper_wallet_collateral()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_balance numeric; v_reserved numeric;
begin
  if new.status <> 'open' or not exists(select 1 from public.paper_portfolio_funding where user_id=new.user_id)
    then return new; end if;
  if tg_op='UPDATE' and (new.user_id,new.wallet_key) is distinct from (old.user_id,old.wallet_key)
    then raise exception 'paper_wallet_identity_immutable'; end if;
  select balance into v_balance from public.paper_wallets
    where user_id=new.user_id and wallet_key=new.wallet_key for update;
  select coalesce(sum(margin),0) into v_reserved from public.paper_positions
    where user_id=new.user_id and wallet_key=new.wallet_key and status='open' and id is distinct from new.id;
  if v_balance is null or new.margin is null or new.margin < 0 or new.margin + v_reserved > v_balance
    then raise exception 'paper_wallet_insufficient_collateral' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_paper_wallet_collateral() from public,anon,authenticated;
grant execute on function public.guard_paper_wallet_collateral() to service_role;
create trigger paper_wallet_collateral_guard before insert or update of margin,wallet_key,user_id,status on public.paper_positions
  for each row execute function public.guard_paper_wallet_collateral();
