-- Backfill the wallet lanes for existing accounts after the four-symbol
-- universe migration. New accounts receive the same rows through
-- ensure_paper_wallets(uuid).
insert into public.paper_wallets (user_id, wallet_key, direction_scope)
select s.user_id,
       split_part(s.symbol, '-', 1) || '-' || d.direction,
       d.direction
  from public.paper_test_symbols s
 cross join (values ('long'), ('short')) as d(direction)
 where s.enabled
   and s.market_available
   and s.symbol in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT')
on conflict (user_id, wallet_key) do nothing;
