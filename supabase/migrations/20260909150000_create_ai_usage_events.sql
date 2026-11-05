-- Private, append-only metering for TurtleBot's server-side AI calls.
-- Prompts, responses, credentials, and provider headers are intentionally absent.
create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references auth.users(id) on delete set null,
  feature text not null check (char_length(feature) between 1 and 64),
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 160),
  status text not null check (status in ('success', 'error', 'timeout')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  estimated_cost_usd numeric(14, 8) not null default 0 check (estimated_cost_usd >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  pricing_source text not null default 'unpriced',
  created_at timestamptz not null default now()
);

comment on table public.ai_usage_events is
  'Private server-side AI token, latency, status, and estimated-cost telemetry. Contains no prompt or response content.';
comment on column public.ai_usage_events.estimated_cost_usd is
  'Estimate from provider-reported tokens and the versioned app price registry; provider invoices are authoritative.';

create index if not exists ai_usage_events_created_at_idx
  on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_provider_model_created_idx
  on public.ai_usage_events (provider, model, created_at desc);
create index if not exists ai_usage_events_feature_created_idx
  on public.ai_usage_events (feature, created_at desc);

alter table public.ai_usage_events enable row level security;
alter table public.ai_usage_events force row level security;

revoke all on table public.ai_usage_events from public, anon, authenticated;
grant all on table public.ai_usage_events to service_role;

