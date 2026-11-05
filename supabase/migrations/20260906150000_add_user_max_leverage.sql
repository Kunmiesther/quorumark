alter table public.user_trading_limits
add column if not exists max_leverage smallint not null default 5
check (max_leverage between 1 and 100);

comment on column public.user_trading_limits.max_leverage is
'Owner-configured leverage ceiling enforced before live order submission.';
