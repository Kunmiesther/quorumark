-- A collateral guard limits new exposure, never risk-reducing exits.
create or replace function public.guard_paper_wallet_collateral()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_balance numeric; v_reserved numeric;
begin
  if new.status <> 'open' or not exists(select 1 from public.paper_portfolio_funding where user_id=new.user_id)
    then return new; end if;
  if tg_op='UPDATE' then
    if (new.user_id,new.wallet_key) is distinct from (old.user_id,old.wallet_key)
      then raise exception 'paper_wallet_identity_immutable'; end if;
    if old.status='open' and new.margin >= 0 and new.margin <= old.margin then return new; end if;
  end if;
  select balance into v_balance from public.paper_wallets
    where user_id=new.user_id and wallet_key=new.wallet_key for update;
  select coalesce(sum(margin),0) into v_reserved from public.paper_positions
    where user_id=new.user_id and wallet_key=new.wallet_key and status='open' and id is distinct from new.id;
  if v_balance is null or new.margin is null or new.margin < 0 or new.margin + v_reserved > v_balance
    then raise exception 'paper_wallet_insufficient_collateral' using errcode='23514'; end if;
  return new;
end $$;
