UPDATE public.positions
SET strategy_metadata = coalesce(strategy_metadata, '{}'::jsonb) || jsonb_build_object('origin', 'venue_external')
WHERE status = 'open'
  AND source = 'live'
  AND (strategy_metadata->>'origin') IS NULL;