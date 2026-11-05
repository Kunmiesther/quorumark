-- Restore the six-Turtle catalog. DCA belongs to The Accumulator; The
-- Arbiter is the separate market-neutral funding/spread strategy.
update public.strategies
set
  suit_name = 'The Accumulator',
  suit_design = 'Deep-vault accumulation armor',
  trait = 'Patient accumulation',
  ring_color = '#2DD4BF',
  suit_image = '/assets/accumulator-alpha.webp',
  description = 'Patient DCA and position building through ranging and accumulation phases.'
where slug = 'dca';

insert into public.strategies (
  slug,
  name,
  suit_name,
  suit_design,
  markets,
  risk,
  trait,
  ring_color,
  suit_image,
  description,
  sort_order
)
values (
  'funding-arb',
  'Funding Arbitrage',
  'The Arbiter',
  'Command-floor balance armor',
  'futures',
  'low',
  'Market-neutral balance',
  '#60A5FA',
  '/assets/arbiter-alpha.webp',
  'Market-neutral funding and spread strategy for validated cross-venue dislocations.',
  5
)
on conflict (slug) do update
set
  name = excluded.name,
  suit_name = excluded.suit_name,
  suit_design = excluded.suit_design,
  markets = excluded.markets,
  risk = excluded.risk,
  trait = excluded.trait,
  ring_color = excluded.ring_color,
  suit_image = excluded.suit_image,
  description = excluded.description,
  sort_order = excluded.sort_order;
