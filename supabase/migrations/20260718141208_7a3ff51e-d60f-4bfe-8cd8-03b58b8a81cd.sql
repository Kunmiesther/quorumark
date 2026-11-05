UPDATE public.user_strategy us
SET params = COALESCE(us.params, '{}'::jsonb) || jsonb_build_object(
  'spec_version', 'v1',
  'ratified', true,
  'sizing', jsonb_build_object(
    'model', 'inverse_leverage',
    'notional_constant', 10,
    'margin_fraction_formula', '10 / leverage',
    'cap', 'position_margin <= account_capital'
  ),
  'capital', jsonb_build_object(
    'max_usd', 500,
    'floor_usd', 100,
    'variable', true
  ),
  'canary', jsonb_build_object(
    'allocation_usd', 30,
    'note', 'capital baseline, not margin; at 100x -> $3 margin, $300 notional'
  )
)
FROM public.strategies s
WHERE us.strategy_id = s.id AND s.slug = 'dca';