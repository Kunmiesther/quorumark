alter table public.trades
add column if not exists evidence_verified boolean not null default false,
add column if not exists evidence_source text,
add column if not exists evidence_verified_at timestamptz;

alter table public.trades
drop constraint if exists trades_verified_evidence_has_provenance;

alter table public.trades
add constraint trades_verified_evidence_has_provenance
check (
  not evidence_verified
  or (evidence_source is not null and evidence_verified_at is not null)
);

drop policy if exists "Users manage own trades" on public.trades;
drop policy if exists "Users view own trades" on public.trades;
create policy "Users view own trades"
on public.trades for select
to authenticated
using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.trades from authenticated;
grant select on public.trades to authenticated;

create index if not exists trades_verified_paper_validation_idx
on public.trades (user_id, strategy_id, closed_at)
where book = 'paper' and evidence_verified = true;

comment on column public.trades.evidence_verified is
'True only for trade evidence written or reconciled by a trusted server process. Client-authored and historical rows remain false.';
