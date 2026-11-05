-- Restore the live fee evidence column expected by the application and
-- generated database types. Older production projects can have the live
-- trades ledger without the later venue-fill enrichment migration.
--
-- This is intentionally additive and replay-safe: existing realized P&L is
-- not rewritten, and historical rows are marked with zero recorded fees
-- rather than an inferred amount.

alter table public.trades
  add column if not exists fees_usd numeric(20,8) not null default 0;

comment on column public.trades.fees_usd is
  'Venue-recorded fees attributed to the closed live trade; never estimated by the UI.';
