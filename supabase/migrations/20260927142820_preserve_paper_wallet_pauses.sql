-- Re-running wallet setup must not resume an existing paused wallet.
create or replace function public.ensure_paper_role_wallets_v1(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_symbol text;
  v_sort integer := 0;
begin
  if _user_id is null or not exists (select 1 from auth.users where id = _user_id) then
    raise exception 'paper_user_invalid' using errcode = '22023';
  end if;

  insert into public.paper_accounts (user_id) values (_user_id)
  on conflict (user_id) do nothing;

  foreach v_symbol in array array['BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT'] loop
    v_sort := v_sort + 1;
    insert into public.paper_test_symbols
      (user_id, symbol, display_name, exchange, max_leverage, sort_order, enabled)
    values
      (_user_id, v_symbol, split_part(v_symbol, '-', 1), 'public_market_data',
       case when v_symbol in ('BTC-USDT', 'ETH-USDT') then 100 else 50 end,
       v_sort, true)
    on conflict (user_id, symbol) do update
      set enabled = true,
          sort_order = excluded.sort_order;
  end loop;

  update public.paper_test_symbols
     set enabled = false
   where user_id = _user_id
     and symbol not in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT');

  insert into public.paper_wallets
    (user_id, wallet_key, direction_scope, balance, balance_source, status)
  select _user_id, r.wallet_key, r.direction_scope,
         greatest(a.balance, 0) / 4, 'shared_account', 'active'
    from public.paper_accounts a
   cross join (values
      ('long', 'long'),
      ('short', 'short'),
      ('hedge', 'both'),
      ('strategy', 'both')
    ) as r(wallet_key, direction_scope)
   where a.user_id = _user_id
  on conflict (user_id, wallet_key) do update
    set direction_scope = excluded.direction_scope,
        balance_source = 'shared_account';

  update public.paper_wallets
     set status = 'disabled', execution_enabled = false
   where user_id = _user_id
     and wallet_key not in ('long', 'short', 'hedge', 'strategy');

  insert into public.paper_engine_authority (user_id) values (_user_id)
  on conflict (user_id) do nothing;
end;
$$;
