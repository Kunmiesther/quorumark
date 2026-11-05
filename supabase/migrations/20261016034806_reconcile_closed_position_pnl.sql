-- Accounting only. No orders, settings, exposure changes, resets or deletions.
-- Keep an immutable before-image and unique trade ownership for replay safety.
create table if not exists public.live_position_pnl_settlements (
  position_id uuid primary key references public.positions(id),
  user_id uuid not null,
  connection_id uuid not null,
  realized_pnl numeric not null,
  fees_usd numeric not null,
  trade_ids uuid[] not null,
  fill_ids uuid[] not null,
  before_image jsonb not null,
  evidence jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.live_position_pnl_settlements enable row level security;
revoke all on public.live_position_pnl_settlements from public, anon, authenticated, service_role;
grant select, insert on public.live_position_pnl_settlements to service_role;

create table if not exists public.live_position_pnl_trade_links (
  trade_id uuid primary key references public.trades(id),
  position_id uuid not null references public.live_position_pnl_settlements(position_id)
);
alter table public.live_position_pnl_trade_links enable row level security;
revoke all on public.live_position_pnl_trade_links from public, anon, authenticated, service_role;
grant select, insert on public.live_position_pnl_trade_links to service_role;
create index if not exists live_position_pnl_trade_links_position_idx
  on public.live_position_pnl_trade_links(position_id);

-- The existing positions_updated_at trigger stamps every UPDATE. Accounting
-- settlement must not move a historical closure into a newer mandate window.
create or replace function public.preserve_settled_position_closure_time()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if current_user not in ('service_role','postgres','supabase_admin') then return new; end if;
  if old.source='live' and old.status='closed' and new.status='closed'
    and old.pnl_amount is null and new.pnl_amount is not null
    and (to_jsonb(new)-array['pnl_amount','strategy_metadata','updated_at']) =
        (to_jsonb(old)-array['pnl_amount','strategy_metadata','updated_at'])
    and exists(select 1 from public.live_position_pnl_settlements s
      where s.position_id=old.id and s.user_id=old.user_id and s.connection_id=old.connection_id
        and s.realized_pnl=new.pnl_amount and s.before_image=to_jsonb(old)
        and new.strategy_metadata=jsonb_set(coalesce(old.strategy_metadata,'{}'::jsonb),
          '{closure_evidence,realized_pnl_verified}','true'::jsonb)
          || jsonb_build_object('realized_pnl_evidence',s.evidence)) then
    new.updated_at:=old.updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_settled_position_closure_time() from public,anon,authenticated;
create or replace trigger zz_preserve_settled_position_closure_time
  before update of pnl_amount on public.positions for each row
  execute function public.preserve_settled_position_closure_time();

create index if not exists positions_pending_live_pnl_idx
  on public.positions(user_id, connection_id, opened_at)
  where source = 'live' and status = 'closed' and pnl_amount is null;

-- Conservative bridge for complete, unambiguous closed lots. Partial campaigns,
-- flips, missing history and ambiguous position ownership remain unresolved.
-- P&L is fill-price P&L after trading fees; funding is NOT represented here.
-- Defaults to dry-run. Caller must explicitly opt into accounting writes.
create or replace function public.reconcile_closed_position_pnl(
  p_user_id uuid, p_connection_id uuid, p_apply boolean default false
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  p record;
  t record;
  f record;
  flat_at timestamptz;
  snapshot_at timestamptz;
  first_entry timestamptz;
  last_exit timestamptz;
  trade_ids uuid[];
  fill_ids uuid[];
  n integer;
  qty numeric;
  entry_value numeric;
  pnl numeric;
  fees numeric;
  fill_entry_qty numeric;
  fill_exit_qty numeric;
  fill_entry_value numeric;
  fill_exit_value numeric;
  fill_fees numeric;
  entry_side text;
  reason text;
  evidence jsonb;
  results jsonb := '[]'::jsonb;
begin
  if p_user_id is null or p_connection_id is null or p_apply is null then
    raise exception 'PNL_RECONCILIATION_SCOPE_REQUIRED';
  end if;
  -- Serializes repair calls for the same route; does not lock order routing.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'closed-pnl:' || p_user_id::text || ':' || p_connection_id::text, 0));

  for p in select * from public.positions
    where user_id = p_user_id and connection_id = p_connection_id
      and source = 'live' and status = 'closed' and pnl_amount is null
      and exchange in ('apex_omni', 'aster')
    order by opened_at, id limit 100 for update
  loop
    reason := null;
    if p.strategy_metadata #>> '{closure_evidence,source}' is distinct from 'venue_flat_snapshot'
      or p.size is null or p.size <= 0 or p.entry_price is null or p.entry_price <= 0
      or p.side::text not in ('long', 'short') then
      results := results || jsonb_build_array(jsonb_build_object('position_id',p.id,'status','CLOSURE_EVIDENCE_MISSING'));
      continue;
    end if;
    begin
      flat_at := (p.strategy_metadata #>> '{closure_evidence,observed_at}')::timestamptz;
      snapshot_at := (p.strategy_metadata #>> '{reconciliation,at}')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      flat_at := null; snapshot_at := null;
    end;
    if flat_at is null or snapshot_at is null or snapshot_at < p.opened_at
      or snapshot_at >= flat_at or flat_at > now() - interval '5 minutes' then
      results := results || jsonb_build_array(jsonb_build_object('position_id',p.id,'status','SNAPSHOT_NOT_READY'));
      continue;
    end if;

    trade_ids := '{}'; qty := 0; entry_value := 0; pnl := 0; fees := 0;
    first_entry := null; last_exit := null; n := 0;
    for t in select * from public.trades
      where user_id=p.user_id and connection_id=p.connection_id and exchange=p.exchange
        and book='live' and pair=p.pair and side=p.side
        and closed_at >= p.opened_at and closed_at <= flat_at
      order by closed_at,id for share
    loop
      n := n+1;
      if t.evidence_verified is distinct from true
        or t.evidence_source is distinct from 'venue_fill_reconciliation'
        or t.realized_pnl is null or t.fees_usd is null
        or t.size is null or t.size <= 0 or t.entry_price is null or t.entry_price <= 0
        or t.exit_price is null or t.exit_price <= 0 or t.opened_at is null
        or t.opened_at > t.closed_at or t.entry_venue_fill_id is null or t.exit_venue_fill_id is null
        or t.realized_pnl::text in ('NaN','Infinity','-Infinity')
        or t.fees_usd::text in ('NaN','Infinity','-Infinity')
        or t.size::text in ('NaN','Infinity','-Infinity')
        or t.entry_price::text in ('NaN','Infinity','-Infinity')
        or t.exit_price::text in ('NaN','Infinity','-Infinity') then
        reason := 'TRADE_EVIDENCE_INCOMPLETE'; exit;
      end if;
      if exists(select 1 from public.live_position_pnl_trade_links l where l.trade_id=t.id) then
        reason := 'TRADE_ALREADY_ASSIGNED'; exit;
      end if;
      if not exists(select 1 from public.live_fills ef where ef.user_id=p.user_id
        and ef.connection_id=p.connection_id and ef.venue=p.exchange and ef.symbol=p.pair
        and ef.venue_fill_id=t.entry_venue_fill_id and ef.fill_ts=t.opened_at
        and ef.side=(case when p.side::text='long' then 'BUY' else 'SELL' end)) then
        reason := 'ENTRY_FILL_MISMATCH'; exit;
      end if;
      trade_ids := array_append(trade_ids,t.id);
      qty := qty+t.size; entry_value := entry_value+t.size*t.entry_price;
      pnl := pnl+t.realized_pnl; fees := fees+t.fees_usd;
      first_entry := least(first_entry,t.opened_at); last_exit := greatest(last_exit,t.closed_at);
    end loop;
    if reason is null and (n=0 or abs(qty-p.size)>0.000000001
      or abs(entry_value/nullif(qty,0)-p.entry_price)>0.000001) then
      reason := 'POSITION_TRADE_MISMATCH';
    end if;
    if reason is null and (first_entry>p.opened_at or last_exit<=snapshot_at) then
      reason := 'POSITION_TIME_MISMATCH';
    end if;
    -- No symbol-only attribution: reject overlapping exposure records, including
    -- opposite directions, and partial closures attributed outside this window.
    if reason is null and exists(select 1 from public.positions other
      where other.id<>p.id and other.user_id=p.user_id and other.connection_id=p.connection_id
        and other.source='live' and other.pair=p.pair
        and other.opened_at <= last_exit
        and (other.status='open' or other.updated_at >= first_entry)) then
      reason := 'OVERLAPPING_POSITION';
    end if;
    if reason is not null then
      results := results || jsonb_build_array(jsonb_build_object('position_id',p.id,'status',reason));
      continue;
    end if;

    entry_side := case when p.side::text='long' then 'BUY' else 'SELL' end;
    fill_ids := '{}'; fill_entry_qty:=0; fill_exit_qty:=0;
    fill_entry_value:=0; fill_exit_value:=0; fill_fees:=0;
    for f in select * from public.live_fills
      where user_id=p.user_id and connection_id=p.connection_id and venue=p.exchange
        and symbol=p.pair and fill_ts>=first_entry and fill_ts<=flat_at
      order by fill_ts,id for share
    loop
      -- Omni USDT perpetuals settle in USDT. Older normalized rows omitted
      -- feeAsset even though the venue contract fixes settlement currency:
      -- https://api-docs.omni.apex.exchange/ (Margin / settleCurrency).
      if (f.fee_currency is distinct from 'USDT' and not
          (f.fee_currency is null and f.venue='apex_omni' and f.symbol in ('BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT')))
        or f.fee is null
        or f.size is null or f.size<=0 or f.price is null or f.price<=0
        or f.side not in ('BUY','SELL')
        or f.fee::text in ('NaN','Infinity','-Infinity')
        or f.size::text in ('NaN','Infinity','-Infinity')
        or f.price::text in ('NaN','Infinity','-Infinity') then
        reason := 'FILL_ACCOUNTING_INCOMPLETE'; exit;
      end if;
      fill_ids := array_append(fill_ids,f.id);
      fill_fees := fill_fees+f.fee;
      if f.side=entry_side then
        -- This narrow bridge settles a complete accumulated lot, not a guessed
        -- reconstruction of interleaved partial exits and re-entries.
        if f.fill_ts>snapshot_at then reason:='ENTRY_AFTER_LAST_SNAPSHOT'; exit; end if;
        fill_entry_qty:=fill_entry_qty+f.size;
        fill_entry_value:=fill_entry_value+f.size*f.price;
      else
        if f.fill_ts<=snapshot_at then reason:='PARTIAL_CLOSE_REQUIRES_REVIEW'; exit; end if;
        fill_exit_qty:=fill_exit_qty+f.size;
        fill_exit_value:=fill_exit_value+f.size*f.price;
        if not exists(select 1 from public.trades tr where tr.id=any(trade_ids)
          and tr.exit_venue_fill_id=f.venue_fill_id and tr.size=f.size
          and tr.closed_at=f.fill_ts and abs(tr.exit_price-f.price)<=0.000001) then
          reason:='EXIT_FILL_MISMATCH'; exit;
        end if;
      end if;
    end loop;
    if reason is null and (abs(fill_entry_qty-qty)>0.000000001
      or abs(fill_exit_qty-qty)>0.000000001
      or abs(fill_entry_value-entry_value)>0.00001
      or abs(fill_fees-fees)>0.00001
      or abs((fill_exit_value-fill_entry_value)*(case when p.side::text='long' then 1 else -1 end)-fill_fees-pnl)>0.00001) then
      reason:='FILL_TOTAL_MISMATCH';
    end if;
    if reason is not null then
      results := results || jsonb_build_array(jsonb_build_object('position_id',p.id,'status',reason));
      continue;
    end if;
    evidence := jsonb_build_object('source','closed_lot_fill_reconciliation_v1',
      'realized_pnl_verified',true,'flat_observed_at',flat_at,'last_open_observed_at',snapshot_at,
      'first_entry_at',first_entry,'last_exit_at',last_exit,'trade_ids',trade_ids,'fill_ids',fill_ids,
      'fees_usd',fill_fees,'funding_included',false,'pnl_basis','fill_prices_less_trading_fees');
    if p_apply then
      insert into public.live_position_pnl_settlements(position_id,user_id,connection_id,
        realized_pnl,fees_usd,trade_ids,fill_ids,before_image,evidence)
      values(p.id,p.user_id,p.connection_id,pnl,fill_fees,trade_ids,fill_ids,to_jsonb(p),evidence);
      insert into public.live_position_pnl_trade_links(trade_id,position_id)
        select unnest(trade_ids),p.id;
      -- Preserve the closure timestamp used by mandate accounting, exposure,
      -- strategy attribution, and all pre-existing metadata. Zero is valid P&L.
      update public.positions set pnl_amount=pnl,
        strategy_metadata=jsonb_set(coalesce(strategy_metadata,'{}'::jsonb),
          '{closure_evidence,realized_pnl_verified}','true'::jsonb) || jsonb_build_object('realized_pnl_evidence',evidence)
        where id=p.id and user_id=p_user_id and connection_id=p_connection_id
          and source='live' and status='closed' and pnl_amount is null;
    end if;
    results := results || jsonb_build_array(jsonb_build_object('position_id',p.id,
      'status',case when p_apply then 'SETTLED' else 'VERIFIED_DRY_RUN' end,'realized_pnl',pnl));
  end loop;
  return jsonb_build_object('applied',p_apply,'results',results);
end;
$$;
revoke all on function public.reconcile_closed_position_pnl(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_closed_position_pnl(uuid,uuid,boolean) to service_role;
