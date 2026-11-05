-- The lease ledger is an internal implementation detail. Keep it behind RLS
-- with no client policy/grant; the ownership-checking RPC is the only public
-- entry point.
alter table public.paper_tick_leases enable row level security;
revoke all on public.paper_tick_leases from public, anon, authenticated;
grant all on public.paper_tick_leases to service_role;

create index if not exists paper_rung_fills_user_idx
  on public.paper_rung_fills (user_id);
