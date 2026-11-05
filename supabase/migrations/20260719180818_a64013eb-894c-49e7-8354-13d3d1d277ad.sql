UPDATE public.paper_positions
SET tp_level = CASE
  WHEN direction = 'long'  THEN entry_price + (entry_price - stop_level)
  WHEN direction = 'short' THEN entry_price - (stop_level - entry_price)
END
WHERE status = 'open' AND tp_level IS NULL;