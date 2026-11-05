-- ApeX reports closing P&L independently of our FIFO matcher. Accept only
-- one complete close, confirmed by its exit fill and last open/flat snapshots.
-- Partial campaigns and conflicting histories intentionally stay unresolved.
alter table public.live_position_pnl_settlements alter column fees_usd drop not null;
create table if not exists public.apex_pnl_event_links (
  connection_id uuid not null,
  event_key text not null,
  position_id uuid not null references public.live_position_pnl_settlements(position_id),
  primary key(connection_id,event_key)
);
alter table public.apex_pnl_event_links enable row level security;
revoke all on public.apex_pnl_event_links from public,anon,authenticated,service_role;
grant select,insert on public.apex_pnl_event_links to service_role;

create or replace function public.reconcile_apex_reported_pnl(
  p_user_id uuid,p_connection_id uuid,p_apply boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare p record; h jsonb; candidate jsonb; history_count integer; flat_at timestamptz; snapshot_at timestamptz;
  exit_at timestamptz; qty numeric; entry numeric; exit_price numeric; pnl numeric; v_event_key text;
  fill_qty numeric; fill_value numeric; fill_ids uuid[]; evidence jsonb; results jsonb:='[]'::jsonb;
begin
  if p_user_id is null or p_connection_id is null or p_apply is null then raise exception 'PNL_SCOPE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('closed-pnl:'||p_user_id::text||':'||p_connection_id::text,0));
  for p in select * from public.positions where user_id=p_user_id and connection_id=p_connection_id
    and source='live' and status='closed' and exchange='apex_omni' and pnl_amount is null
    order by opened_at,id limit 100 for update
  loop
    if p.strategy_metadata#>>'{closure_evidence,source}' is distinct from 'venue_flat_snapshot'
      or p.side is null or p.side::text not in ('long','short') then continue; end if;
    flat_at:=(p.strategy_metadata#>>'{closure_evidence,observed_at}')::timestamptz;
    snapshot_at:=(p.strategy_metadata#>>'{reconciliation,at}')::timestamptz;
    if p.opened_at is null or flat_at is null or snapshot_at is null or snapshot_at<p.opened_at
      or snapshot_at>=flat_at or flat_at>now()-interval '5 minutes' then continue; end if;
    select o.evidence into h from public.apex_closed_pnl_observations o
      where o.position_id=p.id and o.user_id=p.user_id and o.connection_id=p.connection_id;
    if h->>'status' is distinct from 'observed' or jsonb_typeof(h->'rows') is distinct from 'array'
      or h->>'begin' is null or h->>'end' is null
      or (h->>'begin')::numeric>extract(epoch from p.opened_at)*1000
      or (h->>'end')::numeric<extract(epoch from flat_at)*1000 then continue; end if;
    if exists(select 1 from jsonb_array_elements(h->'rows') x where x->>'createdAt' is null
      or x->>'symbol' is null or x->>'type' is null) then continue; end if;
    select count(*),jsonb_agg(x)->0 into history_count,candidate from jsonb_array_elements(h->'rows') x
      where (x->>'createdAt')::numeric>=extract(epoch from p.opened_at)*1000
        and (x->>'createdAt')::numeric<=extract(epoch from flat_at)*1000;
    if history_count<>1 then
      results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status','PARTIAL_OR_AMBIGUOUS_HISTORY'));continue;
    end if;
    qty:=(candidate->>'size')::numeric;entry:=(candidate->>'price')::numeric;
    exit_price:=(candidate->>'exitPrice')::numeric;pnl:=(candidate->>'totalPnl')::numeric;
    exit_at:=to_timestamp((candidate->>'createdAt')::double precision/1000);
    if candidate->>'symbol' is distinct from p.pair or candidate->>'type' is distinct from 'CLOSE_POSITION'
      or candidate->'isLiquidate' is distinct from 'false'::jsonb or candidate->'isDeleverage' is distinct from 'false'::jsonb
      or qty is null or entry is null or exit_price is null or pnl is null
      or qty::text in ('NaN','Infinity','-Infinity') or entry::text in ('NaN','Infinity','-Infinity')
      or exit_price::text in ('NaN','Infinity','-Infinity') or pnl::text in ('NaN','Infinity','-Infinity')
      or qty<=0 or entry<=0 or exit_price<=0 or p.size is null or p.entry_price is null
      or abs(qty-p.size)>0.000000001 or abs(entry-p.entry_price)>0.000001
      or exit_at<=snapshot_at or exit_at>flat_at then
      results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status','VENUE_PNL_POSITION_MISMATCH'));continue;
    end if;
    if exists(select 1 from public.positions q where q.id<>p.id and q.user_id=p.user_id
      and q.connection_id=p.connection_id and q.source='live' and q.pair=p.pair
      and q.opened_at<flat_at and (q.status='open' or q.updated_at>p.opened_at)) then
      results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status','POSITION_OVERLAP'));continue;
    end if;
    select sum(f.size),sum(f.size*f.price),array_agg(f.id order by f.id)
      into fill_qty,fill_value,fill_ids from public.live_fills f
      where f.user_id=p.user_id and f.connection_id=p.connection_id and f.venue='apex_omni' and f.symbol=p.pair
        and f.side=case when p.side::text='long' then 'SELL' else 'BUY' end
        and f.fill_ts between exit_at-interval '1 second' and exit_at+interval '1 second';
    if fill_qty is null or fill_value is null or fill_qty::text in ('NaN','Infinity','-Infinity')
      or fill_value::text in ('NaN','Infinity','-Infinity')
      or abs(fill_qty-qty)>0.000000001 or abs(fill_value/qty-exit_price)>0.000001 then
      results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status','EXIT_FILL_MISMATCH'));continue;
    end if;
    v_event_key:=encode(sha256(convert_to(candidate::text,'UTF8')),'hex');
    if exists(select 1 from public.apex_pnl_event_links where connection_id=p.connection_id and event_key=v_event_key) then
      results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status','EVENT_ALREADY_SETTLED'));continue;
    end if;
    evidence:=jsonb_build_object('source','apex_historical_pnl_v1','pnl_basis','venue_reported_closing_pnl',
      'fee_breakdown_verified',false,'funding_included',null,'realized_pnl_verified',true,
      'venue_event',candidate,'event_key',v_event_key,'exit_fill_ids',fill_ids,
      'last_open_observed_at',snapshot_at,'flat_observed_at',flat_at);
    if p_apply then
      insert into public.live_position_pnl_settlements(position_id,user_id,connection_id,realized_pnl,fees_usd,
        trade_ids,fill_ids,before_image,evidence) values(p.id,p.user_id,p.connection_id,pnl,null,'{}',fill_ids,to_jsonb(p),evidence);
      insert into public.apex_pnl_event_links values(p.connection_id,v_event_key,p.id);
      update public.positions set pnl_amount=pnl,
        strategy_metadata=jsonb_set(coalesce(strategy_metadata,'{}'::jsonb),'{closure_evidence,realized_pnl_verified}','true'::jsonb)
          ||jsonb_build_object('realized_pnl_evidence',evidence) where id=p.id;
    end if;
    results:=results||jsonb_build_array(jsonb_build_object('position_id',p.id,'status',case when p_apply then 'SETTLED' else 'VERIFIED_DRY_RUN' end,'realized_pnl',pnl));
  end loop;
  return jsonb_build_object('applied',p_apply,'results',results);
end;
$$;
revoke all on function public.reconcile_apex_reported_pnl(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_apex_reported_pnl(uuid,uuid,boolean) to service_role;
