-- The catalog table and read policy were created without catalog rows.
-- Seed only missing canonical strategies so the Dashboard can present real
-- strategy UUIDs to user_strategy. Existing production rows remain untouched.
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
values
  (
    'dca',
    'DCA',
    'The Arbiter',
    'Command-floor balance armor',
    'futures',
    'low',
    'Patient accumulation',
    '#06B6D4',
    '/turtles/arbiter.png',
    'Risk evaluation, balance, and patient position building through ranging markets.',
    0
  ),
  (
    'break-retest',
    'Break and Retest',
    'The Vanguard',
    'Volcanic frontline armor',
    'futures',
    'medium',
    'Disciplined momentum',
    '#F2542D',
    '/turtles/vanguard.png',
    'Frontline momentum strategy for confirmed breakouts and structured retests.',
    1
  ),
  (
    'rsi-divergence',
    'Reversal',
    'The Sniper',
    'Precision targeting armor',
    'futures',
    'medium',
    'Selective precision',
    '#C026D3',
    '/turtles/sniper.png',
    'Precision reversal strategy for validated exhaustion and liquidity zones.',
    2
  ),
  (
    'ema-cross',
    'Trend Recon',
    'The Scout',
    'Storm reconnaissance armor',
    'futures',
    'medium',
    'Early detection',
    '#5EEAD4',
    '/turtles/scout.png',
    'Market reconnaissance strategy for early, confirmed trend shifts.',
    3
  ),
  (
    'liq-hunting',
    'Liquidity Hunting',
    'The Hunter',
    'Desert tracking armor',
    'futures',
    'high',
    'Adaptive opportunity tracking',
    '#B87333',
    '/turtles/hunter.png',
    'Volatility strategy for validated liquidity expansions and displacement.',
    4
  )
on conflict (slug) do nothing;

-- Keep the table available through the Data API while RLS remains enabled.
grant select on table public.strategies to anon, authenticated;
